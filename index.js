const { Client, LocalAuth } = require('whatsapp-web.js');
const { Telegraf } = require('telegraf');
const express = require('express');
const { Storage } = require('megajs');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

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
let messageQueue = [];
let isProcessing = false;
let megaStorage;

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
        
        const files = await megaStorage.root.children;
        const sessionFile = files.find(file => file.name === 'whatsapp-session.zip');
        
        if (sessionFile) {
            const buffer = await sessionFile.downloadBuffer();
            await fs.writeFile('./session-backup.zip', buffer);
            
            const unzipper = require('unzipper');
            await fs.createReadStream('./session-backup.zip')
                .pipe(unzipper.Extract({ path: './' }))
                .promise();
            
            console.log('Session restored from Mega');
            return true;
        }
        return false;
    } catch (error) {
        console.error('Session download error:', error);
        return false;
    }
};

const uploadSessionToMega = async () => {
    try {
        if (!megaStorage) return;
        
        const archiver = require('archiver');
        const output = require('fs').createWriteStream('./session-backup.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        output.on('close', async () => {
            const buffer = await fs.readFile('./session-backup.zip');
            const files = await megaStorage.root.children;
            const existingFile = files.find(file => file.name === 'whatsapp-session.zip');
            
            if (existingFile) {
                await existingFile.delete();
            }
            
            await megaStorage.root.upload('whatsapp-session.zip', buffer);
            console.log('Session backed up to Mega');
        });
        
        archive.pipe(output);
        archive.directory('./.wwebjs_auth/', false);
        await archive.finalize();
    } catch (error) {
        console.error('Session upload error:', error);
    }
};

const initWhatsApp = async () => {
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: "telegram-forwarder"
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
        console.log('QR Code received');
        qrcode.generate(qr, { small: true });
        bot.telegram.sendMessage(ADMIN_ID, `📱 Scan this QR code:\n\n${qr}`);
    });

    whatsappClient.on('ready', async () => {
        console.log('WhatsApp ready!');
        isReady = true;
        
        const chats = await whatsappClient.getChats();
        const targetGroup = chats.find(chat => 
            chat.isGroup && chat.name.toLowerCase().includes(WHATSAPP_GROUP_NAME.toLowerCase())
        );
        
        if (targetGroup) {
            whatsappGroupId = targetGroup.id._serialized;
            console.log(`Found group: ${targetGroup.name}`);
            bot.telegram.sendMessage(ADMIN_ID, `✅ Connected!\nGroup: ${targetGroup.name}`);
        } else {
            bot.telegram.sendMessage(ADMIN_ID, `❌ Group "${WHATSAPP_GROUP_NAME}" not found`);
        }
        
        await uploadSessionToMega();
    });

    whatsappClient.on('authenticated', () => {
        console.log('Authenticated');
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('Disconnected:', reason);
        isReady = false;
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ Disconnected: ${reason}`);
        setTimeout(() => whatsappClient.initialize(), 5000);
    });

    whatsappClient.initialize();
};

const processQueue = async () => {
    if (isProcessing || messageQueue.length === 0 || !isReady || !whatsappGroupId) return;
    
    isProcessing = true;
    const batch = messageQueue.splice(0, 10);
    
    await Promise.all(batch.map(async (msg) => {
        try {
            await whatsappClient.sendMessage(whatsappGroupId, msg.content, msg.options);
        } catch (error) {
            console.error('Send error:', error);
        }
    }));
    
    isProcessing = false;
    if (messageQueue.length > 0) setImmediate(processQueue);
};

bot.on('channel_post', async (ctx) => {
    try {
        let content = ctx.channelPost.text || ctx.channelPost.caption || '';
        let options = {};
        
        if (ctx.channelPost.photo) {
            const photo = ctx.channelPost.photo[ctx.channelPost.photo.length - 1];
            const file = await bot.telegram.getFile(photo.file_id);
            const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            
            const media = new MessageMedia('image/jpeg', Buffer.from(response.data).toString('base64'));
            messageQueue.push({ content: media, options: { caption: content } });
        } else if (ctx.channelPost.video) {
            const file = await bot.telegram.getFile(ctx.channelPost.video.file_id);
            const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            
            const media = new MessageMedia('video/mp4', Buffer.from(response.data).toString('base64'));
            messageQueue.push({ content: media, options: { caption: content } });
        } else if (ctx.channelPost.document) {
            const file = await bot.telegram.getFile(ctx.channelPost.document.file_id);
            const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            
            const media = new MessageMedia(
                ctx.channelPost.document.mime_type || 'application/octet-stream',
                Buffer.from(response.data).toString('base64'),
                ctx.channelPost.document.file_name
            );
            messageQueue.push({ content: media, options: { caption: content } });
        } else if (content) {
            messageQueue.push({ content, options: {} });
        }
        
        processQueue();
    } catch (error) {
        console.error('Message handling error:', error);
    }
});

bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply(`
🤖 Bot Status:
├ WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}
├ Group: ${whatsappGroupId ? '✅ Found' : '❌ Not found'}
├ Queue: ${messageQueue.length} messages
└ Processing: ${isProcessing ? 'Yes' : 'No'}
    `);
});

bot.command('restart', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply('♻️ Restarting...');
    if (whatsappClient) await whatsappClient.destroy();
    setTimeout(initWhatsApp, 2000);
});

app.get('/', (req, res) => {
    res.json({
        status: 'running',
        whatsapp: isReady,
        queue: messageQueue.length,
        uptime: process.uptime()
    });
});

const keepAlive = () => {
    setInterval(async () => {
        try {
            const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
            await axios.get(url);
            console.log('Keep-alive ping');
        } catch (error) {
            console.error('Keep-alive error');
        }
    }, 5 * 60 * 1000);
};

const { MessageMedia } = require('whatsapp-web.js');

const start = async () => {
    console.log('Starting bot...');
    
    await initMega();
    await downloadSessionFromMega();
    await initWhatsApp();
    
    await bot.launch();
    app.listen(PORT, () => console.log(`Server on port ${PORT}`));
    
    keepAlive();
    
    bot.telegram.sendMessage(ADMIN_ID, '🚀 Bot started!');
};

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

start();
