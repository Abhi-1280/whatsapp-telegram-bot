const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { Telegraf, Markup } = require('telegraf');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

const bot = new Telegraf(BOT_TOKEN);
let whatsappClient;
let isReady = false;
let currentGroupId = null;
let currentGroupName = null;
let availableGroups = [];
let qrCodeData = null;

// Store settings
const SETTINGS_FILE = './bot-settings.json';

const loadSettings = async () => {
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return { groupName: 'savings safari' };
    }
};

const saveSettings = async (settings) => {
    try {
        await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (error) {
        console.error('Error saving settings:', error);
    }
};

const initWhatsApp = async () => {
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: "bot-client"
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
                '--disable-gpu'
            ]
        }
    });

    whatsappClient.on('qr', async (qr) => {
        console.log('QR Code received');
        qrCodeData = qr;
        
        try {
            // Generate QR code image
            const qrBuffer = await QRCode.toBuffer(qr, {
                errorCorrectionLevel: 'M',
                type: 'png',
                quality: 0.92,
                margin: 1,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                },
                scale: 8
            });
            
            // Send QR code as image
            await bot.telegram.sendPhoto(ADMIN_ID, { source: qrBuffer }, {
                caption: '📱 *Scan this QR code in WhatsApp*\n\n' +
                         '1. Open WhatsApp on your phone\n' +
                         '2. Go to Settings → Linked Devices\n' +
                         '3. Tap "Link a Device"\n' +
                         '4. Scan this QR code',
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🔄 Generate New QR', callback_data: 'new_qr' }
                    ]]
                }
            });
        } catch (error) {
            console.error('Error sending QR:', error);
            await bot.telegram.sendMessage(ADMIN_ID, `📱 QR Code (text):\n\n${qr}`);
        }
    });

    whatsappClient.on('authenticated', () => {
        console.log('Authenticated!');
        qrCodeData = null;
        bot.telegram.sendMessage(ADMIN_ID, '✅ WhatsApp authenticated successfully!');
    });

    whatsappClient.on('ready', async () => {
        console.log('WhatsApp is ready!');
        isReady = true;
        await loadGroups();
        
        const settings = await loadSettings();
        if (settings.groupName) {
            await selectGroupByName(settings.groupName);
        }
        
        await sendMainMenu();
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('Disconnected:', reason);
        isReady = false;
        currentGroupId = null;
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ WhatsApp disconnected: ${reason}`);
    });

    whatsappClient.initialize();
};

const loadGroups = async () => {
    try {
        const chats = await whatsappClient.getChats();
        availableGroups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                participantCount: chat.participants.length
            }));
        console.log(`Loaded ${availableGroups.length} groups`);
    } catch (error) {
        console.error('Error loading groups:', error);
    }
};

const selectGroupByName = async (groupName) => {
    const group = availableGroups.find(g => 
        g.name.toLowerCase().includes(groupName.toLowerCase())
    );
    
    if (group) {
        currentGroupId = group.id;
        currentGroupName = group.name;
        await saveSettings({ groupName: group.name });
        return true;
    }
    return false;
};

const sendMainMenu = async () => {
    const keyboard = [
        [{ text: '📊 Status', callback_data: 'status' }],
        [{ text: '👥 Change Group', callback_data: 'change_group' }],
        [{ text: '🔄 Refresh Groups', callback_data: 'refresh_groups' }],
        [{ text: '📱 Show QR Code', callback_data: 'show_qr' }],
        [{ text: '🔌 Reconnect WhatsApp', callback_data: 'reconnect' }],
        [{ text: '💾 Backup Session', callback_data: 'backup' }],
        [{ text: '🗑️ Clear Session', callback_data: 'clear_session' }]
    ];

    await bot.telegram.sendMessage(ADMIN_ID, 
        '*🤖 WhatsApp Bot Control Panel*\n\n' +
        'Select an option below:',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        }
    );
};

// Bot commands
bot.command('start', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    await sendMainMenu();
});

bot.command('menu', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    await sendMainMenu();
});

bot.command('status', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const status = 
        `*📊 Bot Status*\n\n` +
        `WhatsApp: ${isReady ? '✅ Connected' : '❌ Disconnected'}\n` +
        `Current Group: ${currentGroupName || 'None'}\n` +
        `Groups Available: ${availableGroups.length}\n` +
        `Uptime: ${Math.floor(process.uptime() / 60)} minutes`;
    
    await ctx.reply(status, { parse_mode: 'Markdown' });
});

bot.command('groups', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    if (!isReady) {
        await ctx.reply('❌ WhatsApp not connected');
        return;
    }
    
    await loadGroups();
    const groupList = availableGroups
        .slice(0, 20)
        .map((g, i) => `${i + 1}. ${g.name} (${g.participantCount} members)`)
        .join('\n');
    
    await ctx.reply(
        `*👥 Available Groups:*\n\n${groupList}\n\n` +
        `Total: ${availableGroups.length} groups`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('setgroup', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const groupName = ctx.message.text.replace('/setgroup ', '').trim();
    if (!groupName) {
        await ctx.reply('Usage: /setgroup <group name>');
        return;
    }
    
    if (!isReady) {
        await ctx.reply('❌ WhatsApp not connected');
        return;
    }
    
    const success = await selectGroupByName(groupName);
    if (success) {
        await ctx.reply(`✅ Group set to: ${currentGroupName}`);
    } else {
        await ctx.reply(`❌ Group "${groupName}" not found`);
    }
});

// Callback handlers
bot.action('status', async (ctx) => {
    await ctx.answerCbQuery();
    
    const status = 
        `*📊 Detailed Status*\n\n` +
        `🟢 WhatsApp: ${isReady ? 'Connected' : 'Disconnected'}\n` +
        `👥 Current Group: ${currentGroupName || 'Not selected'}\n` +
        `📝 Group ID: ${currentGroupId || 'N/A'}\n` +
        `📊 Total Groups: ${availableGroups.length}\n` +
        `⏱️ Uptime: ${Math.floor(process.uptime() / 60)} minutes\n` +
        `💾 Session: ${fs.existsSync('./.wwebjs_auth') ? 'Exists' : 'Not found'}`;
    
    await ctx.editMessageText(status, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '« Back', callback_data: 'back_menu' }]]
        }
    });
});

bot.action('change_group', async (ctx) => {
    await ctx.answerCbQuery();
    
    if (!isReady) {
        await ctx.reply('❌ WhatsApp not connected');
        return;
    }
    
    await loadGroups();
    
    const keyboard = availableGroups.slice(0, 10).map(group => [{
        text: `${group.name} (${group.participantCount})`,
        callback_data: `select_group_${availableGroups.indexOf(group)}`
    }]);
    
    keyboard.push([{ text: '« Back', callback_data: 'back_menu' }]);
    
    await ctx.editMessageText(
        '*👥 Select a Group:*\n\nShowing first 10 groups',
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }
    );
});

bot.action(/select_group_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    
    const index = parseInt(ctx.match[1]);
    const group = availableGroups[index];
    
    if (group) {
        currentGroupId = group.id;
        currentGroupName = group.name;
        await saveSettings({ groupName: group.name });
        
        await ctx.editMessageText(
            `✅ Group changed to: *${group.name}*\n\n` +
            `Members: ${group.participantCount}`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '« Back', callback_data: 'back_menu' }]]
                }
            }
        );
    }
});

bot.action('refresh_groups', async (ctx) => {
    await ctx.answerCbQuery('Refreshing groups...');
    
    if (!isReady) {
        await ctx.reply('❌ WhatsApp not connected');
        return;
    }
    
    await loadGroups();
    await ctx.reply(`✅ Refreshed! Found ${availableGroups.length} groups`);
});

bot.action('show_qr', async (ctx) => {
    await ctx.answerCbQuery();
    
    if (isReady) {
        await ctx.reply('✅ Already connected to WhatsApp');
        return;
    }
    
    if (qrCodeData) {
        try {
            const qrBuffer = await QRCode.toBuffer(qrCodeData, {
                errorCorrectionLevel: 'M',
                type: 'png',
                scale: 8
            });
            
            await ctx.replyWithPhoto({ source: qrBuffer }, {
                caption: '📱 Scan this QR code in WhatsApp'
            });
        } catch (error) {
            await ctx.reply(`📱 QR Code:\n\n${qrCodeData}`);
        }
    } else {
        await ctx.reply('No QR code available. Use /reconnect to generate new one.');
    }
});

bot.action('reconnect', async (ctx) => {
    await ctx.answerCbQuery('Reconnecting...');
    
    await ctx.reply('🔄 Reconnecting WhatsApp...');
    
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    setTimeout(() => initWhatsApp(), 2000);
});

bot.action('backup', async (ctx) => {
    await ctx.answerCbQuery();
    
    // This would trigger the backup to Mega
    await ctx.reply('💾 Backup functionality should be implemented with Mega integration');
});

bot.action('clear_session', async (ctx) => {
    await ctx.answerCbQuery();
    
    await ctx.editMessageText(
        '⚠️ *Clear Session?*\n\n' +
        'This will delete the saved WhatsApp session.\n' +
        'You will need to scan QR code again.',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Yes, Clear', callback_data: 'confirm_clear' },
                        { text: '❌ Cancel', callback_data: 'back_menu' }
                    ]
                ]
            }
        }
    );
});

bot.action('confirm_clear', async (ctx) => {
    await ctx.answerCbQuery('Clearing session...');
    
    try {
        const sessionPath = './.wwebjs_auth';
        if (fs.existsSync(sessionPath)) {
            await fs.rm(sessionPath, { recursive: true, force: true });
        }
        
        await ctx.reply('✅ Session cleared successfully');
        
        if (whatsappClient) {
            await whatsappClient.destroy();
        }
        
        setTimeout(() => initWhatsApp(), 2000);
    } catch (error) {
        await ctx.reply(`❌ Error clearing session: ${error.message}`);
    }
});

bot.action('back_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await sendMainMenu();
});

bot.action('new_qr', async (ctx) => {
    await ctx.answerCbQuery('Generating new QR...');
    
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    setTimeout(() => initWhatsApp(), 2000);
});

// Text handler for direct group name input
bot.on('text', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;
    
    const text = ctx.message.text;
    
    // Check if it's a group name search
    if (!text.startsWith('/')) {
        if (!isReady) {
            await ctx.reply('❌ WhatsApp not connected');
            return;
        }
        
        const matchingGroups = availableGroups.filter(g => 
            g.name.toLowerCase().includes(text.toLowerCase())
        );
        
        if (matchingGroups.length === 0) {
            await ctx.reply('❌ No groups found matching: ' + text);
        } else if (matchingGroups.length === 1) {
            const group = matchingGroups[0];
            currentGroupId = group.id;
            currentGroupName = group.name;
            await saveSettings({ groupName: group.name });
            await ctx.reply(`✅ Group set to: ${group.name}`);
        } else {
            const groupList = matchingGroups
                .slice(0, 10)
                .map((g, i) => `${i + 1}. ${g.name}`)
                .join('\n');
            
            await ctx.reply(
                `Found ${matchingGroups.length} groups:\n\n${groupList}\n\n` +
                `Type the exact name to select`
            );
        }
    }
});

// Error handling
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('❌ An error occurred: ' + err.message);
});

// Start the management bot
const start = async () => {
    console.log('Starting WhatsApp Management Bot...');
    
    // Initialize WhatsApp
    await initWhatsApp();
    
    // Launch Telegram bot
    await bot.launch();
    console.log('Management bot started');
    
    // Send startup message
    if (ADMIN_ID) {
        await bot.telegram.sendMessage(ADMIN_ID, 
            '🚀 *WhatsApp Management Bot Started*\n\n' +
            'Use /menu to see options\n' +
            'Or send a group name to search',
            { parse_mode: 'Markdown' }
        );
    }
};

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    if (whatsappClient) whatsappClient.destroy();
    process.exit(0);
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    if (whatsappClient) whatsappClient.destroy();
    process.exit(0);
});

// Export functions for use in main bot
module.exports = {
    getCurrentGroup: () => ({ id: currentGroupId, name: currentGroupName }),
    isWhatsAppReady: () => isReady,
    getWhatsAppClient: () => whatsappClient
};

// Start if run directly
if (require.main === module) {
    start().catch(console.error);
}
    
