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

// Environment variables
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const SESSION_DATA = process.env.SESSION_DATA;
const GROUP_NAME = 'savings safari';

// Baileys WhatsApp
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

// Global variables
let sock = null;
let isReady = false;
let targetGroupId = null;
const messageQueue = [];
let isProcessing = false;
let store;

const bot = new Telegraf(BOT_TOKEN);

// Session management functions
async function saveSessionToEnv() {
    try {
        const authFolder = './auth_session';
        const files = await fs.readdir(authFolder);
        const sessionData = {};
        
        for (const file of files) {
            const content = await fs.readFile(path.join(authFolder, file), 'utf-8');
            sessionData[file] = JSON.parse(content);
        }
        
        const sessionString = Buffer.from(JSON.stringify(sessionData)).toString('base64');
        
        console.log('\n=====================================');
        console.log('IMPORTANT: Add this to Render environment variables:');
        console.log(`SESSION_DATA=${sessionString}`);
        console.log('=====================================\n');
        
        // Send first 1000 chars to Telegram
        if (ADMIN_ID) {
            await bot.telegram.sendMessage(ADMIN_ID, 
                `💾 *Session saved! Add to environment:*\n\n` +
                `\`SESSION_DATA=${sessionString.substring(0, 500)}...\`\n\n` +
                `⚠️ Check server logs for full session string`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('Session save error:', error);
    }
}

async function restoreSessionFromEnv() {
    if (!SESSION_DATA) return false;
    
    try {
        const sessionData = JSON.parse(Buffer.from(SESSION_DATA, 'base64').toString());
        const authFolder = './auth_session';
        
        await fs.mkdir(authFolder, { recursive: true });
        
        for (const [filename, content] of Object.entries(sessionData)) {
            await fs.writeFile(path.join(authFolder, filename), JSON.stringify(content));
        }
        
        console.log('✅ Session restored from environment');
        return true;
    } catch (error) {
        console.error('Session restore error:', error);
        return false;
    }
}

async function initializeWhatsApp() {
    console.log('Initializing WhatsApp...');
    
    // Try to restore session first
    const sessionRestored = await restoreSessionFromEnv();
    if (sessionRestored) {
        console.log('Using restored session - No QR scan needed!');
    }
    
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
    const { version } = await fetchLatestBaileysVersion();
    
    store = makeInMemoryStore({
        logger: pino().child({ level: 'silent', stream: 'store' })
    });
    
    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ['WhatsApp Forwarder', 'Chrome', '110.0.0'],
        syncFullHistory: false,
        getMessage: async () => null,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: false,
        store
    });
    
    store?.bind(sock.ev);
    
    // Save credentials
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // Save to environment after authentication
        setTimeout(saveSessionToEnv, 5000);
    });
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n=== FIRST TIME SETUP - SCAN QR CODE ===');
            
            const QRCode = require('qrcode');
            try {
                const qrBuffer = await QRCode.toBuffer(qr, {
                    width: 512,
                    margin: 2
                });
                
                await bot.telegram.sendPhoto(ADMIN_ID, { source: qrBuffer }, {
                    caption: '📱 *ONE-TIME SETUP*\n\n' +
                            'Scan this QR code in WhatsApp:\n\n' +
                            '1. Open WhatsApp on your phone\n' +
                            '2. Tap Menu or Settings\n' +
                            '3. Tap "Linked Devices"\n' +
                            '4. Tap "Link a Device"\n' +
                            '5. Scan this QR code\n\n' +
                            '✅ After this, bot runs forever!',
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                await bot.telegram.sendMessage(ADMIN_ID, '📱 QR Code generated - check console');
            }
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('Connection lost, reconnecting...');
                setTimeout(initializeWhatsApp, 3000);
            } else {
                console.log('Logged out from WhatsApp');
                if (ADMIN_ID) {
                    await bot.telegram.sendMessage(ADMIN_ID, '❌ Logged out! Clear SESSION_DATA and restart.');
                }
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected!');
            isReady = true;
            
            await setupTargetGroup();
            processQueuedMessages();
            
            // Keep connection alive
            setInterval(() => {
                if (sock && isReady) {
                    sock.sendPresenceUpdate('available');
                }
            }, 30000);
        }
    });
    
    // Error handling
    sock.ev.on('error', (error) => {
        console.error('WhatsApp error:', error);
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
                `👤 Members: ${target.participants.length}\n` +
                `📨 Queue: ${messageQueue.length} messages\n` +
                `⚡ Speed: Ultra-fast forwarding\n\n` +
                `✅ No manual intervention needed!`,
                { parse_mode: 'Markdown' }
            );
        } else {
            const availableGroups = groupList
                .map(g => `• ${g.subject}`)
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
    if (isProcessing || messageQueue.length === 0) return;
    
    isProcessing = true;
    
    while (messageQueue.length > 0 && isReady && targetGroupId) {
        const msg = messageQueue.shift();
        
        try {
            await sock.sendMessage(targetGroupId, msg.content);
            console.log(`✅ Sent queued message (${Date.now() - msg.timestamp}ms delay)`);
        } catch (error) {
            console.error('Send error:', error);
            messageQueue.unshift(msg);
            break;
        }
        
        // Minimal delay for ultra-fast sending
        if (messageQueue.length > 0) {
            await new Promise(r => setTimeout(r, 50));
        }
    }
    
    isProcessing = false;
}

// Fast file download
async function downloadFile(fileId) {
    try {
        const file = await bot.telegram.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 100 * 1024 * 1024,
            headers: {
                'Connection': 'keep-alive'
            }
        });
        
        return Buffer.from(response.data);
    } catch (error) {
        console.error('Download error:', error);
        throw error;
    }
}

