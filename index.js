const express = require('express');
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Express setup for Render
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.json({ status: 'running', uptime: process.uptime() }));
app.get('/health', (req, res) => res.status(200).send('OK'));

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// Bot configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const GROUP_NAME = 'savings safari';

// Baileys WhatsApp Client
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

// Global variables
let sock = null;
let isReady = false;
let targetGroupId = null;
const messageQueue = [];
let store;

const bot = new Telegraf(BOT_TOKEN);

// Session management with cloud backup
const SESSION_BACKUP_URL = process.env.SESSION_BACKUP_URL || 'https://api.jsonbin.io/v3/b/YOUR_BIN_ID';
const SESSION_API_KEY = process.env.SESSION_API_KEY || 'YOUR_API_KEY';

async function saveSessionToCloud(sessionData) {
    try {
        if (!SESSION_BACKUP_URL || SESSION_BACKUP_URL.includes('YOUR_')) return;
        
        await axios.put(SESSION_BACKUP_URL, sessionData, {
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': SESSION_API_KEY
            }
        });
        console.log('Session backed up to cloud');
    } catch (error) {
        console.error('Cloud backup error:', error.message);
    }
}

async function loadSessionFromCloud() {
    try {
        if (!SESSION_BACKUP_URL || SESSION_BACKUP_URL.includes('YOUR_')) return null;
        
        const response = await axios.get(SESSION_BACKUP_URL + '/latest', {
            headers: {
                'X-Master-Key': SESSION_API_KEY
            }
        });
        
        console.log('Session restored from cloud');
        return response.data.record;
    } catch (error) {
        console.error('Cloud restore error:', error.message);
        return null;
    }
}

async function initializeWhatsApp() {
    // Try to restore session from cloud first
    const cloudSession = await loadSessionFromCloud();
    
    const authFolder = './auth_session';
    
    // If cloud session exists, restore it locally
    if (cloudSession) {
        await fs.mkdir(authFolder, { recursive: true });
        for (const [filename, content] of Object.entries(cloudSession)) {
            await fs.writeFile(path.join(authFolder, filename), JSON.stringify(content));
        }
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    // In-memory store for faster performance
    store = makeInMemoryStore({
        logger: pino().child({ level: 'silent', stream: 'store' })
    });
    
    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ['WhatsApp Bot', 'Chrome', '110.0'],
        syncFullHistory: false,
        getMessage: async () => null,
        generateHighQualityLinkPreview: false,
        store
    });
    
    store?.bind(sock.ev);
    
    // Save credentials and backup to cloud
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        
        // Backup to cloud
        try {
            const files = await fs.readdir(authFolder);
            const sessionData = {};
            
            for (const file of files) {
                const content = await fs.readFile(path.join(authFolder, file), 'utf-8');
                sessionData[file] = JSON.parse(content);
            }
            
            await saveSessionToCloud(sessionData);
        } catch (error) {
            console.error('Session backup error:', error);
        }
    });
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n=== FIRST TIME SETUP ===');
            console.log('Scan this QR code with WhatsApp (Settings > Linked Devices)');
            console.log('This is ONE TIME ONLY - Session will be saved permanently\n');
            
            // Generate QR code image and send to Telegram
            const QRCode = require('qrcode');
            try {
                const qrBuffer = await QRCode.toBuffer(qr, {
                    width: 400,
                    margin: 2,
                    color: { dark: '#000000', light: '#FFFFFF' }
                });
                
                await bot.telegram.sendPhoto(ADMIN_ID, { source: qrBuffer }, {
                    caption: '📱 *ONE TIME SETUP*\n\nScan this QR code in WhatsApp:\n\n' +
                            '1. Open WhatsApp\n' +
                            '2. Go to Settings → Linked Devices\n' +
                            '3. Tap "Link a Device"\n' +
                            '4. Scan this code\n\n' +
                            '✅ After this, bot will run forever!',
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                await bot.telegram.sendMessage(ADMIN_ID, 'Please check console for QR code');
            }
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                console.log('Logged out from WhatsApp');
                await bot.telegram.sendMessage(ADMIN_ID, '❌ WhatsApp logged out! Please re-scan QR code.');
            } else if (shouldReconnect) {
                console.log('Connection lost, reconnecting...');
                setTimeout(initializeWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected successfully!');
            isReady = true;
            
            await setupTargetGroup();
            processQueuedMessages();
            
            // Keep alive
            setInterval(() => {
                sock.sendPresenceUpdate('available');
            }, 30000);
        }
    });
    
    // Handle incoming messages to keep connection alive
    sock.ev.on('messages.upsert', async ({ messages }) => {
        // Just acknowledge to keep connection active
    });
    
    // Handle group updates
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        // Keep group info updated
    });
}

