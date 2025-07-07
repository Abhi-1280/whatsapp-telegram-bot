const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { Telegraf } = require('telegraf');
const express = require('express');
const { Storage } = require('megajs');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const archiver = require('archiver');
const unzipper = require('unzipper');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const WHATSAPP_GROUP_NAME = process.env.WHATSAPP_GROUP_NAME || process.env.WHATSAPP_group_NAME;
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const app = express();
let whatsappClient;
let isReady = false;
let whatsappGroupId = null;
let megaStorage;
let messageQueue = [];
let isProcessing = false;

const AXIOS_INSTANCE = axios.create({
    timeout: 30000,
    maxContentLength: 100 * 1024 * 1024,
    maxBodyLength: 100 * 1024 * 1024,
    headers: {
        'Connection': 'keep-alive'
    }
});

const ensureDirectoryExists = async (dirPath) => {
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
    } catch (error) {
        console.error('Error creating directory:', error);
    }
};

const initMega = async () => {
    try {
        megaStorage = new Storage({
            email: MEGA_EMAIL,
            password: MEGA_PASSWORD
        });
        await megaStorage.ready;
        console.log('Mega storage connected');
        return true;
    } catch (error) {
        console.error('Mega connection failed:', error);
        return false;
    }
};

const downloadSessionFromMega = async () => {
    try {
        if (!megaStorage) return false;
        
        await ensureDirectoryExists('./.wwebjs_auth');
        
        const files = await megaStorage.root.children;
        const sessionFile = files.find(file => file.name === 'wa-session.zip');
        
        if (sessionFile) {
            console.log('Found session in Mega, downloading...');
            const buffer = await sessionFile.downloadBuffer();
            await fsPromises.writeFile('./wa-session.zip', buffer);
            
            await new Promise((resolve, reject) => {
                fs.createReadStream('./wa-session.zip')
                    .pipe(unzipper.Extract({ path: './' }))
                    .on('close', resolve)
                    .on('error', reject);
            });
            
            await fsPromises.unlink('./wa-session.zip').catch(() => {});
            console.log('Session restored from Mega');
            return true;
        }
        console.log('No session found in Mega');
        return false;
    } catch (error) {
        console.error('Session download error:', error);
        return false;
    }
};

const uploadSessionToMega = async () => {
    try {
        if (!megaStorage) return;
        
        const sessionPath = './.wwebjs_auth';
        if (!fs.existsSync(sessionPath)) {
            console.log('No session to backup');
            return;
        }
        
        const output = fs.createWriteStream('./wa-session.zip');
        const archive = archiver('zip', { zlib: { level: 1 } });
        
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);
            
            archive.pipe(output);
            archive.directory(sessionPath, false);
            archive.finalize();
        });
        
        const buffer = await fsPromises.readFile('./wa-session.zip');
        const files = await megaStorage.root.children;
        const existing = files.find(file => file.name === 'wa-session.zip');
        
        if (existing) {
            await existing.delete();
        }
        
        await megaStorage.root.upload('wa-session.zip', buffer);
        await fsPromises.unlink('./wa-session.zip').catch(() => {});
        console.log('Session backed up to Mega');
    } catch (error) {
        console.error('Session upload error:', error);
    }
};

