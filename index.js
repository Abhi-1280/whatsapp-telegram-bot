const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { Telegraf } = require('telegraf');
const express = require('express');
const { Storage } = require('megajs');
const fs = require('fs').promises;
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const archiver = require('archiver');
const unzipper = require('unzipper');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const WHATSAPP_GROUP_NAME = process.env.WHATSAPP_GROUP_NAME;
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const app = express();
let whatsappClient;
let isReady = false;
let whatsappGroupId = null;
let megaStorage;
let activeDownloads = new Map();

const AXIOS_INSTANCE = axios.create({
    timeout: 30000,
    maxContentLength: 100 * 1024 * 1024,
    maxBodyLength: 100 * 1024 * 1024
});

const initMega = async () => {
    try {
        megaStorage = new Storage({
            email: MEGA_EMAIL,
            password: MEGA_PASSWORD,
            autologin: true,
            autoload: true
        });
        await megaStorage.ready;
        console.log('Mega connected');
        return true;
    } catch (error) {
        console.error('Mega error:', error);
        return false;
    }
};

const downloadSessionFromMega = async () => {
    try {
        if (!megaStorage) return false;
        
        const files = await megaStorage.root.children;
        const sessionFile = files.find(file => file.name === 'wa-session.zip');
        
        if (sessionFile) {
            const buffer = await sessionFile.downloadBuffer();
            await fs.writeFile('./wa-session.zip', buffer);
            
            await fs.createReadStream('./wa-session.zip')
                .pipe(unzipper.Extract({ path: './' }))
                .promise();
            
            await fs.unlink('./wa-session.zip');
            console.log('Session restored');
            return true;
        }
        return false;
    } catch (error) {
        console.error('Session restore error:', error);
        return false;
    }
};

const uploadSessionToMega = async () => {
    try {
        if (!megaStorage) return;
        
        const output = require('fs').createWriteStream('./wa-session.zip');
        const archive = archiver('zip', { zlib: { level: 1 } });
        
        output.on('close', async () => {
            const buffer = await fs.readFile('./wa-session.zip');
            const files = await megaStorage.root.children;
            const existing = files.find(file => file.name === 'wa-session.zip');
            
            if (existing) await existing.delete();
            
            await megaStorage.root.upload('wa-session.zip', buffer);
            await fs.unlink('./wa-session.zip');
            console.log('Session backed up');
        });
        
        archive.pipe(output);
        archive.directory('./.wwebjs_auth/', false);
        await archive.finalize();
    } catch (error) {
        console.error('Backup error:', error);
    }
};

