require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Telegraf } = require('telegraf');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// Express app for health checks
const app = express();
const PORT = process.env.PORT || 10000;

// Initialize Telegram Bot
const telegramBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// WhatsApp variables
let whatsappClient;
let isWhatsAppReady = false;
let targetChat = null;

// Message queue for fast forwarding
const messageQueue = [];
let isProcessing = false;

// Initialize Express endpoints
app.get('/', (req, res) => {
    res.send('WhatsApp-Telegram Bridge is running! 🚀');
});

app.get('/health', (req, res) => {
    res.json({
        status: 'alive',
        whatsappReady: isWhatsAppReady,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        queueSize: messageQueue.length
    });
});

// Initialize WhatsApp Client
async function initWhatsApp() {
    console.log('🔄 Initializing WhatsApp...');
    
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-bot',
            dataPath: './whatsapp_session'
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
                '--disable-features=IsolateOrigins',
                '--disable-site-isolation-trials'
            ],
            executablePath: '/usr/bin/google-chrome-stable'
        }
    });

    // QR Code event
    whatsappClient.on('qr', async (qr) => {
        console.log('📱 QR Code received!');
        qrcode.generate(qr, { small: true });
        
        // Send QR to Telegram admin if configured
        if (process.env.TELEGRAM_ADMIN_ID) {
            try {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `📱 *WhatsApp QR Code*\n\nScan this QR code to login:\n\n\`${qr}\`\n\nOr check the console logs in Render dashboard.`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.error('Error sending QR to Telegram:', error);
            }
        }
    });

    // Ready event
    whatsappClient.on('ready', async () => {
        console.log('✅ WhatsApp client is ready!');
        isWhatsAppReady = true;
        
        // Find target group
        const chats = await whatsappClient.getChats();
        targetChat = chats.find(chat => chat.name === process.env.WHATSAPP_GROUP_NAME);
        
        if (targetChat) {
            console.log(`✅ Found target group: ${process.env.WHATSAPP_GROUP_NAME}`);
            
            // Notify admin
            if (process.env.TELEGRAM_ADMIN_ID) {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `✅ Bot is ready!\n\n📱 WhatsApp: Connected\n👥 Target Group: ${process.env.WHATSAPP_GROUP_NAME}\n🤖 Telegram: Active\n\n🚀 Ready to forward messages!`
                );
            }
        } else {
            console.error(`❌ Target group not found: ${process.env.WHATSAPP_GROUP_NAME}`);
        }
    });

    // Disconnected event
    whatsappClient.on('disconnected', (reason) => {
        console.log('❌ WhatsApp disconnected:', reason);
        isWhatsAppReady = false;
        
        // Attempt reconnection after 5 seconds
        setTimeout(() => initWhatsApp(), 5000);
    });

    // Initialize client
    await whatsappClient.initialize();
}

// Process message queue
async function processMessageQueue() {
    if (isProcessing || messageQueue.length === 0 || !isWhatsAppReady || !targetChat) {
        return;
    }

    isProcessing = true;

    while (messageQueue.length > 0 && isWhatsAppReady) {
        const message = messageQueue.shift();
        
        try {
            await targetChat.sendMessage(message.content);
            console.log(`✅ Forwarded message: ${message.type}`);
            
            // Small delay to prevent rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error('❌ Error sending message:', error);
            
            // Put message back in queue
            messageQueue.unshift(message);
            break;
        }
    }

    isProcessing = false;
}

// Telegram message handler
telegramBot.on('channel_post', async (ctx) => {
    const message = ctx.channelPost;
    
    try {
        // Text message
        if (message.text) {
            messageQueue.push({
                type: 'text',
                content: message.text
            });
        }
        
        // Photo
        else if (message.photo) {
            const caption = message.caption || '';
            messageQueue.push({
                type: 'text',
                content: `📸 [Photo]\n${caption}`
            });
        }
        
        // Video
        else if (message.video) {
            const caption = message.caption || '';
            messageQueue.push({
                type: 'text',
                content: `🎥 [Video]\n${caption}`
            });
        }
        
        // Document
        else if (message.document) {
            const fileName = message.document.file_name;
            const caption = message.caption || '';
            messageQueue.push({
                type: 'text',
                content: `📎 [File: ${fileName}]\n${caption}`
            });
        }
        
        // Process queue
        processMessageQueue();
        
    } catch (error) {
        console.error('Error handling Telegram message:', error);
    }
});

// Start queue processor
setInterval(processMessageQueue, 1000);

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    process.exit(0);
});

// Start the application
async function start() {
    console.log('🚀 Starting WhatsApp-Telegram Bridge...');
    
    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Server running on port ${PORT}`);
    });

    // Initialize WhatsApp
    await initWhatsApp();

    // Start Telegram bot
    telegramBot.launch();
    console.log('🤖 Telegram bot started');
}

// Start everything
start().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});