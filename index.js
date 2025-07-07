Yes, you can store the session directly! Here's how to implement it using environment variables (most secure approach):

## Option 1: Store Session as Base64 in Environment Variable

Here's the modified code with built-in session storage:

```javascript
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Telegraf } = require('telegraf');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
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

// Message queue
const messageQueue = [];
let isProcessing = false;

// Performance settings
const CONCURRENT_MESSAGES = 10;
const MESSAGE_DELAY = 25;
const QUEUE_CHECK_INTERVAL = 50;

// Session Manager for Base64 Storage
class SessionManager {
    constructor() {
        this.sessionPath = './whatsapp_session';
    }

    async saveSessionToBase64() {
        try {
            console.log('📦 Converting session to Base64...');
            
            // Create zip of session
            const zipPath = '/tmp/session_backup.zip';
            await this.createZip(this.sessionPath, zipPath);
            
            // Read zip and convert to base64
            const zipBuffer = await fs.readFile(zipPath);
            const base64Session = zipBuffer.toString('base64');
            
            // Clean up
            await fs.unlink(zipPath);
            
            console.log('✅ Session converted to Base64');
            console.log('📋 Copy this to your WHATSAPP_SESSION environment variable:');
            console.log('=====================================');
            console.log(base64Session);
            console.log('=====================================');
            
            // Also send to Telegram admin
            if (process.env.TELEGRAM_ADMIN_ID) {
                await telegramBot.telegram.sendDocument(
                    process.env.TELEGRAM_ADMIN_ID,
                    {
                        source: Buffer.from(base64Session),
                        filename: 'session_base64.txt'
                    },
                    {
                        caption: '📦 *WhatsApp Session Base64*\n\nSave this to `WHATSAPP_SESSION` environment variable in Render!'
                    }
                );
            }
            
            return base64Session;
        } catch (error) {
            console.error('❌ Failed to convert session:', error);
            return null;
        }
    }

    async loadSessionFromBase64() {
        if (!process.env.WHATSAPP_SESSION) {
            console.log('📭 No saved session found in environment');
            return false;
        }

        try {
            console.log('📥 Loading session from environment variable...');
            
            // Convert base64 back to buffer
            const zipBuffer = Buffer.from(process.env.WHATSAPP_SESSION, 'base64');
            const zipPath = '/tmp/session_restore.zip';
            
            // Write zip file
            await fs.writeFile(zipPath, zipBuffer);
            
            // Clean existing session
            await fs.rm(this.sessionPath, { recursive: true, force: true });
            
            // Extract session
            await extract(zipPath, { dir: path.resolve('./') });
            await fs.unlink(zipPath);
            
            console.log('✅ Session restored from environment variable');
            return true;
        } catch (error) {
            console.error('❌ Failed to restore session:', error);
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
        queueSize: messageQueue.length,
        sessionStored: !!process.env.WHATSAPP_SESSION
    });
});

// Initialize WhatsApp Client
async function initWhatsApp() {
    console.log('🔄 Initializing WhatsApp...');
    
    // Try to load session from environment variable
    await sessionManager.loadSessionFromBase64();
    
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
                    `📱 *WhatsApp QR Code*\n\nScan this QR code in WhatsApp > Linked Devices:\n\n\`\`\`\n${qr}\n\`\`\`\n\n⚠️ After scanning, use /savesession to save permanently!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.error('Error sending QR to Telegram:', error);
            }
        }
    });

    // Authentication success
    whatsappClient.on('authenticated', async () => {
        console.log('🔐 WhatsApp authenticated successfully!');
        
        // Automatically save session after authentication
        if (!process.env.WHATSAPP_SESSION) {
            setTimeout(async () => {
                console.log('🔄 Auto-saving session...');
                await sessionManager.saveSessionToBase64();
            }, 5000);
        }
    });

    // Ready event
    whatsappClient.on('ready', async () => {
        console.log('✅ WhatsApp client is ready!');
        isWhatsAppReady = true;
        
        const chats = await whatsappClient.getChats();
        
        // Find target chat
        targetChat = chats.find(chat => 
            chat.name && chat.name.toLowerCase() === process.env.WHATSAPP_GROUP_NAME.toLowerCase()
        );
        
        if (targetChat) {
            console.log(`✅ Found target group: ${process.env.WHATSAPP_GROUP_NAME}`);
            
            if (process.env.TELEGRAM_ADMIN_ID) {
                await telegramBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_ID,
                    `✅ *Bot is ready!*\n\n📱 WhatsApp: Connected\n👥 Target Group: ${process.env.WHATSAPP_GROUP_NAME}\n💾 Session: ${process.env.WHATSAPP_SESSION ? 'Loaded from env' : 'New session'}\n🚀 Ready to forward messages!`,
                    { parse_mode: 'Markdown' }
                );
            }
        } else {
            console.error(`❌ Target group not found: ${process.env.WHATSAPP_GROUP_NAME}`);
            console.log('Available groups:');
            chats.filter(c => c.isGroup).forEach(chat => {
                console.log(`- ${chat.name}`);
            });
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
    const messagesToProcess = messageQueue.splice(0, CONCURRENT_MESSAGES);
    
    try {
        const sendPromises = messagesToProcess.map(async (message, index) => {
            try {
                await new Promise(resolve => setTimeout(resolve, index * 10));
                await targetChat.sendMessage(message.content);
                console.log(`⚡ Sent: ${message.type}`);
                return true;
            } catch (error) {
                console.error(`❌ Failed: ${error.message}`);
                return false;
            }
        });
        
        await Promise.all(sendPromises);
    } catch (error) {
        console.error('Batch send error:', error);
    }

    isProcessing = false;
    
    if (messageQueue.length > 0) {
        setImmediate(processMessageQueue);
    }
}

// Telegram message handler
telegramBot.on(['message', 'channel_post'], async (ctx) => {
    const message = ctx.message || ctx.channelPost;
    if (!message) return;
    
    if (!isWhatsAppReady || !targetChat) {
        console.log('⚠️ WhatsApp not ready');
        return;
    }
    
    try {
        let content = '';
        let type = 'unknown';
        
        if (message.text) {
            content = message.text;
            type = 'text';
        } else if (message.photo) {
            content = `📸 ${message.caption || 'Photo'}`;
            type = 'photo';
        } else if (message.video) {
            content = `🎥 ${message.caption || 'Video'}`;
            type = 'video';
        } else if (message.document) {
            content = `📎 ${message.document.file_name}${message.caption ? '\n' + message.caption : ''}`;
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
telegramBot.command('savesession', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        await ctx.reply('💾 Saving session...');
        const base64 = await sessionManager.saveSessionToBase64();
        if (base64) {
            await ctx.reply('✅ Session saved! Check the file above and add to WHATSAPP_SESSION env variable.');
        } else {
            await ctx.reply('❌ Failed to save session.');
        }
    }
});

telegramBot.command('status', async (ctx) => {
    if (ctx.from && ctx.from.id.toString() === process.env.TELEGRAM_ADMIN_ID) {
        const status = `
🤖 *Bot Status*

📱 WhatsApp: ${isWhatsAppReady ? '✅ Connected' : '❌ Disconnected'}
💬 Queue: ${messageQueue.length} messages
⏱ Uptime: ${Math.floor(process.uptime() / 60)} minutes
🎯 Target: ${process.env.WHATSAPP_GROUP_NAME}
💾 Session: ${process.env.WHATSAPP_SESSION ? '✅ Stored' : '❌ Not stored'}
⚡ Mode: Ultra-Fast
        `;
        await ctx.reply(status, { parse_mode: 'Markdown' });
    }
});

// Keep-alive and other functions remain the same...

// Start the application
async function start() {
    console.
