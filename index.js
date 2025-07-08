const express = require('express');
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Express setup for Render
const app = express();
const PORT = process.env.PORT || 3000;

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

// Validate environment variables
if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set!');
    process.exit(1);
}

if (!ADMIN_ID) {
    console.error('❌ TELEGRAM_ADMIN_ID is not set!');
    process.exit(1);
}

// Baileys WhatsApp
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

// Global variables
let sock = null;
let isReady = false;
let targetGroupId = null;
const messageQueue = [];
let isProcessing = false;
let store;
let qrRetries = 0;
let initAttempts = 0;

// Initialize Telegram bot
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
        
        // Save to file for backup
        await fs.writeFile('session_backup.txt', `SESSION_DATA=${sessionString}`);
        
        // Send to Telegram admin in chunks
        try {
            const chunkSize = 4000;
            const chunks = [];
            
            for (let i = 0; i < sessionString.length; i += chunkSize) {
                chunks.push(sessionString.substring(i, i + chunkSize));
            }
            
            await bot.telegram.sendMessage(ADMIN_ID, 
                `💾 *Session Saved Successfully!*\n\n` +
                `Total parts: ${chunks.length}\n\n` +
                `⚠️ *IMPORTANT: Copy all parts and combine them into one SESSION_DATA string*`,
                { parse_mode: 'Markdown' }
            );
            
            for (let i = 0; i < chunks.length; i++) {
                await bot.telegram.sendMessage(ADMIN_ID, 
                    `📄 *Part ${i + 1}/${chunks.length}:*\n\n\`\`\`\n${chunks[i]}\n\`\`\``,
                    { parse_mode: 'Markdown' }
                );
                await delay(1000); // Small delay between messages
            }
            
            await bot.telegram.sendMessage(ADMIN_ID, 
                `✅ *All parts sent!*\n\nCombine all parts into one string and add to Render environment variables.`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Failed to send session to Telegram:', error);
        }
    } catch (error) {
        console.error('Session save error:', error);
    }
}

async function restoreSessionFromEnv() {
    if (!SESSION_DATA) {
        console.log('❌ No SESSION_DATA found in environment');
        return false;
    }
    
    try {
        console.log('📂 Restoring session from environment...');
        const sessionData = JSON.parse(Buffer.from(SESSION_DATA, 'base64').toString());
        const authFolder = './auth_session';
        
        await fs.mkdir(authFolder, { recursive: true });
        
        for (const [filename, content] of Object.entries(sessionData)) {
            await fs.writeFile(path.join(authFolder, filename), JSON.stringify(content));
        }
        
        console.log('✅ Session restored successfully!');
        return true;
    } catch (error) {
        console.error('❌ Session restore error:', error);
        return false;
    }
}

