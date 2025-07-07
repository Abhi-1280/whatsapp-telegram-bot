const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { Telegraf } = require('telegraf');
const express = require('express');
const { Storage } = require('megajs');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const archiver = require('archiver');
const unzipper = require('unzipper');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const WHATSAPP_GROUP_NAME = 'savings safari'; // Hardcoded group name
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const PORT = process.env.PORT || 3000;

// Initialize Express immediately
const app = express();
app.use(express.json());

// Start server first for Render
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

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// Initialize variables
const bot = new Telegraf(BOT_TOKEN);
let whatsappClient;
let isReady = false;
let whatsappGroupId = null;
let megaStorage;
let messageQueue = [];
let isProcessing = false;

const AXIOS_INSTANCE = axios.create({
    timeout: 30000,
    maxContentLength: 100 * 1024 * 1024,
    maxBodyLength: 100 * 1024 * 1024
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
            password: MEGA_PASSWORD,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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
            console.log('Downloading session from Mega...');
            const buffer = await sessionFile.downloadBuffer();
            await fsPromises.writeFile('./wa-session.zip', buffer);
            
            await new Promise((resolve, reject) => {
                fs.createReadStream('./wa-session.zip')
                    .pipe(unzipper.Extract({ path: './' }))
                    .on('close', resolve)
                    .on('error', reject);
            });
            
            await fsPromises.unlink('./wa-session.zip').catch(() => {});
            console.log('Session restored successfully');
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
        console.error('Backup error:', error);
    }
};

const initWhatsApp = async () => {
    console.log('Initializing WhatsApp...');
    
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: "bot-client"
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
            ]
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log('QR RECEIVED - Scan this code:');
        qrcode.generate(qr, { small: true });
        if (ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, '📱 Please scan the QR code in the console logs');
        }
    });

    whatsappClient.on('authenticated', () => {
        console.log('Authenticated!');
        setTimeout(uploadSessionToMega, 10000);
    });

    whatsappClient.on('ready', async () => {
        console.log('WhatsApp is ready!');
        isReady = true;
        
        try {
            const chats = await whatsappClient.getChats();
            const group = chats.find(chat => 
                chat.isGroup && chat.name.toLowerCase() === WHATSAPP_GROUP_NAME.toLowerCase()
            );
            
            if (group) {
                whatsappGroupId = group.id._serialized;
                console.log(`Found group: ${group.name}`);
                
                if (ADMIN_ID) {
                    await bot.telegram.sendMessage(ADMIN_ID, 
                        `✅ Bot Ready!\n` +
                        `📱 WhatsApp: Connected\n` +
                        `👥 Group: ${group.name}\n` +
                        `📨 Queue: ${messageQueue.length} messages`
                    );
                }
                
                // Process queued messages
                processQueue();
            } else {
                console.log(`Group "${WHATSAPP_GROUP_NAME}" not found`);
                if (ADMIN_ID) {
                    const groupList = chats
                        .filter(c => c.isGroup)
                        .map(c => c.name)
                        .slice(0, 10)
                        .join('\n');
                    
                    await bot.telegram.sendMessage(ADMIN_ID, 
                        `❌ Group "${WHATSAPP_GROUP_NAME}" not found\n\n` +
                        `Available groups:\n${groupList}`
                    );
                }
            }
        } catch (error) {
            console.error('Error in ready event:', error);
        }
    });

    whatsappClient.on('auth_failure', (msg) => {
        console.error('Auth failed:', msg);
        if (ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, '❌ Authentication failed!');
        }
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('Disconnected:', reason);
        isReady = false;
        if (ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, `⚠️ Disconnected: ${reason}`);
        }
        setTimeout(initWhatsApp, 5000);
    });

    whatsappClient.initialize();
};

