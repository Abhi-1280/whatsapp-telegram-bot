const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');

// Environment variables
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const WHATSAPP_GROUP_NAME = 'savings safari';
const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://whatsappbot:Pass123@cluster0.mongodb.net/whatsapp-sessions?retryWrites=true&w=majority';

// Initialize Express
const app = express();
app.use(express.json());

// Server endpoints
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

// Global variables
const bot = new Telegraf(BOT_TOKEN);
let whatsappClient;
let isReady = false;
let whatsappGroupId = null;
let messageQueue = [];
let isProcessing = false;
let store;
let isInitializing = false;

// MongoDB connection
const connectMongo = async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('MongoDB connected');
        store = new MongoStore({ mongoose: mongoose });
        return true;
    } catch (error) {
        console.error('MongoDB connection error:', error);
        return false;
    }
};

// Initialize WhatsApp with persistent auth
const initWhatsApp = async () => {
    if (isInitializing) {
        console.log('Already initializing...');
        return;
    }
    
    isInitializing = true;
    
    try {
        console.log('Initializing WhatsApp client...');
        
        whatsappClient = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                backupSyncIntervalMs: 300000
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
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process'
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
            },
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
            }
        });

        // Remote auth events
        whatsappClient.on('remote_session_saved', () => {
            console.log('Session saved to MongoDB');
        });

        // QR event (only happens first time)
        whatsappClient.on('qr', (qr) => {
            console.log('QR RECEIVED - First time setup');
            const qrcode = require('qrcode-terminal');
            qrcode.generate(qr, { small: true });
            
            if (ADMIN_ID) {
                bot.telegram.sendMessage(ADMIN_ID, 
                    '📱 First time setup - Please scan QR code in console\n\n' +
                    'This is ONE TIME only. After this, the session will be saved permanently.'
                );
            }
        });

        whatsappClient.on('authenticated', () => {
            console.log('WhatsApp authenticated!');
            if (ADMIN_ID) {
                bot.telegram.sendMessage(ADMIN_ID, '✅ Authenticated! Session saved permanently.');
            }
        });

        whatsappClient.on('ready', async () => {
            console.log('WhatsApp client ready!');
            isReady = true;
            isInitializing = false;
            
            // Find and set group
            await findAndSetGroup();
            
            // Process queued messages
            if (messageQueue.length > 0) {
                console.log(`Processing ${messageQueue.length} queued messages...`);
                processQueue();
            }
        });

        whatsappClient.on('auth_failure', (msg) => {
            console.error('Authentication failure:', msg);
            isReady = false;
            isInitializing = false;
            
            if (ADMIN_ID) {
                bot.telegram.sendMessage(ADMIN_ID, '❌ Authentication failed! Retrying...');
            }
            
            setTimeout(() => initWhatsApp(), 10000);
        });

        whatsappClient.on('disconnected', (reason) => {
            console.log('WhatsApp disconnected:', reason);
            isReady = false;
            isInitializing = false;
            
            if (ADMIN_ID) {
                bot.telegram.sendMessage(ADMIN_ID, `⚠️ Disconnected: ${reason}. Reconnecting...`);
            }
            
            setTimeout(() => initWhatsApp(), 5000);
        });

        // Initialize the client
        await whatsappClient.initialize();
        
    } catch (error) {
        console.error('WhatsApp init error:', error);
        isInitializing = false;
        setTimeout(() => initWhatsApp(), 10000);
    }
};

// Find and set WhatsApp group
const findAndSetGroup = async () => {
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
                    `✅ *Bot Ready!*\n\n` +
                    `📱 WhatsApp: Connected\n` +
                    `👥 Group: ${group.name}\n` +
                    `📨 Queue: ${messageQueue.length} messages\n` +
                    `⚡ Status: Active`,
                    { parse_mode: 'Markdown' }
                );
            }
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
        console.error('Error finding group:', error);
    }
};

// Process message queue
const processQueue = async () => {
    if (isProcessing || messageQueue.length === 0 || !isReady || !whatsappGroupId) return;
    
    isProcessing = true;
    
    while (messageQueue.length > 0 && isReady) {
        const msg = messageQueue.shift();
        
        try {
            if (msg.type === 'text') {
                await whatsappClient.sendMessage(whatsappGroupId, msg.content);
            } else if (msg.media) {
                await whatsappClient.sendMessage(whatsappGroupId, msg.media, { caption: msg.caption });
            }
            
            console.log(`Sent queued message (${Date.now() - msg.timestamp}ms old)`);
        } catch (error) {
            console.error('Queue processing error:', error);
        }
        
        // Small delay between messages
        if (messageQueue.length > 0) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    isProcessing = false;
};

// Download file from Telegram
const downloadFile = async (fileId) => {
    try {
        const file = await bot.telegram.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 100 * 1024 * 1024
        });
        
        return Buffer.from(response.data);
    } catch (error) {
        console.error('Download error:', error);
        throw error;
    }
};