async function initializeWhatsApp() {
    try {
        initAttempts++;
        console.log(`\n🔄 WhatsApp initialization attempt #${initAttempts}`);
        
        // Clean up previous connection
        if (sock) {
            sock.end();
            sock = null;
        }
        
        isReady = false;
        
        // Restore session if available
        const sessionRestored = await restoreSessionFromEnv();
        if (sessionRestored) {
            console.log('✅ Session restored - Auto-connecting...');
            await bot.telegram.sendMessage(ADMIN_ID, '📱 Session found! Connecting to WhatsApp...').catch(console.error);
        } else {
            console.log('⚠️ No session - QR scan required');
            await bot.telegram.sendMessage(ADMIN_ID, '📱 First time setup - QR code coming...').catch(console.error);
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
            browser: ['WhatsApp Forwarder', 'Chrome', '120.0.0'],
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000,
            qrTimeout: 60000,
            getMessage: async () => null,
            store
        });
        
        if (store) {
            store.bind(sock.ev);
        }
        
        // Handle credentials update
        sock.ev.on('creds.update', async () => {
            console.log('📱 Saving credentials...');
            await saveCreds();
            // Delay before saving to ensure all files are written
            setTimeout(() => {
                console.log('💾 Backing up session...');
                saveSessionToEnv();
            }, 3000);
        });
        
        // Connection update handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrRetries++;
                console.log(`\n📱 QR CODE GENERATED (Attempt ${qrRetries})`);
                
                try {
                    const qrBuffer = await QRCode.toBuffer(qr, {
                        width: 512,
                        margin: 2,
                        scale: 8,
                        errorCorrectionLevel: 'M',
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });
                    
                    await bot.telegram.sendPhoto(ADMIN_ID, { source: qrBuffer }, {
                        caption: `📱 *WhatsApp QR Code*\n\n` +
                                `⚠️ *SCAN NOW - Expires in 60 seconds!*\n\n` +
                                `Steps:\n` +
                                `1️⃣ Open WhatsApp\n` +
                                `2️⃣ Tap Menu ⋮ → Linked Devices\n` +
                                `3️⃣ Tap "Link a Device"\n` +
                                `4️⃣ Scan this QR code\n\n` +
                                `Attempt: ${qrRetries}/3`,
                        parse_mode: 'Markdown'
                    });
                    
                    console.log('✅ QR Code sent to Telegram');
                } catch (error) {
                    console.error('❌ Failed to send QR:', error);
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const reason = lastDisconnect?.error?.output?.statusCode;
                
                console.log(`❌ Connection closed: ${reason}`);
                
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting in 3 seconds...');
                    setTimeout(initializeWhatsApp, 3000);
                } else {
                    console.log('❌ Logged out - manual intervention required');
                    await bot.telegram.sendMessage(ADMIN_ID, 
                        '❌ *WhatsApp Logged Out*\n\n' +
                        'Clear SESSION_DATA and restart the bot.',
                        { parse_mode: 'Markdown' }
                    ).catch(console.error);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp connected!');
                isReady = true;
                qrRetries = 0;
                initAttempts = 0;
                
                // Setup group and process queue
                await setupTargetGroup();
                
                if (messageQueue.length > 0) {
                    console.log(`📨 Processing ${messageQueue.length} queued messages...`);
                    setTimeout(processQueuedMessages, 1000);
                }
                
                // Keep alive interval
                setInterval(() => {
                    if (sock && isReady) {
                        sock.sendPresenceUpdate('available').catch(() => {});
                    }
                }, 30000);
            }
        });
        
        // Handle errors
        sock.ev.on('error', (error) => {
            console.error('WhatsApp error:', error);
        });
        
        // Handle incoming messages (optional)
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                console.log('📩 New WhatsApp message received');
            }
        });
        
    } catch (error) {
        console.error('❌ WhatsApp init failed:', error);
        
        if (initAttempts < 5) {
            console.log(`🔄 Retrying in 5 seconds... (${initAttempts}/5)`);
            setTimeout(initializeWhatsApp, 5000);
        } else {
            console.error('❌ Max initialization attempts reached');
            await bot.telegram.sendMessage(ADMIN_ID, 
                '❌ Failed to initialize WhatsApp after 5 attempts.\n\nUse /restart to try again.',
                { parse_mode: 'Markdown' }
            ).catch(console.error);
        }
    }
}

async function setupTargetGroup() {
    try {
        console.log('🔍 Looking for WhatsApp groups...');
        
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups);
        
        console.log(`Found ${groupList.length} groups`);
        
        const target = groupList.find(g => 
            g.subject && g.subject.toLowerCase().includes(GROUP_NAME.toLowerCase())
        );
        
        if (target) {
            targetGroupId = target.id;
            console.log(`✅ Target group found: ${target.subject}`);
            
            await bot.telegram.sendMessage(ADMIN_ID,
                `🎉 *Bot Ready!*\n\n` +
                `📱 WhatsApp: Connected\n` +
                `👥 Group: ${target.subject}\n` +
                `👤 Members: ${target.participants.length}\n` +
                `📨 Queue: ${messageQueue.length} messages\n\n` +
                `✅ Forwarding active!`,
                { parse_mode: 'Markdown' }
            ).catch(console.error);
            
            // Start processing queue if any
            if (messageQueue.length > 0) {
                processQueuedMessages();
            }
        } else {
            console.log(`❌ Group "${GROUP_NAME}" not found`);
            
            const groupNames = groupList.map(g => g.subject).slice(0, 10).join('\n• ');
            
            await bot.telegram.sendMessage(ADMIN_ID,
                                `⚠️ *Group Not Found*\n\n` +
                `Looking for: "${GROUP_NAME}"\n\n` +
                `Available groups:\n• ${groupNames}`,
                { parse_mode: 'Markdown' }
            ).catch(console.error);
        }
    } catch (error) {
        console.error('Group setup error:', error);
        setTimeout(setupTargetGroup, 5000);
    }
}

