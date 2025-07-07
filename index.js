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
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
            // Remove executablePath - let whatsapp-web.js handle Chrome detection
        }
    });

    // QR Code event
    whatsappClient.on('qr', async (qr) => {
        console.log('📱 QR Code received!');
        qrcode.generate(qr, { small: true });
        
        // Also log the QR string for manual copying if needed
        console.log('QR String:', qr);
        
        // Send QR to Telegram admin if configured
        if (process.env.TELEGRAM_ADMIN_ID) {
            try {
                // Send as code block for easy copying
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `📱 *WhatsApp QR Code*\n\nScan this QR code in WhatsApp > Linked Devices:\n\n\`\`\`\n${qr}\n\`\`\`\n\n_Or check the Render logs for visual QR code_`,
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
        
        // Find target group
        const chats = await whatsappClient.getChats();
        targetChat = chats.find(chat => chat.name === process.env.WHATSAPP_GROUP_NAME);
        
        if (targetChat) {
            console.log(`✅ Found target group: ${process.env.WHATSAPP_GROUP_NAME}`);
            
            // Notify admin
            if (process.env.TELEGRAM_ADMIN_ID) {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `✅ *Bot is ready!*\n\n📱 WhatsApp: Connected\n👥 Target Group: ${process.env.WHATSAPP_GROUP_NAME}\n🤖 Telegram: Active\n💬 Queue: Empty\n\n🚀 Ready to forward messages!`,
                    { parse_mode: 'Markdown' }
                );
            }
        } else {
            console.error(`❌ Target group not found: ${process.env.WHATSAPP_GROUP_NAME}`);
            
            // List available chats for debugging
            console.log('Available chats:');
            chats.forEach(chat => {
                console.log(`- ${chat.name} (${chat.isGroup ? 'Group' : 'Contact'})`);
            });
        }
    });

    // Auth failure event
    whatsappClient.on('auth_failure', msg => {
        console.error('❌ Authentication failure:', msg);
    });

    // Disconnected event
    whatsappClient.on('disconnected', (reason) => {
        console.log('❌ WhatsApp disconnected:', reason);
        isWhatsAppReady = false;
        
        // Notify admin
        if (process.env.TELEGRAM_ADMIN_ID) {
            telegramBot.telegram.sendMessage(
                process.env.TELEGRAM_ADMIN_ID,
                `⚠️ WhatsApp disconnected!\nReason: ${reason}\n\nAttempting reconnection...`
            ).catch(console.error);
        }
        
        // Attempt reconnection after 5 seconds
        setTimeout(() => {
            console.log('🔄 Attempting to reconnect...');
            initWhatsApp();
        }, 5000);
    });

    // Loading screen event
    whatsappClient.on('loading_screen', (percent, message) => {
        console.log('Loading:', percent, message);
    });

    // Initialize client
    try {
        await whatsappClient.initialize();
    } catch (error) {
        console.error('Failed to initialize WhatsApp:', error);
        setTimeout(() => initWhatsApp(), 10000);
    }
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
            // Send message with retry logic
            let retries = 3;
            while (retries > 0) {
                try {
                    await targetChat.sendMessage(message.content);
                    console.log(`✅ Forwarded: ${message.type} message`);
                    break;
                } catch (err) {
                    retries--;
                    if (retries === 0) throw err;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            // Small delay to prevent rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
            console.error('❌ Error sending message:', error.message);
            
            // Put message back in queue if it's important
            if (message.important) {
                messageQueue.unshift(message);
            }
            
            // Longer delay on error
            await new Promise(resolve => setTimeout(resolve, 2000));
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
                content: message.text,
                important: true
            });
        }
        
        // Photo
        else if (message.photo) {
            const caption = message.caption || '';
            messageQueue.push({
                type: 'photo',
                content: `📸 *Photo*\n${caption}`,
                important: true
            });
        }
        
        // Video
        else if (message.video) {
            const caption = message.caption || '';
            messageQueue.push({
                type: 'video',
                content: `🎥 *Video*\n${caption}`,
                important: true
            });
        }
        
        // Document
        else if (message.document) {
            const fileName = message.document.file_name;
            const caption = message.caption || '';
            messageQueue.push({
                type: 'document',
                content: `📎 *File:* ${fileName}\n${caption}`,
                important: true
            });
        }
        
        // Sticker
        else if (message.sticker) {
            messageQueue.push({
                type: 'sticker',
                content: `🎭 [Sticker: ${message.sticker.emoji || 'N/A'}]`,
                important: false
            });
        }
        
        // Voice
        else if (message.voice) {
            const duration = message.voice.duration;
            messageQueue.push({
                type: 'voice',
                content: `🎤 [Voice message: ${duration}s]`,
                important: true
            });
        }
        
        // Poll
        else if (message.poll) {
            messageQueue.push({
                type: 'poll',
                content: `📊 *Poll:* ${message.poll.question}\n${message.poll.options.map(o => `• ${o.text}`).join('\n')}`,
                important: true
            });
        }
        
        // Process queue immediately
        processMessageQueue();
        
    } catch (error) {
        console.error('Error handling Telegram message:', error);
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
🔄 Processing: ${isProcessing ? 'Yes' : 'No'}
        `;
        
        await ctx.reply(status, { parse_mode: 'Markdown' });
    }
});

telegramBot.command('restart', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        await ctx.reply('🔄 Restarting WhatsApp connection...');
        
        if (whatsappClient) {
            await whatsappClient.destroy();
        }
        
        setTimeout(() => initWhatsApp(), 2000);
    }
});

telegramBot.command('clear', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        messageQueue.length = 0;
        await ctx.reply('🗑 Message queue cleared!');
    }
});

// Start queue processor
setInterval(processMessageQueue, 500);

// Health check to prevent idle
setInterval(() => {
    if (isWhatsAppReady) {
        console.log(`💓 Heartbeat - Queue: ${messageQueue.length}, Ready: ${isWhatsAppReady}`);
    }
}, 60000); // Every minute

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    await telegramBot.stop();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 SIGINT received, shutting down gracefully...');
    
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    await telegramBot.stop();
    process.exit(0);
});

// Start the application
async function start() {
    console.log('🚀 Starting WhatsApp-Telegram Bridge...');
    console.log(`📦 Node version: ${process.version}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
    
    // Validate environment variables
    const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'WHATSAPP_GROUP_NAME'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    
    if (missingVars.length > 0) {
        console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
        process.exit(1);
    }
    
    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Health check server running on port ${PORT}`);
    });

    // Initialize WhatsApp with delay to ensure Docker is ready
    setTimeout(() => {
        initWhatsApp().catch(error => {
            console.error('Failed to initialize WhatsApp:', error);
        });
    }, 2000);

    // Start Telegram bot
    telegramBot.launch().then(() => {
        console.log('🤖 Telegram bot started successfully');
    }).catch(error => {
        console.error('Failed to start Telegram bot:', error);
        process.exit(1);
    });
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit on uncaught exceptions, try to recover
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
    // Don't exit on unhandled rejections, try to recover
});

// Start everything
start().catch(error => {
    console.error('Fatal error during startup:', error);
    process.exit(1);
});
