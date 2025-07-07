require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { Telegraf } = require('telegraf');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { Storage } = require('megajs');
const archiver = require('archiver');
const extract = require('extract-zip');
const axios = require('axios');

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

// Performance settings for deals - OPTIMIZED
const CONCURRENT_MESSAGES = 10; // Increased for faster processing
const MESSAGE_DELAY = 25; // Reduced delay
const QUEUE_CHECK_INTERVAL = 50; // Faster queue checking

// Mega storage for session persistence
let megaStorage = null;

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

// Session Manager Class
class SessionManager {
    constructor() {
        this.sessionPath = './whatsapp_session';
        this.ready = false;
    }

    async init() {
        if (!this.ready && process.env.MEGA_EMAIL && process.env.MEGA_PASSWORD) {
            try {
                megaStorage = new Storage({
                    email: process.env.MEGA_EMAIL,
                    password: process.env.MEGA_PASSWORD
                });
                await megaStorage.login();
                this.ready = true;
                console.log('✅ Mega storage connected');
            } catch (error) {
                console.error('❌ Mega login failed:', error.message);
            }
        }
    }

    async downloadSession() {
        if (!this.ready) return false;
        
        try {
            console.log('📥 Downloading session from Mega...');
            
            await megaStorage.reload();
            const files = megaStorage.root.children;
            const sessionFile = files.find(f => f.name === 'whatsapp_session.zip');
            
            if (!sessionFile) {
                console.log('📭 No session backup found in Mega');
                return false;
            }
            
            const buffer = await sessionFile.downloadBuffer();
            const zipPath = '/tmp/session_restore.zip';
            await fs.writeFile(zipPath, buffer);
            
            // Clean existing session
            await fs.rm(this.sessionPath, { recursive: true, force: true });
            
            // Extract session
            await extract(zipPath, { dir: path.resolve('./') });
            await fs.unlink(zipPath);
            
            console.log('✅ Session restored from Mega');
            return true;
        } catch (error) {
            console.error('❌ Session download failed:', error.message);
            return false;
        }
    }

    async uploadSession() {
        if (!this.ready) return false;
        
        try {
            console.log('📤 Uploading session to Mega...');
            
            // Check if session exists
            try {
                await fs.access(this.sessionPath);
            } catch {
                console.log('📭 No session to upload');
                return false;
            }
            
            // Create zip
            const zipPath = '/tmp/session_backup.zip';
            await this.createZip(this.sessionPath, zipPath);
            
            // Delete old backup
            await megaStorage.reload();
            const files = megaStorage.root.children;
            const oldFile = files.find(f => f.name === 'whatsapp_session.zip');
            if (oldFile) {
                await oldFile.delete();
            }
            
            // Upload new backup
            const buffer = await fs.readFile(zipPath);
            const uploadStream = megaStorage.upload({
                name: 'whatsapp_session.zip',
                size: buffer.length
            });
            
            uploadStream.end(buffer);
            
            await new Promise((resolve, reject) => {
                uploadStream.on('complete', resolve);
                uploadStream.on('error', reject);
            });
            
            await fs.unlink(zipPath);
            console.log('✅ Session uploaded to Mega');
            return true;
        } catch (error) {
            console.error('❌ Session upload failed:', error.message);
            return false;
        }
    }

    async createZip(sourceDir, outPath) {
        const output = require('fs').createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        return new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            
            archive.pipe(output);
            archive.directory(sourceDir, false);
            archive.finalize();
        });
    }
}

const sessionManager = new SessionManager();