async function processQueuedMessages() {
    if (isProcessing || messageQueue.length === 0 || !isReady || !targetGroupId) {
        return;
    }
    
    isProcessing = true;
    console.log(`📤 Processing ${messageQueue.length} queued messages...`);
    
    while (messageQueue.length > 0 && isReady && targetGroupId) {
        const msg = messageQueue.shift();
        
        try {
            // Ultra-fast forwarding based on message type
            if (msg.type === 'photo' && msg.post?.photo) {
                const photoId = msg.post.photo[msg.post.photo.length - 1].file_id;
                const buffer = await downloadFile(photoId);
                await sock.sendMessage(targetGroupId, {
                    image: buffer,
                    caption: msg.post.caption || ''
                });
            } else if (msg.type === 'video' && msg.post?.video) {
                const buffer = await downloadFile(msg.post.video.file_id);
                await sock.sendMessage(targetGroupId, {
                    video: buffer,
                    caption: msg.post.caption || ''
                });
            } else if (msg.type === 'document' && msg.post?.document) {
                const buffer = await downloadFile(msg.post.document.file_id);
                await sock.sendMessage(targetGroupId, {
                    document: buffer,
                    mimetype: msg.post.document.mime_type,
                    fileName: msg.post.document.file_name,
                    caption: msg.post.caption || ''
                });
            } else {
                await sock.sendMessage(targetGroupId, msg.content);
            }
            
            console.log(`✅ Sent queued message (${messageQueue.length} remaining)`);
        } catch (error) {
            console.error('Failed to send queued message:', error);
            messageQueue.unshift(msg);
            await delay(2000);
        }
        
        // Minimal delay for ultra-fast sending
        if (messageQueue.length > 0) {
            await delay(100);
        }
    }
    
    isProcessing = false;
}

// Ultra-fast file download
async function downloadFile(fileId) {
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
}

// Message forwarding handler - ULTRA FAST
bot.on('channel_post', async (ctx) => {
    const startTime = Date.now();
    const post = ctx.channelPost;
    const text = post.text || post.caption || '';
    
    console.log(`📨 New message: ${text?.substring(0, 50) || '[Media]'}`);
    
    // Queue if not ready
    if (!isReady || !targetGroupId) {
        messageQueue.push({
            content: { text: text || '[Media message]' },
            timestamp: startTime,
            type: post.photo ? 'photo' : post.video ? 'video' : post.document ? 'document' : 'text',
            post: post
        });
        
        console.log(`📥 Queued (${messageQueue.length} total) - WhatsApp ${isReady ? 'ready' : 'not ready'}`);
        
        // Try to initialize if not ready
        if (!isReady && initAttempts === 0) {
            initializeWhatsApp();
        }
        
        return;
    }
    
    // Ultra-fast forwarding
    try {
        if (post.photo) {
            // Download and send immediately
            const photoId = post.photo[post.photo.length - 1].file_id;
            downloadFile(photoId).then(async (buffer) => {
                await sock.sendMessage(targetGroupId, {
                    image: buffer,
                    caption: text
                });
                console.log(`✅ Photo sent in ${Date.now() - startTime}ms`);
            }).catch(error => {
                console.error('Photo send error:', error);
                messageQueue.push({
                    content: { text: text || '[Photo]' },
                    timestamp: startTime,
                    type: 'photo',
                    post: post
                });
            });
            
        } else if (post.video) {
            downloadFile(post.video.file_id).then(async (buffer) => {
                await sock.sendMessage(targetGroupId, {
                    video: buffer,
                    caption: text
                });
                console.log(`✅ Video sent in ${Date.now() - startTime}ms`);
            }).catch(error => {
                console.error('Video send error:', error);
                messageQueue.push({
                    content: { text: text || '[Video]' },
                    timestamp: startTime,
                    type: 'video',
                    post: post
                });
            });
            
        } else if (post.document) {
            downloadFile(post.document.file_id).then(async (buffer) => {
                await sock.sendMessage(targetGroupId, {
                    document: buffer,
                    mimetype: post.document.mime_type,
                    fileName: post.document.file_name,
                    caption: text
                });
                console.log(`✅ Document sent in ${Date.now() - startTime}ms`);
            }).catch(error => {
                console.error('Document send error:', error);
                messageQueue.push({
                    content: { text: text || '[Document]' },
                    timestamp: startTime,
                    type: 'document',
                    post: post
                });
            });
            
        } else if (text) {
            await sock.sendMessage(targetGroupId, { text });
            console.log(`✅ Text sent in ${Date.now() - startTime}ms`);
        }
    } catch (error) {
        console.error('Forward error:', error);
        messageQueue.push({
            content: { text: text || '[Failed]' },
            timestamp: startTime,
            type: 'retry',
            post: post
        });
        
        setTimeout(processQueuedMessages, 2000);
    }
});

