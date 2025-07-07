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

// Performance settings for deals
const CONCURRENT_MESSAGES = 5;
const MESSAGE_DELAY = 50;
const QUEUE_CHECK_INTERVAL = 100;

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
        targetChat = chats.find(chat => chat.name === process.env.WHATSAPP_GROUP_NAME);
        
        if (targetChat) {
            console.log(`✅ Found target group: ${process.env.WHATSAPP_GROUP_NAME}`);
            
            if (process.env.TELEGRAM_ADMIN_ID) {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `✅ *Bot is ready!*\n\n📱 WhatsApp: Connected\n👥 Target Group: ${process.env.WHATSAPP_GROUP_NAME}\n☁️ Session: Backed up to Mega\n🚀 Ultra-fast mode enabled!`,
                    { parse_mode: 'Markdown' }
                );
            }
        } else {
            console.error(`❌ Target group not found: ${process.env.WHATSAPP_GROUP_NAME}`);
            
            // List available chats
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

    const messagesToProcess = messageQueue.splice(0, CONCURRENT_MESSAGES);
    
    try {
        await Promise.all(
            messagesToProcess.map(async (message) => {
                try {
                    await targetChat.sendMessage(message.content);
                    console.log(`⚡ Sent: ${message.type}`);
                } catch (error) {
                    console.error(`❌ Failed: ${error.message}`);
                }
            })
        );
        
        if (messageQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
        }
    } catch (error) {
        console.error('Batch send error:', error);
    }

    isProcessing = false;
    
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
        }
        
        if (content) {
            messageQueue.push({ type, content });
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
☁️ Mega: ${sessionManager.ready ? '✅ Connected' : '❌ Disconnected'}
⚡ Mode: Ultra-Fast
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

// Keep-alive function
async function keepAlive() {
    if (process.env.RENDER_EXTERNAL_URL) {
        try {
            await axios.get(`${process.env.RENDER_EXTERNAL_URL}/health`);
            console.log('🏓 Keep-alive ping successful');
        } catch (error) {
            console.error('Keep-alive ping failed:', error.message);
        }
    }
}

// Backup session periodically
setInterval(async () => {
    if (isWhatsAppReady) {
        await sessionManager.uploadSession();
    }
}, 3600000); // Every hour

// Ultra-fast queue processor
setInterval(() => {
    if (!isProcessing && messageQueue.length > 0) {
        processMessageQueue();
    }
}, QUEUE_CHECK_INTERVAL);

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

    // Start Telegram bot with conflict handling
    try {
        await telegramBot.telegram.deleteWebhook({ drop_pending_updates: true });
        await telegramBot.launch({
            dropPendingUpdates: true
        });
        console.log('🤖 Telegram bot started successfully');
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