// Initialize WhatsApp Client
async function initWhatsApp() {
    console.log('🔄 Initializing WhatsApp...');
    
    // Initialize session manager
    await sessionManager.init();
    
    // Download session from Mega if available
    await sessionManager.downloadSession();
    
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
                '--disable-blink-features=AutomationControlled'
            ]
        }
    });

    // QR Code event
    whatsappClient.on('qr', async (qr) => {
        console.log('📱 QR Code received!');
        qrcode.generate(qr, { small: true });
        
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
        // Upload session after authentication
        setTimeout(() => sessionManager.uploadSession(), 5000);
    });

    // Ready event
    whatsappClient.on('ready', async () => {
        console.log('✅ WhatsApp client is ready!');
        isWhatsAppReady = true;
        
        // Upload session when ready
        await sessionManager.uploadSession();
        
        const chats = await whatsappClient.getChats();
        
        // Debug: List all chats
        console.log('📋 Available chats:');
        chats.forEach(chat => {
            console.log(`- ${chat.name} (${chat.isGroup ? 'Group' : 'Contact'})`);
        });
        
        // Find target chat - case insensitive search
        targetChat = chats.find(chat => 
            chat.name && chat.name.toLowerCase() === process.env.WHATSAPP_GROUP_NAME.toLowerCase()
        );
        
        if (targetChat) {
            console.log(`✅ Found target group: ${process.env.WHATSAPP_GROUP_NAME}`);
            console.log(`   Group ID: ${targetChat.id._serialized}`);
            
            if (process.env.TELEGRAM_ADMIN_ID) {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `✅ *Bot is ready!*\n\n📱 WhatsApp: Connected\n👥 Target Group: ${process.env.WHATSAPP_GROUP_NAME}\n☁️ Session: Backed up to Mega\n🚀 Ultra-fast mode enabled!\n\n📨 Send a message to your Telegram channel to test!`,
                    { parse_mode: 'Markdown' }
                );
            }
        } else {
            console.error(`❌ Target group not found: ${process.env.WHATSAPP_GROUP_NAME}`);
            console.error('Make sure the group name is EXACT (case-sensitive)');
            
            if (process.env.TELEGRAM_ADMIN_ID) {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `❌ *Error: WhatsApp group not found!*\n\nLooking for: "${process.env.WHATSAPP_GROUP_NAME}"\n\nAvailable groups:\n${chats.filter(c => c.isGroup).map(c => `• ${c.name}`).join('\n')}\n\n⚠️ Check the exact group name in Render settings!`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
    });

    // Disconnected event
    whatsappClient.on('disconnected', (reason) => {
        console.log('❌ WhatsApp disconnected:', reason);
        isWhatsAppReady = false;
        targetChat = null;
        
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

    // Process all messages at once for maximum speed
    const messagesToProcess = messageQueue.splice(0, CONCURRENT_MESSAGES);
    
    try {
        // Send all messages in parallel
        const sendPromises = messagesToProcess.map(async (message, index) => {
            try {
                // Add small stagger to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, index * 10));
                await targetChat.sendMessage(message.content);
                console.log(`⚡ Sent [${index + 1}/${messagesToProcess.length}]: ${message.type} - ${message.content.substring(0, 50)}...`);
                return true;
            } catch (error) {
                console.error(`❌ Failed to send message: ${error.message}`);
                return false;
            }
        });
        
        await Promise.all(sendPromises);
        
    } catch (error) {
        console.error('Batch send error:', error);
    }

    isProcessing = false;
    
    // Immediately check for more messages
    if (messageQueue.length > 0) {
        setImmediate(processMessageQueue);
    }
}

// Fixed Telegram message handler
telegramBot.on(['message', 'channel_post'], async (ctx) => {
    // Handle both direct messages and channel posts
    const message = ctx.message || ctx.channelPost;
    
    if (!message) return;
    
    console.log(`📨 Received Telegram message: ${message.text || 'media'}`);
    
    // Check if WhatsApp is ready
    if (!isWhatsAppReady || !targetChat) {
        console.log('⚠️ WhatsApp not ready or target chat not found');
        return;
    }
    
    try {
        let content = '';
        let type = 'unknown';
        
        if (message.text) {
            content = message.text;
            type = 'text';
                } else if (message.photo) {
            const caption = message.caption || '';
            content = `📸 Photo${caption ? ': ' + caption : ''}`;
            type = 'photo';
        } else if (message.video) {
            const caption = message.caption || '';
            content = `🎥 Video${caption ? ': ' + caption : ''}`;
            type = 'video';
        } else if (message.document) {
            const fileName = message.document.file_name;
            const caption = message.caption || '';
            content = `📎 File: ${fileName}${caption ? '\n' + caption : ''}`;
            type = 'document';
        } else if (message.sticker) {
            content = `🎭 Sticker${message.sticker.emoji ? ': ' + message.sticker.emoji : ''}`;
            type = 'sticker';
        } else if (message.voice) {
            content = `🎤 Voice message (${message.voice.duration}s)`;
            type = 'voice';
        } else if (message.poll) {
            content = `📊 Poll: ${message.poll.question}\nOptions: ${message.poll.options.map(o => o.text).join(', ')}`;
            type = 'poll';
        }
        
        if (content) {
            console.log(`📥 Adding to queue: ${type} - ${content.substring(0, 50)}...`);
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
🎯 Target: ${process.env.WHATSAPP_GROUP_NAME || 'Not set'}
☁️ Mega: ${sessionManager.ready ? '✅ Connected' : '❌ Disconnected'}
⚡ Mode: Ultra-Fast (${CONCURRENT_MESSAGES} concurrent)
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

telegramBot.command('test', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        const testMessage = `🧪 Test message sent at ${new Date().toLocaleTimeString()}`;
        messageQueue.push({ type: 'test', content: testMessage });
        setImmediate(processMessageQueue);
        await ctx.reply('📤 Test message queued!');
    }
});

telegramBot.command('backup', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        await ctx.reply('💾 Backing up session to Mega...');
        const result = await sessionManager.uploadSession();
        await ctx.reply(result ? '✅ Backup successful!' : '❌ Backup failed!');
    }
});

// Keep-alive function
async function keepAlive() {
    if (process.env.RENDER_EXTERNAL_URL) {
        try {
            await axios.get(`${process.env.RENDER_EXTERNAL_URL}/health`, { timeout: 5000 });
            console.log('🏓 Keep-alive ping successful');
        } catch (error) {
            console.error('Keep-alive ping failed:', error.message);
        }
    }
}

// Backup session periodically
setInterval(async () => {
    if (isWhatsAppReady && sessionManager.ready) {
        await sessionManager.uploadSession();
    }
}, 3600000); // Every hour

// Ultra-fast queue processor - runs continuously
const runQueueProcessor = () => {
    if (!isProcessing && messageQueue.length > 0 && isWhatsAppReady && targetChat) {
        processMessageQueue();
    }
    setTimeout(runQueueProcessor, QUEUE_CHECK_INTERVAL);
};

// Keep-alive interval
setInterval(keepAlive, 4 * 60 * 1000); // Every 4 minutes

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down...');
    
    // Save session before shutdown
    if (isWhatsAppReady) {
        await sessionManager.uploadSession();
    }
    
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    await telegramBot.stop();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 SIGINT received...');
    
    if (isWhatsAppReady) {
        await sessionManager.uploadSession();
    }
    
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    await telegramBot.stop();
    process.exit(0);
});

