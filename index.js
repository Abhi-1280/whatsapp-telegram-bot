require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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

// Message queue for ultra-fast forwarding
const messageQueue = [];
let isProcessing = false;

// Performance settings for deals
const CONCURRENT_MESSAGES = 5; // Send 5 messages at once
const MESSAGE_DELAY = 50; // Only 50ms between messages
const QUEUE_CHECK_INTERVAL = 100; // Check queue every 100ms

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
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        }
    });

    // QR Code event
    whatsappClient.on('qr', async (qr) => {
        console.log('📱 QR Code received!');
        qrcode.generate(qr, { small: true });
        
        console.log('QR String:', qr);
        
        if (process.env.TELEGRAM_ADMIN_ID) {
            try {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `📱 *WhatsApp QR Code*\n\nScan this QR code in WhatsApp > Linked Devices:\n\n\`\`\`\n${qr}\n\`\`\``,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.error('Error sending QR to Telegram:', error);
            }
        }
    });

    // Authentication success
    whatsappClient.on('authenticated', () => {
        console.log('🔐 WhatsApp authenticated successfully!');
    });

    // Ready event
    whatsappClient.on('ready', async () => {
        console.log('✅ WhatsApp client is ready!');
        isWhatsAppReady = true;
        
        const chats = await whatsappClient.getChats();
        targetChat = chats.find(chat => chat.name === process.env.WHATSAPP_GROUP_NAME);
        
        if (targetChat) {
            console.log(`✅ Found target group: ${process.env.WHATSAPP_GROUP_NAME}`);
            
            if (process.env.TELEGRAM_ADMIN_ID) {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `✅ *Bot is ready!*\n\n📱 WhatsApp: Connected\n👥 Target Group: ${process.env.WHATSAPP_GROUP_NAME}\n🚀 Ultra-fast mode enabled!`,
                    { parse_mode: 'Markdown' }
                );
            }
        } else {
            console.error(`❌ Target group not found: ${process.env.WHATSAPP_GROUP_NAME}`);
            console.log('Available chats:');
            chats.forEach(chat => {
                console.log(`- ${chat.name} (${chat.isGroup ? 'Group' : 'Contact'})`);
            });
        }
    });

    // Disconnected event
    whatsappClient.on('disconnected', (reason) => {
        console.log('❌ WhatsApp disconnected:', reason);
        isWhatsAppReady = false;
        
        // Fast reconnection
        setTimeout(() => {
            console.log('🔄 Reconnecting...');
            initWhatsApp();
        }, 1000);
    });

    // Initialize client
    try {
        await whatsappClient.initialize();
    } catch (error) {
        console.error('Failed to initialize WhatsApp:', error);
        setTimeout(() => initWhatsApp(), 5000);
    }
}

// Ultra-fast message processor
async function processMessageQueue() {
    if (isProcessing || messageQueue.length === 0 || !isWhatsAppReady || !targetChat) {
        return;
    }

    isProcessing = true;

    // Process multiple messages concurrently
    const messagesToProcess = messageQueue.splice(0, CONCURRENT_MESSAGES);
    
    try {
        // Send all messages in parallel
        await Promise.all(
            messagesToProcess.map(async (message) => {
                try {
                    await targetChat.sendMessage(message.content);
                    console.log(`⚡ Sent: ${message.type}`);
                } catch (error) {
                    console.error(`❌ Failed: ${error.message}`);
                    // Don't retry - speed is priority
                }
            })
        );
        
        // Minimal delay only if more messages in queue
        if (messageQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
        }
    } catch (error) {
        console.error('Batch send error:', error);
    }

    isProcessing = false;
    
    // Immediately process next batch if available
    if (messageQueue.length > 0) {
        setImmediate(processMessageQueue);
    }
}

// Telegram message handler - Ultra fast
telegramBot.on('channel_post', async (ctx) => {
    const message = ctx.channelPost;
    
    try {
        let content = '';
        let type = 'unknown';
        
        // Format messages quickly
        if (message.text) {
            content = message.text;
            type = 'text';
        } else if (message.photo) {
            content = `📸 ${message.caption || ''}`.trim();
            type = 'photo';
        } else if (message.video) {
            content = `🎥 ${message.caption || ''}`.trim();
            type = 'video';
        } else if (message.document) {
            content = `📎 ${message.document.file_name}\n${message.caption || ''}`.trim();
            type = 'document';
        } else if (message.sticker) {
            content = `🎭 ${message.sticker.emoji || 'Sticker'}`;
            type = 'sticker';
        }
        
        if (content) {
            messageQueue.push({ type, content });
            // Immediately trigger processing
            setImmediate(processMessageQueue);
        }
        
    } catch (error) {
        console.error('Message handler error:', error);
    }
});

// Admin commands
telegramBot.command('status', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        const status = `
🤖 *Bot Status*

📱 WhatsApp: ${isWhatsAppReady ? '✅ Connected' : '❌ Disconnected'}
💬 Queue: ${messageQueue.length} messages
⏱ Uptime: ${Math.floor(process.uptime() / 60)} minutes
🎯 Target: ${process.env.WHATSAPP_GROUP_NAME}
⚡ Mode: Ultra-Fast (${CONCURRENT_MESSAGES} concurrent)
🔄 Processing: ${isProcessing ? 'Yes' : 'No'}
        `;
        
        await ctx.reply(status, { parse_mode: 'Markdown' });
    }
});

telegramBot.command('restart', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        await ctx.reply('🔄 Restarting...');
        
        if (whatsappClient) {
            await whatsappClient.destroy();
        }
        
        setTimeout(() => initWhatsApp(), 1000);
    }
});

telegramBot.command('clear', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        messageQueue.length = 0;
        await ctx.reply('🗑 Queue cleared!');
    }
});

// Ultra-fast queue processor
setInterval(() => {
    if (!isProcessing && messageQueue.length > 0) {
        processMessageQueue();
    }
}, QUEUE_CHECK_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down...');
    
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    await telegramBot.stop();
    process.exit(0);
});

// Start the application
async function start() {
    console.log('🚀 Starting Ultra-Fast WhatsApp-Telegram Bridge...');
    console.log(`⚡ Performance: ${CONCURRENT_MESSAGES} concurrent messages`);
    console.log(`⚡ Delay: ${MESSAGE_DELAY}ms between batches`);
    
    // Validate environment variables
    const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'WHATSAPP_GROUP_NAME'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    
    if (missingVars.length > 0) {
        console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
        process.exit(1);
    }
    
    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Server running on port ${PORT}`);
    });

    // Initialize WhatsApp immediately
    initWhatsApp().catch(error => {
        console.error('WhatsApp init failed:', error);
    });

    // Start Telegram bot with error handling
    telegramBot.launch({
        dropPendingUpdates: true
    }).then(() => {
        console.log('🤖 Telegram bot started');
    }).catch(async (error) => {
        if (error.message.includes('409')) {
            console.log('🔄 Clearing existing bot instance...');
            try {
                await telegramBot.telegram.deleteWebhook({ drop_pending_updates: true });
                await new Promise(resolve => setTimeout(resolve, 1000));
                await telegramBot.launch({ dropPendingUpdates: true });
                console.log('🤖 Telegram bot started after cleanup');
            } catch (retryError) {
                console.error('Telegram bot failed:', retryError);
            }
        } else {
            console.error('Telegram bot error:', error);
        }
    });
}

// Handle errors without crashing
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

// Start everything
start().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