const initWhatsApp = async () => {
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: "fast-forwarder",
            dataPath: "./.wwebjs_auth"
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            timeout: 60000
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log('QR Code received');
        qrcode.generate(qr, { small: true });
        bot.telegram.sendMessage(ADMIN_ID, `📱 Please scan this QR code to login WhatsApp Web`);
    });

    whatsappClient.on('authenticated', () => {
        console.log('WhatsApp authenticated successfully');
        setTimeout(() => uploadSessionToMega(), 10000);
    });

    whatsappClient.on('ready', async () => {
        console.log('WhatsApp client is ready');
        isReady = true;
        
        try {
            const chats = await whatsappClient.getChats();
            const targetGroup = chats.find(chat => 
                chat.isGroup && chat.name.toLowerCase().includes(WHATSAPP_GROUP_NAME.toLowerCase())
            );
            
            if (targetGroup) {
                whatsappGroupId = targetGroup.id._serialized;
                console.log(`Found WhatsApp group: ${targetGroup.name}`);
                bot.telegram.sendMessage(ADMIN_ID, 
                    `✅ Bot is ready!\n` +
                    `📱 WhatsApp: Connected\n` +
                    `👥 Group: ${targetGroup.name}\n` +
                    `⚡ Mode: Ultra-fast forwarding active`
                );
                
                processQueue();
            } else {
                bot.telegram.sendMessage(ADMIN_ID, 
                    `❌ Group "${WHATSAPP_GROUP_NAME}" not found\n` +
                    `Available groups:\n${chats.filter(c => c.isGroup).map(c => c.name).join('\n')}`
                );
            }
        } catch (error) {
            console.error('Error finding group:', error);
            bot.telegram.sendMessage(ADMIN_ID, `❌ Error: ${error.message}`);
        }
    });

    whatsappClient.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        bot.telegram.sendMessage(ADMIN_ID, `❌ WhatsApp authentication failed. Please restart and scan QR again.`);
    });

    whatsappClient.on('disconnected', async (reason) => {
        console.log('WhatsApp disconnected:', reason);
        isReady = false;
        whatsappGroupId = null;
        
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ WhatsApp disconnected: ${reason}\nReconnecting...`);
        
        await whatsappClient.destroy();
        setTimeout(() => initWhatsApp(), 5000);
    });

    whatsappClient.initialize();
};

const processQueue = async () => {
    if (isProcessing || messageQueue.length === 0 || !isReady || !whatsappGroupId) return;
    
    isProcessing = true;
    
    while (messageQueue.length > 0 && isReady) {
        const message = messageQueue.shift();
        try {
            await whatsappClient.sendMessage(whatsappGroupId, message.content, message.options);
            console.log(`Message sent in ${Date.now() - message.timestamp}ms`);
        } catch (error) {
            console.error('Error sending message:', error);
            if (error.message.includes('not found') || error.message.includes('not authorized')) {
                bot.telegram.sendMessage(ADMIN_ID, `❌ Cannot send to group. Make sure the bot number is admin in the group.`);
            }
        }
        
        if (messageQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    isProcessing = false;
};

const downloadFile = async (fileId) => {
    try {
        const file = await bot.telegram.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        
        const response = await AXIOS_INSTANCE.get(url, {
            responseType: 'arraybuffer'
        });
        
        return Buffer.from(response.data);
    } catch (error) {
        console.error('File download error:', error);
        throw error;
    }
};

bot.on('channel_post', async (ctx) => {
    const timestamp = Date.now();
    
    try {
        const post = ctx.channelPost;
        const caption = post.text || post.caption || '';
        
        if (!isReady || !whatsappGroupId) {
            messageQueue.push({
                content: caption || 'Forwarded message',
                options: {},
                timestamp,
                post
            });
            console.log('Message queued (bot not ready)');
            return;
        }
        
        if (post.photo) {
            const photo = post.photo[post.photo.length - 1];
            downloadFile(photo.file_id).then(async buffer => {
                const media = new MessageMedia('image/jpeg', buffer.toString('base64'));
                if (isReady && whatsappGroupId) {
                    await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
                    console.log(`Photo sent in ${Date.now() - timestamp}ms`);
                } else {
                    messageQueue.push({ content: media, options: { caption }, timestamp });
                }
            }).catch(error => {
                console.error('Photo processing error:', error);
            });
            
        } else if (post.video) {
            downloadFile(post.video.file_id).then(async buffer => {
                const media = new MessageMedia('video/mp4', buffer.toString('base64'));
                if (isReady && whatsappGroupId) {
                    await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
                    console.log(`Video sent in ${Date.now() - timestamp}ms`);
                } else {
                    messageQueue.push({ content: media, options: { caption }, timestamp });
                }
            }).catch(error => {
                console.error('Video processing error:', error);
            });
            
        } else if (post.document) {
            downloadFile(post.document.file_id).then(async buffer => {
                const media = new MessageMedia(
                    post.document.mime_type || 'application/octet-stream',
                    buffer.toString('base64'),
                    post.document.file_name
                );
                if (isReady && whatsappGroupId) {
                    await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
                    console.log(`Document sent in ${Date.now() - timestamp}ms`);
                } else {
                    messageQueue.push({ content: media, options: { caption }, timestamp });
                }
            }).catch(error => {
                console.error('Document processing error:', error);
            });
            
        } else if (caption) {
            if (isReady && whatsappGroupId) {
                await whatsappClient.sendMessage(whatsappGroupId, caption);
                console.log(`Text sent in ${Date.now() - timestamp}ms`);
            } else {
                messageQueue.push({ content: caption, options: {}, timestamp });
            }
        }
        
    } catch (error) {
        console.error('Message handling error:', error);
    }
});

bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    await ctx.reply(
        `⚡ *Ultra-Fast Forwarder Status*\n\n` +
        `📱 WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}\n` +
        `👥 Group: ${whatsappGroupId ? '✅ Found' : '❌ Not found'}\n` +
        `📨 Queue: ${messageQueue.length} messages\n` +
        `⏱️ Uptime: ${hours}h ${minutes}m\n` +
        `🚀 Mode: Lightning Fast`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('restart', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply('♻️ Restarting WhatsApp client...');
    isReady = false;
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    setTimeout(() => initWhatsApp(), 2000);
});

bot.command('backup', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply('💾 Backing up session to Mega...');
    await uploadSessionToMega();
    await ctx.reply('✅ Backup completed');
});

app.get('/', (req, res) => {
    res.json({
        status: 'running',
        whatsapp: isReady,
        group: whatsappGroupId ? 'found' : 'not_found',
        queue: messageQueue.length,
        uptime: Math.floor(process.uptime())
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const keepAlive = () => {
    setInterval(async () => {
        try {
            const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
            if (!url.includes('localhost')) {
                await axios.get(url + '/health', { timeout: 5000 });
            }
        } catch (error) {}
    }, 4 * 60 * 1000);
};

const start = async () => {
    console.log('Starting Ultra-Fast WhatsApp Forwarder...');
    
    const megaConnected = await initMega();
    if (megaConnected) {
        const sessionRestored = await downloadSessionFromMega();
        console.log(`Session restore: ${sessionRestored ? 'Success' : 'Failed/Not found'}`);
    }
    
    await initWhatsApp();
    
    await bot.launch();
    console.log('Telegram bot started');
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Express server running on port ${PORT}`);
    });
    
    keepAlive();
    
    if (ADMIN_ID) {
        bot.telegram.sendMessage(ADMIN_ID, 
            '🚀 *Ultra-Fast Forwarder Started!*\n\n' +
            '⚡ Optimized for instant message forwarding\n' +
            '💾 Session auto-backup enabled\n' +
            '📱 Waiting for WhatsApp connection...',
            { parse_mode: 'Markdown' }
        );
    }
};

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    if (whatsappClient) whatsappClient.destroy();
    process.exit(0);
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    if (whatsappClient) whatsappClient.destroy();
    process.exit(0);
});

start().catch(error => {
    console.error('Failed to start bot:', error);
    if (ADMIN_ID) {
        bot.telegram.sendMessage(ADMIN_ID, `❌ Bot failed to start: ${error.message}`);
    }
});