const processQueue = async () => {
    if (isProcessing || messageQueue.length === 0 || !isReady || !whatsappGroupId) return;
    
    isProcessing = true;
    
    while (messageQueue.length > 0 && isReady) {
        const msg = messageQueue.shift();
        try {
            if (msg.media) {
                await whatsappClient.sendMessage(whatsappGroupId, msg.media, { caption: msg.caption });
            } else {
                await whatsappClient.sendMessage(whatsappGroupId, msg.text);
            }
            console.log(`Sent queued message (${Date.now() - msg.timestamp}ms old)`);
        } catch (error) {
            console.error('Queue send error:', error);
        }
        await new Promise(r => setTimeout(r, 100));
    }
    
    isProcessing = false;
};

const downloadFile = async (fileId) => {
    try {
        const file = await bot.telegram.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        const response = await AXIOS_INSTANCE.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (error) {
        console.error('Download error:', error);
        throw error;
    }
};

bot.on('channel_post', async (ctx) => {
    const timestamp = Date.now();
    const post = ctx.channelPost;
    const caption = post.text || post.caption || '';
    
    try {
        if (!isReady || !whatsappGroupId) {
            // Queue the message
            if (post.photo) {
                messageQueue.push({ 
                    text: `[Photo queued] ${caption}`, 
                    timestamp,
                    type: 'photo',
                    fileId: post.photo[post.photo.length - 1].file_id,
                    caption
                });
            } else if (post.video) {
                messageQueue.push({ 
                    text: `[Video queued] ${caption}`, 
                    timestamp,
                    type: 'video',
                    fileId: post.video.file_id,
                    caption
                });
            } else if (caption) {
                messageQueue.push({ text: caption, timestamp });
            }
            console.log('Message queued (bot not ready)');
            return;
        }
        
        // Send directly
        if (post.photo) {
            const buffer = await downloadFile(post.photo[post.photo.length - 1].file_id);
            const media = new MessageMedia('image/jpeg', buffer.toString('base64'));
            await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
            console.log(`Photo sent in ${Date.now() - timestamp}ms`);
        } else if (post.video) {
            const buffer = await downloadFile(post.video.file_id);
            const media = new MessageMedia('video/mp4', buffer.toString('base64'));
            await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
            console.log(`Video sent in ${Date.now() - timestamp}ms`);
        } else if (post.document) {
            const buffer = await downloadFile(post.document.file_id);
            const media = new MessageMedia(
                post.document.mime_type || 'application/octet-stream',
                buffer.toString('base64'),
                post.document.file_name
            );
            await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
            console.log(`Document sent in ${Date.now() - timestamp}ms`);
        } else if (caption) {
            await whatsappClient.sendMessage(whatsappGroupId, caption);
            console.log(`Text sent in ${Date.now() - timestamp}ms`);
        }
    } catch (error) {
        console.error('Send error:', error);
    }
});

bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply(
        `📊 Status:\n` +
        `WhatsApp: ${isReady ? '✅' : '❌'}\n` +
        `Group: ${whatsappGroupId ? '✅' : '❌'}\n` +
        `Queue: ${messageQueue.length}\n` +
        `Server: ✅ Port ${PORT}`
    );
});

bot.command('restart', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    await ctx.reply('Restarting...');
    if (whatsappClient) await whatsappClient.destroy();
    setTimeout(initWhatsApp, 2000);
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

// Start everything
const start = async () => {
    console.log('Starting bot...');
    
    // Launch Telegram bot
    await bot.launch();
    console.log('Telegram bot started');
    
    // Initialize Mega and restore session
    const megaConnected = await initMega();
    if (megaConnected) {
        await downloadSessionFromMega();
    }
    
    // Initialize WhatsApp
    await initWhatsApp();
    
    // Start keep-alive
    keepAlive();
    
    if (ADMIN_ID) {
        bot.telegram.sendMessage(ADMIN_ID, '🚀 Bot started! Initializing WhatsApp...');
    }
};

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    if (whatsappClient) whatsappClient.destroy();
    server.close();
    process.exit(0);
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    if (whatsappClient) whatsappClient.destroy();
    server.close();
    process.exit(0);
});

// Start the bot
start().catch(console.error);