const downloadFile = async (fileId, fileInfo) => {
    const cacheKey = fileId;
    
    if (activeDownloads.has(cacheKey)) {
        return activeDownloads.get(cacheKey);
    }
    
    const downloadPromise = (async () => {
        try {
            const file = await bot.telegram.getFile(fileId);
            const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
            
            const response = await AXIOS_INSTANCE.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'Connection': 'keep-alive'
                }
            });
            
            const buffer = Buffer.from(response.data);
            activeDownloads.delete(cacheKey);
            return buffer;
        } catch (error) {
            activeDownloads.delete(cacheKey);
            throw error;
        }
    })();
    
    activeDownloads.set(cacheKey, downloadPromise);
    return downloadPromise;
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
                '--disable-gpu',
                '--disable-software-rasterizer'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log('QR received');
        qrcode.generate(qr, { small: true });
        bot.telegram.sendMessage(ADMIN_ID, `📱 Scan QR:\n\n${qr}`);
    });

    whatsappClient.on('ready', async () => {
        console.log('WhatsApp ready');
        isReady = true;
        
        const chats = await whatsappClient.getChats();
        const group = chats.find(chat => 
            chat.isGroup && chat.name.toLowerCase().includes(WHATSAPP_GROUP_NAME.toLowerCase())
        );
        
        if (group) {
            whatsappGroupId = group.id._serialized;
            console.log(`Group found: ${group.name}`);
            bot.telegram.sendMessage(ADMIN_ID, `✅ Ready!\nGroup: ${group.name}\n⚡ Ultra-fast mode active`);
        } else {
            bot.telegram.sendMessage(ADMIN_ID, `❌ Group "${WHATSAPP_GROUP_NAME}" not found`);
        }
        
        setTimeout(uploadSessionToMega, 5000);
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('Disconnected:', reason);
        isReady = false;
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ Disconnected: ${reason}`);
        setTimeout(() => whatsappClient.initialize(), 3000);
    });

    whatsappClient.initialize();
};

const sendToWhatsApp = async (content, options = {}) => {
    if (!isReady || !whatsappGroupId) {
        throw new Error('Not ready');
    }
    
    try {
        await whatsappClient.sendMessage(whatsappGroupId, content, options);
    } catch (error) {
        console.error('Send error:', error);
        throw error;
    }
};

bot.on('channel_post', async (ctx) => {
    const startTime = Date.now();
    
    try {
        const post = ctx.channelPost;
        const caption = post.text || post.caption || '';
        
        if (post.photo) {
            const photo = post.photo[post.photo.length - 1];
            downloadFile(photo.file_id, { type: 'photo' }).then(async buffer => {
                const media = new MessageMedia('image/jpeg', buffer.toString('base64'));
                await sendToWhatsApp(media, { caption });
                console.log(`Photo forwarded in ${Date.now() - startTime}ms`);
            }).catch(console.error);
            
        } else if (post.video) {
            downloadFile(post.video.file_id, { type: 'video' }).then(async buffer => {
                const media = new MessageMedia('video/mp4', buffer.toString('base64'));
                await sendToWhatsApp(media, { caption });
                console.log(`Video forwarded in ${Date.now() - startTime}ms`);
            }).catch(console.error);
            
        } else if (post.document) {
            downloadFile(post.document.file_id, { type: 'document' }).then(async buffer => {
                const media = new MessageMedia(
                    post.document.mime_type || 'application/octet-stream',
                    buffer.toString('base64'),
                    post.document.file_name
                );
                await sendToWhatsApp(media, { caption });
                console.log(`Document forwarded in ${Date.now() - startTime}ms`);
            }).catch(console.error);
            
        } else if (caption) {
            await sendToWhatsApp(caption);
            console.log(`Text forwarded in ${Date.now() - startTime}ms`);
        }
        
    } catch (error) {
        console.error('Forward error:', error);
        bot.telegram.sendMessage(ADMIN_ID, `❌ Error: ${error.message}`);
    }
});

bot.on('edited_channel_post', async (ctx) => {
    console.log('Edited post ignored');
});

bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    await ctx.reply(`
⚡ Ultra-Fast Forwarder Status:
├ WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}
├ Group: ${whatsappGroupId ? '✅ Ready' : '❌ Not found'}
├ Active Downloads: ${activeDownloads.size}
├ Uptime: ${hours}h ${minutes}m
└ Mode: Lightning Fast ⚡
    `);
});

bot.command('restart', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply('⚡ Quick restart...');
    if (whatsappClient) await whatsappClient.destroy();
    setTimeout(initWhatsApp, 1000);
});

bot.command('test', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const start = Date.now();
    try {
        await sendToWhatsApp('⚡ Speed test message');
        await ctx.reply(`✅ Test successful! Latency: ${Date.now() - start}ms`);
    } catch (error) {
        await ctx.reply(`❌ Test failed: ${error.message}`);
    }
});

app.get('/', (req, res) => {
    res.json({
        status: 'running',
        ready: isReady,
        uptime: Math.floor(process.uptime()),
        mode: 'ultra-fast'
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const keepAlive = () => {
    setInterval(async () => {
        try {
            const url = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;
            if (url.includes('localhost')) return;
            
            await axios.get(url + '/health', { timeout: 5000 });
        } catch (error) {}
    }, 4 * 60 * 1000);
};

const start = async () => {
    console.log('Starting Ultra-Fast Forwarder...');
    
    await initMega();
    const sessionRestored = await downloadSessionFromMega();
    
    if (sessionRestored) {
        console.log('Using existing session');
    }
    
    await initWhatsApp();
    
    bot.telegram.setWebhook('');
    await bot.launch({
        allowedUpdates: ['channel_post', 'message']
    });
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
    
    keepAlive();
    
    bot.telegram.sendMessage(ADMIN_ID, '⚡ Ultra-Fast Forwarder Started!\n\nOptimized for instant deal forwarding.');
};

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    if (whatsappClient) whatsappClient.destroy();
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    if (whatsappClient) whatsappClient.destroy();
});

start().catch(console.error);