async function setupTargetGroup() {
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups);
        
        const target = groupList.find(g => 
            g.subject && g.subject.toLowerCase().includes(GROUP_NAME.toLowerCase())
        );
        
        if (target) {
            targetGroupId = target.id;
            console.log(`✅ Found group: ${target.subject}`);
            
            await bot.telegram.sendMessage(ADMIN_ID,
                `🎉 *Bot Ready!*\n\n` +
                `📱 WhatsApp: Connected\n` +
                `👥 Group: ${target.subject}\n` +
                `👤 Participants: ${target.participants.length}\n` +
                `📨 Queued: ${messageQueue.length} messages\n\n` +
                `✅ Bot will now run forever without manual intervention!`,
                { parse_mode: 'Markdown' }
            );
        } else {
            const availableGroups = groupList
                .map(g => `• ${g.subject}`)
                .filter(name => name)
                .slice(0, 10)
                .join('\n');
                
            await bot.telegram.sendMessage(ADMIN_ID,
                `⚠️ Group "${GROUP_NAME}" not found\n\n` +
                `Available groups:\n${availableGroups}`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('Group setup error:', error);
    }
}

async function processQueuedMessages() {
    while (messageQueue.length > 0 && isReady && targetGroupId) {
        const msg = messageQueue.shift();
        
        try {
            await sock.sendMessage(targetGroupId, msg.content);
            console.log(`✅ Sent queued message (${Date.now() - msg.timestamp}ms old)`);
        } catch (error) {
            console.error('Send error:', error);
            messageQueue.unshift(msg);
            break;
        }
        
        await new Promise(r => setTimeout(r, 100));
    }
}

// Telegram message handler
bot.on('channel_post', async (ctx) => {
    const post = ctx.channelPost;
    const text = post.text || post.caption || '';
    
    if (!text) return;
    
    const message = {
        content: { text },
        timestamp: Date.now()
    };
    
    if (!isReady || !targetGroupId) {
        messageQueue.push(message);
        console.log('📥 Message queued');
        return;
    }
    
    try {
        await sock.sendMessage(targetGroupId, { text });
        console.log(`✅ Forwarded in ${Date.now() - message.timestamp}ms`);
    } catch (error) {
        console.error('Forward error:', error);
        messageQueue.push(message);
    }
});

// Admin commands
bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    await ctx.reply(
        `📊 *Bot Status*\n\n` +
        `🤖 WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}\n` +
        `👥 Group: ${targetGroupId ? '✅ Found' : '❌ Not found'}\n` +
        `📨 Queue: ${messageQueue.length} messages\n` +
        `⏱️ Uptime: ${hours}h ${minutes}m\n` +
        `💾 Session: ${await fs.access('./auth_session').then(() => '✅ Saved').catch(() => '❌ Not found')}\n` +
        `☁️ Cloud Backup: ${SESSION_BACKUP_URL.includes('YOUR_') ? '❌ Not configured' : '✅ Active'}`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('restart', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply('♻️ Restarting WhatsApp connection...');
    isReady = false;
    if (sock) {
        sock.ws.close();
    }
    setTimeout(initializeWhatsApp, 3000);
});

bot.command('backup', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    try {
        const authFolder = './auth_session';
        const files = await fs.readdir(authFolder);
        const sessionData = {};
        
        for (const file of files) {
            const content = await fs.readFile(path.join(authFolder, file), 'utf-8');
            sessionData[file] = JSON.parse(content);
        }
        
        await saveSessionToCloud(sessionData);
        await ctx.reply('✅ Session backed up to cloud successfully!');
    } catch (error) {
        await ctx.reply(`❌ Backup failed: ${error.message}`);
    }
});

bot.command('groups', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    if (!isReady) {
        await ctx.reply('❌ WhatsApp not connected');
        return;
    }
    
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups)
            .map((g, i) => `${i + 1}. ${g.subject} (${g.participants.length} members)`)
            .slice(0, 20)
            .join('\n');
            
        await ctx.reply(`📱 *WhatsApp Groups:*\n\n${groupList}`, { parse_mode: 'Markdown' });
    } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

// Auto-restart on errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (ADMIN_ID) {
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ Error: ${error.message}\nRestarting...`);
    }
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

// Keep alive mechanism
const keepAlive = () => {
    setInterval(async () => {
        if (process.env.RENDER_EXTERNAL_URL) {
            try {
                await axios.get(process.env.RENDER_EXTERNAL_URL + '/health');
            } catch (error) {}
        }
        
        // Keep WhatsApp alive
        if (isReady && sock) {
            try {
                await sock.sendPresenceUpdate('available');
            } catch (error) {}
        }
    }, 4 * 60 * 1000);
};

// Initialize everything
async function startBot() {
    console.log('🚀 Starting WhatsApp-Telegram Bot...');
    
    // Launch Telegram bot
    await bot.launch();
    console.log('✅ Telegram bot started');
    
    // Initialize WhatsApp
    setTimeout(initializeWhatsApp, 2000);
    
    // Start keep-alive
    keepAlive();
    
    // Notify admin
    if (ADMIN_ID) {
        await bot.telegram.sendMessage(ADMIN_ID, 
            '🚀 *Bot Started Successfully!*\n\n' +
            '⏳ Initializing WhatsApp...\n' +
            '💾 Session will be restored if available\n' +
            '📱 Otherwise, one-time QR scan required',
            { parse_mode: 'Markdown' }
        );
    }
}

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('Shutting down...');
    bot.stop('SIGINT');
    if (sock) sock.ws.close();
    server.close();
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('Shutting down...');
    bot.stop('SIGTERM');
    if (sock) sock.ws.close();
    server.close();
    process.exit(0);
});

// Start the bot
startBot().catch(console.error);
    
    