// Handle Telegram channel posts
bot.on('channel_post', async (ctx) => {
    const timestamp = Date.now();
    const post = ctx.channelPost;
    const caption = post.text || post.caption || '';
    
    try {
        // If not ready, queue the message
        if (!isReady || !whatsappGroupId) {
            if (post.photo || post.video || post.document) {
                messageQueue.push({
                    type: 'media',
                    content: caption || '[Media]',
                    timestamp,
                    originalPost: post
                });
            } else if (caption) {
                messageQueue.push({
                    type: 'text',
                    content: caption,
                    timestamp
                });
            }
            console.log('Message queued (bot not ready)');
            return;
        }
        
        // Send directly when ready
        if (post.photo) {
            const buffer = await downloadFile(post.photo[post.photo.length - 1].file_id);
            const media = new MessageMedia('image/jpeg', buffer.toString('base64'));
            await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
            console.log(`Photo forwarded in ${Date.now() - timestamp}ms`);
            
        } else if (post.video) {
            const buffer = await downloadFile(post.video.file_id);
            const media = new MessageMedia('video/mp4', buffer.toString('base64'));
            await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
            console.log(`Video forwarded in ${Date.now() - timestamp}ms`);
            
        } else if (post.document) {
            const buffer = await downloadFile(post.document.file_id);
            const media = new MessageMedia(
                post.document.mime_type || 'application/octet-stream',
                buffer.toString('base64'),
                post.document.file_name
            );
            await whatsappClient.sendMessage(whatsappGroupId, media, { caption });
            console.log(`Document forwarded in ${Date.now() - timestamp}ms`);
            
        } else if (caption) {
            await whatsappClient.sendMessage(whatsappGroupId, caption);
            console.log(`Text forwarded in ${Date.now() - timestamp}ms`);
        }
        
    } catch (error) {
        console.error('Forward error:', error);
    }
});

// Bot commands
bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    await ctx.reply(
        `📊 *Bot Status*\n\n` +
        `WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}\n` +
        `Group: ${whatsappGroupId ? '✅ Found' : '❌ Not found'}\n` +
        `Queue: ${messageQueue.length} messages\n` +
        `Uptime: ${hours}h ${minutes}m\n` +
        `MongoDB: ${mongoose.connection.readyState === 1 ? '✅' : '❌'}`,
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

bot.command('queue', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply(`📨 Queue: ${messageQueue.length} messages pending`);
});

// Keep alive mechanism
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

// Main startup function
const start = async () => {
    console.log('Starting WhatsApp-Telegram Bot...');
    
    // Connect to MongoDB first
    const mongoConnected = await connectMongo();
    if (!mongoConnected) {
        console.error('Failed to connect to MongoDB. Exiting...');
        process.exit(1);
    }
    // Main startup function (continued)
const start = async () => {
    console.log('Starting WhatsApp-Telegram Bot...');
    
    // Connect to MongoDB first
    const mongoConnected = await connectMongo();
    if (!mongoConnected) {
        console.error('Failed to connect to MongoDB. Exiting...');
        process.exit(1);
    }
    
    // Launch Telegram bot
    await bot.launch();
    console.log('Telegram bot started');
    
    // Initialize WhatsApp with delay to ensure MongoDB is ready
    setTimeout(() => {
        initWhatsApp();
    }, 2000);
    
    // Start keep-alive
    keepAlive();
    
    // Send startup notification
    if (ADMIN_ID) {
        bot.telegram.sendMessage(ADMIN_ID, 
            '🚀 *Bot Started!*\n\n' +
            '⏳ Initializing WhatsApp...\n' +
            '💾 Session will be restored automatically\n' +
            '📱 No QR scan needed after first login',
            { parse_mode: 'Markdown' }
        );
    }
};

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    bot.stop('SIGINT');
    if (whatsappClient) whatsappClient.destroy();
    server.close();
    mongoose.connection.close();
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    bot.stop('SIGTERM');
    if (whatsappClient) whatsappClient.destroy();
    server.close();
    mongoose.connection.close();
    process.exit(0);
});

// Start the bot
start().catch(error => {
    console.error('Failed to start:', error);
    process.exit(1);
});