// Start the application
async function start() {
    console.log('🚀 Starting Ultra-Fast WhatsApp-Telegram Bridge...');
    console.log(`⚡ Performance Mode: ${CONCURRENT_MESSAGES} concurrent messages`);
    console.log(`⚡ Message Delay: ${MESSAGE_DELAY}ms`);
    console.log(`⚡ Queue Check: Every ${QUEUE_CHECK_INTERVAL}ms`);
    
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

    // Start queue processor
    runQueueProcessor();

    // Initialize WhatsApp with delay to ensure Docker is ready
    setTimeout(() => {
        initWhatsApp().catch(error => {
            console.error('Failed to initialize WhatsApp:', error);
        });
    }, 2000);

    // Start Telegram bot with conflict handling
    try {
        await telegramBot.telegram.deleteWebhook({ drop_pending_updates: true });
        await telegramBot.launch({
            dropPendingUpdates: true,
            allowedUpdates: ['message', 'channel_post'] // Listen to both
        });
        console.log('🤖 Telegram bot started successfully');
        
        // Set bot commands
        await telegramBot.telegram.setMyCommands([
            { command: 'status', description: 'Check bot status' },
            { command: 'restart', description: 'Restart WhatsApp connection' },
            { command: 'test', description: 'Send test message' },
            { command: 'backup', description: 'Backup session to Mega' }
        ]);
        
    } catch (error) {
        if (error.message && error.message.includes('409')) {
            console.log('🔄 Clearing existing bot instance...');
            try {
                await new Promise(resolve => setTimeout(resolve, 2000));
                await telegramBot.launch({ dropPendingUpdates: true });
                console.log('🤖 Telegram bot started after retry');
            } catch (retryError) {
                console.error('Failed to start Telegram bot:', retryError);
            }
        } else {
            console.error('Telegram bot error:', error);
        }
    }
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