// Ultra-fast message forwarding
bot.on('channel_post', async (ctx) => {
    const startTime = Date.now();
    const post = ctx.channelPost;
    const text = post.text || post.caption || '';
    
    // Queue if not ready
    if (!isReady || !targetGroupId) {
        messageQueue.push({
            content: { text: text || '[Media message]' },
            timestamp: startTime
        });
        console.log('📥 Message queued');
        return;
    }
    
    try {
        if (post.photo) {
            // Download and send photo
            const photoId = post.photo[post.photo.length - 1].file_id;
            const buffer = await downloadFile(photoId);
            await sock.sendMessage(targetGroupId, {
                image: buffer,
                caption: text
            });
            console.log(`✅ Photo sent in ${Date.now() - startTime}ms`);
            
        } else if (post.video) {
            // Download and send video
            const buffer = await downloadFile(post.video.file_id);
            await sock.sendMessage(targetGroupId, {
                video: buffer,
                caption: text
            });
            console.log(`✅ Video sent in ${Date.now() - startTime}ms`);
            
        } else if (post.document) {
            // Download and send document
            const buffer = await downloadFile(post.document.file_id);
            await sock.sendMessage(targetGroupId, {
                document: buffer,
                mimetype: post.document.mime_type,
                fileName: post.document.file_name,
                caption: text
            });
            console.log(`✅ Document sent in ${Date.now() - startTime}ms`);
            
        } else if (text) {
            // Send text message
            await sock.sendMessage(targetGroupId, { text });
            console.log(`✅ Text sent in ${Date.now() - startTime}ms`);
        }
    } catch (error) {
        console.error('Forward error:', error);
        messageQueue.push({
            content: { text: text || '[Failed message]' },
            timestamp: startTime
        });
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
        `🤖 WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}\n` +
        `👥 Group: ${targetGroupId ? '✅ Found' : '❌ Not found'}\n` +
        `📨 Queue: ${messageQueue.length} messages\n` +
        `⏱️ Uptime: ${hours}h ${minutes}m\n` +
        `💾 Session: ${SESSION_DATA ? '✅ Loaded' : '❌ Not set'}\n` +
        `🚀 Mode: Ultra-fast forwarding`,
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

bot.command('queue', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    if (messageQueue.length === 0) {
        await ctx.reply('📨 No messages in queue');
    } else {
        await ctx.reply(`📨 Queue: ${messageQueue.length} messages\n\n` +
            messageQueue.slice(0, 5).map((m, i) => 
                `${i + 1}. ${m.content.text?.substring(0, 50)}...`
            ).join('\n')
        );
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

bot.command('session', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    if (SESSION_DATA) {
        await ctx.reply('✅ Session is set in environment variables');
    } else {
        await saveSessionToEnv();
        await ctx.reply('📤 Session saved! Check logs for SESSION_DATA');
    }
});

// Auto-ping to keep Render alive
const keepAlive = () => {
    // Ping every 5 minutes
    setInterval(async () => {
        if (process.env.RENDER_EXTERNAL_URL) {
            try {
                await axios.get(process.env.RENDER_EXTERNAL_URL + '/health', { timeout: 10000 });
                console.log('Keep-alive ping sent');
            } catch (error) {
                console.error('Keep-alive error:', error.message);
            }
        }
        
        // Keep WhatsApp connection alive
        if (sock && isReady) {
            try {
                await sock.sendPresenceUpdate('available');
            } catch (error) {}
        }
    }, 5 * 60 * 1000); // 5 minutes
    
    // More aggressive ping for first 30 minutes
    const aggressivePing = setInterval(async () => {
        if (process.env.RENDER_EXTERNAL_URL) {
            try {
                await axios.get(process.env.RENDER_EXTERNAL_URL + '/health', { timeout: 5000 });
            } catch (error) {}
        }
    }, 60 * 1000); // Every minute
    
    // Stop aggressive ping after 30 minutes
    setTimeout(() => clearInterval(aggressivePing), 30 * 60 * 1000);
};

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't send Telegram messages during startup errors
    if (error.code === 'EADDRINUSE') {
        console.error('Port already in use, this is likely a Render deployment issue');
        // Don't exit on port errors during deployment
        return;
    }
    if (ADMIN_ID && bot && isReady) {
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ Error: ${error.message}\nRestarting...`).catch(() => {});
    }
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

// Main startup function
async function startBot() {
    console.log('🚀 Starting WhatsApp-Telegram Forwarder...');
    console.log(`📍 Port: ${PORT}`);
    console.log(`💾 Session: ${SESSION_DATA ? 'Found' : 'Not set'}`);
    
    try {
        // Launch Telegram bot with polling (more reliable than webhook)
        await bot.launch({
            allowedUpdates: ['message', 'channel_post', 'callback_query']
        });
        
        console.log('✅ Telegram bot started');
        
        // Initialize WhatsApp after 2 seconds
        setTimeout(initializeWhatsApp, 2000);
        
        // Start keep-alive mechanism
        keepAlive();
        
        // Notify admin
        if (ADMIN_ID) {
            await bot.telegram.sendMessage(ADMIN_ID, 
                '🚀 *Bot Deployed Successfully!*\n\n' +
                '⏳ Initializing WhatsApp...\n' +
                `💾 Session: ${SESSION_DATA ? 'Will restore automatically' : 'First time - QR scan needed'}\n` +
                '⚡ Ultra-fast forwarding enabled\n' +
                '🔄 Auto-ping active',
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('Startup error:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    bot.stop('SIGINT');
    if (sock) sock.end();
    server.close();
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    bot.stop('SIGTERM');
    if (sock) sock.end();
    server.close();
    process.exit(0);
});

// Start the bot
startBot().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
});