// Bot commands
bot.command('start', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply(
        `🤖 *WhatsApp-Telegram Forwarder*\n\n` +
        `Commands:\n` +
        `/status - Check status\n` +
        `/restart - Restart WhatsApp\n` +
        `/queue - View queue\n` +
        `/groups - List groups\n` +
        `/session - Save session\n` +
        `/test - Test message\n` +
        `/clear - Clear queue`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    await ctx.reply(
        `📊 *Status*\n\n` +
        `WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}\n` +
        `Group: ${targetGroupId ? '✅ Found' : '❌ Not found'}\n` +
        `Queue: ${messageQueue.length} messages\n` +
        `Uptime: ${hours}h ${minutes}m\n` +
        `Session: ${SESSION_DATA ? '✅ Loaded' : '❌ Not set'}`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('restart', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    await ctx.reply('♻️ Restarting WhatsApp...');
    isReady = false;
    initAttempts = 0;
    
    if (sock) {
        sock.end();
        sock = null;
    }
    
    setTimeout(initializeWhatsApp, 2000);
});

bot.command('queue', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    if (messageQueue.length === 0) {
        await ctx.reply('📨 Queue is empty');
    } else {
        const preview = messageQueue.slice(0, 5).map((m, i) => 
            `${i+1}. ${m.type} - ${m.content.text?.substring(0, 30) || 'Media'}`
        ).join('\n');
        
        await ctx.reply(
            `📨 *Queue: ${messageQueue.length} messages*\n\n${preview}`,
            { parse_mode: 'Markdown' }
        );
    }
});

bot.command('groups', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    if (!isReady || !sock) {
        await ctx.reply('❌ WhatsApp not connected');
        return;
    }
    
    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups)
            .map((g, i) => `${i+1}. ${g.subject}`)
            .slice(0, 20)
            .join('\n');
            
        await ctx.reply(`📱 *Groups:*\n\n${list}`, { parse_mode: 'Markdown' });
    } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

bot.command('session', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    if (SESSION_DATA) {
        await ctx.reply('✅ Session already saved in environment');
    } else {
        await saveSessionToEnv();
        await ctx.reply('💾 Check logs for SESSION_DATA');
    }
});

bot.command('test', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    if (!isReady || !targetGroupId) {
        await ctx.reply('❌ Not ready');
        return;
    }
    
    try {
        await sock.sendMessage(targetGroupId, { 
            text: `🧪 Test message\nTime: ${new Date().toLocaleString()}`
        });
        await ctx.reply('✅ Test sent');
    } catch (error) {
        await ctx.reply(`❌ Failed: ${error.message}`);
    }
});

bot.command('clear', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const count = messageQueue.length;
    messageQueue.length = 0;
    await ctx.reply(`🗑️ Cleared ${count} messages`);
});

// Keep alive mechanism
const keepAlive = () => {
    setInterval(async () => {
        if (process.env.RENDER_EXTERNAL_URL) {
            try {
                await axios.get(process.env.RENDER_EXTERNAL_URL + '/health', { timeout: 10000 });
                console.log('Keep-alive ping');
            } catch (error) {}
        }
        
        if (sock && isReady) {
            sock.sendPresenceUpdate('available').catch(() => {});
        }
    }, 5 * 60 * 1000);
};

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (error.code !== 'EADDRINUSE') {
        setTimeout(() => process.exit(1), 1000);
    }
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

// Main startup
async function startBot() {
    console.log('🚀 Starting WhatsApp-Telegram Forwarder...');
    
    try {
        // Start Telegram bot
        await bot.launch({
            allowedUpdates: ['message', 'channel_post', 'callback_query']
        });
        
        console.log('✅ Telegram bot started');
        
        // Notify admin
        const me = await bot.telegram.getMe();
        await bot.telegram.sendMessage(ADMIN_ID, 
            `🚀 *Bot Started!*\n\n` +
            `Bot: @${me.username}\n` +
            `Session: ${SESSION_DATA ? 'Found ✅' : 'Not found ❌'}\n\n` +
            `Initializing WhatsApp...`,
            { parse_mode: 'Markdown' }
        ).catch(console.error);
        
        // Initialize WhatsApp
        setTimeout(initializeWhatsApp, 2000);
        
        // Start keep-alive
        keepAlive();
        
    } catch (error) {
        console.error('Startup error:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    if (sock) sock.end();
    server.close();
    process.exit(0);
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    if (sock) sock.end();
    server.close();
    process.exit(0);
});

// Start the bot
startBot().catch(error => {
    console.error('Failed to start:', error);
    process.exit(1);
});
                
