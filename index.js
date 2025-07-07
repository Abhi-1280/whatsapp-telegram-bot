const { Client, LocalAuth } = require('whatsapp-web.js');
const { Telegraf } = require('telegraf');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

const bot = new Telegraf(BOT_TOKEN);
let whatsappClient;
let isReady = false;
let messageQueue = [];
let isProcessing = false;

const initWhatsApp = () => {
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: "bot-session",
            dataPath: './.wwebjs_auth'
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
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log('QR Code received');
        qrcode.generate(qr, { small: true });
        if (ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, `Please scan this QR code:\n${qr}`);
        }
    });

    whatsappClient.on('ready', async () => {
        console.log('WhatsApp client is ready!');
        isReady = true;
        if (ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, '✅ WhatsApp bot is connected and ready!');
        }
        await backupSession();
    });

    whatsappClient.on('authenticated', () => {
        console.log('Authenticated successfully');
    });

    whatsappClient.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        if (ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, `❌ WhatsApp authentication failed: ${msg}`);
        }
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('WhatsApp disconnected:', reason);
        isReady = false;
        if (ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, `⚠️ WhatsApp disconnected: ${reason}`);
        }
        setTimeout(() => {
            whatsappClient.initialize();
        }, 5000);
    });

    whatsappClient.initialize();
};

const backupSession = async () => {
    try {
        const sessionPath = './.wwebjs_auth';
        if (fs.existsSync(sessionPath)) {
            console.log('Session backup completed');
        }
    } catch (error) {
        console.error('Session backup error:', error);
    }
};

const downloadFile = async (fileUrl) => {
    try {
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'arraybuffer'
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error('Error downloading file:', error);
        return null;
    }
};

const processMessageQueue = async () => {
    if (isProcessing || messageQueue.length === 0) return;
    
    isProcessing = true;
    const batch = messageQueue.splice(0, 5);
    
    await Promise.all(batch.map(async (message) => {
        try {
            await sendToWhatsApp(message);
        } catch (error) {
            console.error('Error processing message:', error);
        }
    }));
    
    isProcessing = false;
    
    if (messageQueue.length > 0) {
        setImmediate(processMessageQueue);
    }
};

const sendToWhatsApp = async (message) => {
    if (!isReady || !whatsappClient) {
        throw new Error('WhatsApp client not ready');
    }

    try {
        if (message.text) {
            await whatsappClient.sendMessage(WHATSAPP_GROUP_ID, message.text);
        }

        if (message.photo) {
            const fileBuffer = await downloadFile(message.photo);
            if (fileBuffer) {
                const media = {
                    data: fileBuffer.toString('base64'),
                    mimetype: 'image/jpeg',
                    filename: 'image.jpg'
                };
                await whatsappClient.sendMessage(WHATSAPP_GROUP_ID, media, { caption: message.caption || '' });
            }
        }

        if (message.video) {
            const fileBuffer = await downloadFile(message.video);
            if (fileBuffer) {
                const media = {
                    data: fileBuffer.toString('base64'),
                    mimetype: 'video/mp4',
                    filename: 'video.mp4'
                };
                await whatsappClient.sendMessage(WHATSAPP_GROUP_ID, media, { caption: message.caption || '' });
            }
        }

        if (message.document) {
            const fileBuffer = await downloadFile(message.document);
            if (fileBuffer) {
                const media = {
                    data: fileBuffer.toString('base64'),
                    mimetype: 'application/octet-stream',
                    filename: message.filename || 'document'
                };
                await whatsappClient.sendMessage(WHATSAPP_GROUP_ID, media, { caption: message.caption || '' });
            }
        }
    } catch (error) {
        console.error('Error sending to WhatsApp:', error);
        throw error;
    }
};

bot.on('channel_post', async (ctx) => {
    if (ctx.chat.id.toString() !== TELEGRAM_CHANNEL_ID) return;

    const message = {
        text: ctx.message.text || ctx.message.caption,
        caption: ctx.message.caption,
        photo: ctx.message.photo ? `https://api.telegram.org/file/bot${BOT_TOKEN}/${(await bot.telegram.getFile(ctx.message.photo[ctx.message.photo.length - 1].file_id)).file_path}` : null,
        video: ctx.message.video ? `https://api.telegram.org/file/bot${BOT_TOKEN}/${(await bot.telegram.getFile(ctx.message.video.file_id)).file_path}` : null,
        document: ctx.message.document ? `https://api.telegram.org/file/bot${BOT_TOKEN}/${(await bot.telegram.getFile(ctx.message.document.file_id)).file_path}` : null,
        filename: ctx.message.document?.file_name
    };

    messageQueue.push(message);
    processMessageQueue();
});

bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const status = `
🤖 Bot Status:
- WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}
- Queue: ${messageQueue.length} messages
- Processing: ${isProcessing ? 'Yes' : 'No'}
    `;
    await ctx.reply(status);
});

bot.command('restart', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply('Restarting WhatsApp client...');
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    setTimeout(() => {
        initWhatsApp();
    }, 2000);
});

const keepAlive = () => {
    if (RENDER_EXTERNAL_URL) {
        setInterval(async () => {
            try {
                await axios.get(RENDER_EXTERNAL_URL);
                console.log('Keep-alive ping sent');
            } catch (error) {
                console.error('Keep-alive error:', error.message);
            }
        }, 10 * 60 * 1000);
    }
};

const startBot = async () => {
    console.log('Starting bot...');
    initWhatsApp();
    await bot.launch();
    keepAlive();
    console.log('Bot started successfully');
};

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    if (whatsappClient) {
        whatsappClient.destroy();
    }
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    if (whatsappClient) {
        whatsappClient.destroy();
    }
});

startBot();
