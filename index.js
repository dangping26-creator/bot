const { Telegraf, Markup, session } = require('telegraf');
const nodemailer = require('nodemailer');
const fs = require('fs');
const { simpleParser } = require('mailparser');
const Imap = require('imap');
const axios = require('axios');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const { PassThrough } = require('stream');
const path = require('path');

// ==========================================
// PAKASIR PAYMENT GATEWAY CONFIGURATION
// ==========================================
const PAKASIR_BASE_URL = 'https://app.pakasir.com/api';
const PAKASIR_API_KEY = 'y3lRfHL5LKFpnee5U9deO42oookAfilH';
const PAKASIR_SLUG = 'ping';

// ==========================================
// WHATSAPP SENDER CONFIG (FROM BOT 2)
// ==========================================
const WA_AUTH_DIR = path.join(__dirname, "auth");
if (!fs.existsSync(WA_AUTH_DIR)) fs.mkdirSync(WA_AUTH_DIR, { recursive: true });

const waSockets = {};
const userSenderMap = new Map();
const SENDERS_FILE = path.join(__dirname, 'senders.json');

// ==========================================
// SISTEM ANTI-CRASH & ERROR HANDLING
// ==========================================

process.on('unhandledRejection', (reason, promise) => {
    console.error('[ANTI-CRASH] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[ANTI-CRASH] Uncaught Exception:', error);
});

const safeHandler = (fn) => {
    return async (ctx, ...args) => {
        try {
            await fn(ctx, ...args);
        } catch (error) {
            console.error('[ERROR HANDLER] Error in handler:', error);
            try {
                await ctx.reply('⚠️ Terjadi kesalahan. Silahkan coba lagi.', mainKeyboard).catch(() => {});
            } catch (e) {
                console.error('[ERROR HANDLER] Failed to send error message:', e);
            }
        }
    };
};

const safeCallback = (fn) => {
    return async (ctx, ...args) => {
        try {
            await fn(ctx, ...args);
        } catch (error) {
            console.error('[ERROR HANDLER] Error in callback:', error);
            try {
                await ctx.answerCbQuery('⚠️ Terjadi kesalahan').catch(() => {});
            } catch (e) {}
        }
    };
};

// ==========================================
// BOT CONFIGURATION
// ==========================================

const bot = new Telegraf('8280758503:AAGDzBqZFltoS45duvwi3zYgLFOqYeCz5No');

const OWNER_ID = 7537615443;
const GRUP_LINK = "https://t.me/CUANBARENG_PING";
const GRUP_STOR_LINK = "https://t.me/TestimoniBotPING";
const SALURAN_LINK = "https://t.me/+xcIb85guCiYxYThl";
const GRUP_ID = "-1002332656201";
const GRUP_STOR_ID = "-1003844277669";
const NOTIF_GRUP_ID = "-1003844277669";
const DB_FILE = './database.json';

bot.use(session());

// ==========================================
// MIDDLEWARE ANTI-GRUP
// ==========================================

bot.use((ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    return next();
});

// ==========================================
// DATABASE LOGIC
// ==========================================

let db = { users: {}, ownerEmails: [], pendingPayments: {}, totalFix: 12629861 };

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            db = JSON.parse(data);
            if (!db.users) db.users = {};
            if (!db.ownerEmails) db.ownerEmails = [];
            if (!db.pendingPayments) db.pendingPayments = {};
        } else {
            saveDB();
        }
    } catch (e) {
        console.error('[DATABASE] Error loading DB:', e);
        db = { users: {}, ownerEmails: [], pendingPayments: {}, totalFix: 12629861 };
    }
}

function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 4));
    } catch (e) {
        console.error('[DATABASE] Error saving DB:', e);
    }
}

loadDB();

// ==========================================
// STORE UNTUK INTERVAL AUTO-APPROVE
// ==========================================
const autoApproveTimers = {};

// ==========================================
// USER EMAIL STORAGE (untuk FIX MERAH 2)
// ==========================================
function getUserEmails(userId) {
    if (!db.users[userId]) return [];
    if (!db.users[userId].emails) db.users[userId].emails = [];
    return db.users[userId].emails;
}

function addUserEmail(userId, email, appPass) {
    if (!db.users[userId]) {
        db.users[userId] = { 
            point: 0, 
            reffCount: 0, 
            akses: Date.now() + (30 * 60 * 1000),
            username: null,
            first_name: '',
            invitedBy: null,
            limitFix: 2,
            limitCekBio: 2,
            limitCv: 2,
            emails: []
        };
    }
    if (!db.users[userId].emails) db.users[userId].emails = [];
    db.users[userId].emails.push({ email, appPass, addedAt: new Date().toISOString() });
    if (!db.users[userId].currentEmailIndex) db.users[userId].currentEmailIndex = 0;
    saveDB();
}

function getNextUserEmail(userId) {
    const emails = getUserEmails(userId);
    if (emails.length === 0) return null;
    
    if (typeof db.users[userId].currentEmailIndex !== 'number') {
        db.users[userId].currentEmailIndex = 0;
    }
    
    const emailData = emails[db.users[userId].currentEmailIndex];
    db.users[userId].currentEmailIndex = (db.users[userId].currentEmailIndex + 1) % emails.length;
    saveDB();
    
    return { 
        email: emailData, 
        index: db.users[userId].currentEmailIndex === 0 ? emails.length - 1 : db.users[userId].currentEmailIndex - 1 
    };
}

function deleteUserEmail(userId, index) {
    const emails = getUserEmails(userId);
    if (index < 0 || index >= emails.length) return false;
    emails.splice(index, 1);
    if (db.users[userId].currentEmailIndex >= emails.length) {
        db.users[userId].currentEmailIndex = 0;
    }
    saveDB();
    return true;
}

// ==========================================
// RATE LIMITER FIX MERAH (5 nomor / 5 menit per user)
// ==========================================
const fixRateLimiter = {};

function checkFixRateLimit(userId) {
    const now = Date.now();
    const windowMs = 5 * 60 * 1000; // 5 menit
    const maxRequests = 5; // 5 nomor

    if (!fixRateLimiter[userId]) {
        fixRateLimiter[userId] = { count: 0, resetTime: now + windowMs, firstFixTime: null };
    }

    const userLimit = fixRateLimiter[userId];

    // Reset jika window sudah lewat
    if (now >= userLimit.resetTime) {
        userLimit.count = 0;
        userLimit.resetTime = now + windowMs;
        userLimit.firstFixTime = null;
    }

    if (userLimit.count >= maxRequests) {
        const remainingMs = userLimit.resetTime - now;
        const remainingMinutes = Math.floor(remainingMs / (60 * 1000));
        const remainingSeconds = Math.floor((remainingMs % (60 * 1000)) / 1000);
        
        let timeText = '';
        if (remainingMinutes > 0) timeText += remainingMinutes + ' menit ';
        if (remainingSeconds > 0) timeText += remainingSeconds + ' detik';
        
        return {
            allowed: false,
            message: "⚠️ RATE LIMITER FIXMERAH AKTIF\n" +
                "═══════════════════════\n" +
                "```\n" +
                "🚦 Rate limiter FixMerah aktif (5 request / 5 menit). Coba lagi dalam " + timeText.trim() + ".\n" +
                "⏳ Tujuan limiter: menjaga sender tetap stabil dan mencegah spam burst.\n" +
                "```",
            currentCount: userLimit.count,
            maxRequests: maxRequests
        };
    }

    // Catat waktu fix pertama (tapi BELUM tambah count)
    if (userLimit.count === 0 && !userLimit.firstFixTime) {
        userLimit.firstFixTime = now;
        userLimit.resetTime = now + windowMs;
    }

    // Return count yang BELUM ditambah (masih current)
    return { allowed: true, currentCount: userLimit.count, maxRequests: maxRequests };
}

function incrementFixRateLimit(userId, amount) {
    if (!fixRateLimiter[userId]) return;
    
    const userLimit = fixRateLimiter[userId];
    userLimit.count += amount;
    
    // Catat waktu fix pertama kalau belum ada
    if (!userLimit.firstFixTime) {
        userLimit.firstFixTime = Date.now();
        userLimit.resetTime = Date.now() + (5 * 60 * 1000);
    }
}

function getFixRateLimitInfo(userId) {
    if (!fixRateLimiter[userId]) {
        return { count: 0, max: 5 };
    }
    
    const now = Date.now();
    const userLimit = fixRateLimiter[userId];
    
    // Reset jika window sudah lewat
    if (now >= userLimit.resetTime) {
        userLimit.count = 0;
        userLimit.resetTime = now + (5 * 60 * 1000);
        userLimit.firstFixTime = null;
    }
    
    return { count: userLimit.count, max: 5 };
}

function getFixRateLimitInfo(userId) {
    if (!fixRateLimiter[userId]) {
        return { count: 0, max: 5 };
    }
    
    const now = Date.now();
    const userLimit = fixRateLimiter[userId];
    
    // Reset jika window sudah lewat
    if (now >= userLimit.resetTime) {
        userLimit.count = 0;
        userLimit.resetTime = now + (5 * 60 * 1000);
        userLimit.firstFixTime = null;
    }
    
    return { count: userLimit.count, max: 5 };
}

// ==========================================
// BOT START TIME
// ==========================================
const BOT_START_TIME = Date.now();

// ==========================================
// KEYBOARDS - NEW STRUCTURE
// ==========================================

// KEYBOARD UTAMA - 2 TOMBOL
const mainKeyboard = Markup.keyboard([
    ['💳 Buy Akses'],
    ['🛠 FIX MERAH', '🛠 FIX MERAH 2'],
    ['📱 CEK BIO', '📁 FITUR CV'],
    ['⬅️ KEMBALI']
]).resize();

// KEYBOARD FIX MERAH (dari bot 1)
const fixMerahKeyboard = Markup.keyboard([
    ['🔧 Fix Nomor', '📊 Status'],
    ['💳 Buy Akses', '💡 Tutorial'],
    ['⬅️ KEMBALI']
]).resize();

// KEYBOARD FIX MERAH 2 (email sendiri)
const fixMerah2Keyboard = Markup.keyboard([
    ['🔧 Fix Nomor 2', '📊 Status'],
    ['📧 Tambah Email', '📧 List Email'],
    ['💳 Buy Akses', '⬅️ KEMBALI']
]).resize();

// KEYBOARD CEK BIO (dari bot 2, tapi keyboard)
const cekBioKeyboard = Markup.keyboard([
    ['🔐 LOGIN WHATSAPP'],
    ['📝 CEK BIO', '📁 CEK BIO FILE'],
    ['📱 CEK NOMOR', '🔍 CEK REPE'],
    ['📊 CEK RANGE', '🚫 CEK BANNED'],
    ['💳 Buy Akses', '📊 Status'],
    ['📱 MY SENDER', '❌ DISCONNECT'],
    ['⬅️ KEMBALI']
]).resize();

// KEYBOARD FITUR CV
const cvKeyboard = Markup.keyboard([
    ['📁 TO VCF', '📄 TO TXT'],
    ['👑 ADMIN/NAVY', '✍️ MANUAL'],
    ['✏️ RENAME CTC', '📂 RENAME FILE'],
    ['🔗 GABUNG', '✂️ PECAH'],
    ['💡 CV PINTAR', '📊 STATUS'],
    ['💳 Buy Akses', '⬅️ KEMBALI']
]).resize();

// KEYBOARD SENDER WHATSAPP
const senderKeyboard = Markup.keyboard([
    ['📱 MY SENDER', '❌ DISCONNECT'],
    ['⬅️ KEMBALI']
]).resize();

const ownerKeyboard = Markup.keyboard([
    ['🛠 FIX MERAH', '📱 CEK BIO'],
    ['📁 FITUR CV'],
    ['⚙️ Owner Panel']
]).resize();

const backKeyboard = Markup.keyboard([['❌ BATAL']]).resize();

const verifyButtons = Markup.inlineKeyboard([
    [Markup.button.url('📢 Join Grup', GRUP_LINK)],
    [Markup.button.url('📣 Join Saluran', SALURAN_LINK)],
    [Markup.button.url('📦 TESTIMONI', GRUP_STOR_LINK)],
    [Markup.button.callback('Verifikasi ✅', 'check_verify')]
]);

// ==========================================
// HELPERS
// ==========================================

function getRemainingDays(userId) {
    try {
        const user = db.users[userId];
        if (!user || !user.akses) return 0;
        if (user.akses === 'permanen') return 'permanen';
        const now = Date.now();
        const diff = user.akses - now;
        if (diff <= 0) return 0;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        if (days < 1 && hours < 1) return minutes + ' Menit';
        return days < 1 ? hours + ' Jam ' + minutes + ' Menit' : days + ' Hari ' + hours + ' Jam';
    } catch (e) {
        console.error('[HELPER] Error in getRemainingDays:', e);
        return 0;
    }
}

function hasAccess(userId) {
    try {
        if (userId === OWNER_ID) return true;
        const user = db.users[userId];
        if (!user || !user.akses) return false;
        if (user.akses === 'permanen') return true;
        return (user.akses - Date.now()) > 0;
    } catch (e) {
        console.error('[HELPER] Error in hasAccess:', e);
        return false;
    }
}

function hasPermanentAccess(userId) {
    try {
        if (userId === OWNER_ID) return true;
        const user = db.users[userId];
        if (!user || !user.akses) return false;
        return user.akses === 'permanen';
    } catch (e) {
        console.error('[HELPER] Error in hasPermanentAccess:', e);
        return false;
    }
}

// ==========================================
// SISTEM LIMIT FREE USER
// ==========================================

function getUserLimit(userId) {
    if (!db.users[userId]) {
        db.users[userId] = { 
            point: 0, 
            reffCount: 0, 
            akses: Date.now() + (30 * 60 * 1000),
            username: null,
            first_name: '',
            invitedBy: null,
            limitFix: 2,
            limitCekBio: 2,
            limitCv: 2
        };
        saveDB();
    }
    if (typeof db.users[userId].limitFix === 'undefined') db.users[userId].limitFix = 2;
    if (typeof db.users[userId].limitCekBio === 'undefined') db.users[userId].limitCekBio = 2;
    if (typeof db.users[userId].limitCv === 'undefined') db.users[userId].limitCv = 2;
    return db.users[userId];
}

function checkLimit(userId, feature) {
    if (userId === OWNER_ID) return true;
    if (hasAccess(userId)) return true;
    
    const user = getUserLimit(userId);
    let limitField = '';
    let limitName = '';
    
    if (feature === 'fix') {
        limitField = 'limitFix';
        limitName = 'Fix Nomor';
    } else if (feature === 'cekbio') {
        limitField = 'limitCekBio';
        limitName = 'Cek Bio';
    } else if (feature === 'cv') {
        limitField = 'limitCv';
        limitName = 'Fitur CV';
    }
    
    if (user[limitField] <= 0) {
        return false;
    }
    
    user[limitField] -= 1;
    saveDB();
    return true;
}

function getLimitInfo(userId) {
    if (userId === OWNER_ID) return '';
    if (hasAccess(userId)) return '';
    
    const user = getUserLimit(userId);
    return '\n\n📊 *Sisa Limit Free:*\n🔧 Fix: ' + user.limitFix + 'x\n📱 Cek Bio: ' + user.limitCekBio + 'x\n📁 CV: ' + user.limitCv + 'x';
}

// ==========================================
// HELPERS LAINNYA
// ==========================================

async function checkJoin(ctx) {
    try {
        const member1 = await ctx.telegram.getChatMember(GRUP_ID, ctx.from.id);
        const join1 = ['member', 'administrator', 'creator'].includes(member1.status);
        
        const member2 = await ctx.telegram.getChatMember(GRUP_STOR_ID, ctx.from.id);
        const join2 = ['member', 'administrator', 'creator'].includes(member2.status);
        
        return join1 && join2;
    } catch (e) {
        console.error('[HELPER] Error in checkJoin:', e);
        return false;
    }
}

function findUser(target) {
    try {
        const cleanTarget = target.replace('@', '').trim();
        return Object.keys(db.users).find(id => 
            (db.users[id].username && db.users[id].username.toLowerCase() === cleanTarget.toLowerCase()) || 
            id === cleanTarget
        );
    } catch (e) {
        console.error('[HELPER] Error in findUser:', e);
        return null;
    }
}

function getNextOwnerEmail() {
    try {
        if (!db.ownerEmails || db.ownerEmails.length === 0) {
            console.error('[EMAIL] No owner emails found');
            return null;
        }
        if (typeof db.currentOwnerEmailIndex !== 'number') {
            db.currentOwnerEmailIndex = 0;
        }
        
        const emailData = db.ownerEmails[db.currentOwnerEmailIndex];
        if (!emailData || !emailData.email || !emailData.appPass) {
            console.error('[EMAIL] Invalid owner email data at index:', db.currentOwnerEmailIndex);
            return null;
        }
        
        db.currentOwnerEmailIndex = (db.currentOwnerEmailIndex + 1) % db.ownerEmails.length;
        saveDB();
        
        return { 
            email: emailData, 
            index: db.currentOwnerEmailIndex === 0 ? db.ownerEmails.length - 1 : db.currentOwnerEmailIndex - 1 
        };
    } catch (e) {
        console.error('[EMAIL] Error in getNextOwnerEmail:', e);
        return null;
    }
}

// ==========================================
// FUNGSI NOTIFIKASI KE GRUP
// ==========================================

function sensorNomorWA(nomor) {
    try {
        if (!nomor || nomor.length < 8) return nomor;
        const awal = nomor.substring(0, 4);
        const akhir = nomor.substring(nomor.length - 3);
        const tengah = 'x'.repeat(nomor.length - 7);
        return awal + tengah + akhir;
    } catch (e) {
        console.error('[NOTIF] Error sensor nomor:', e);
        return nomor;
    }
}

async function sendNotifFixBerhasil(userId, targetNumber, emailNumber = null) {
    try {
        const user = db.users[userId] || {};
        const sensorNumber = sensorNomorWA(targetNumber);
        const now = new Date();
        const timeText = now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) + ' WIB';
        
        const emailInfo = emailNumber ? "📧 Email: ke " + emailNumber + "\n" : "";
        
        const notifMsg = "✅ <b>FIX NOMOR BERHASIL</b>\n" +
            "═════════════════════\n" +
            "<blockquote>👤 User: " + (user.first_name || 'Unknown') + "\n" +
            "📱 Number: " + sensorNumber + "\n" +
            emailInfo +
            "📊 Status: ✅ SUCCESS</blockquote>\n" +
            "═════════════════════\n" +
            "<i>Bot yang di gunakan:</i>\n" +
            "@BotFixMerahPING_bot";

        await bot.telegram.sendMessage(NOTIF_GRUP_ID, notifMsg, { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "KLIK DISINI", url: "https://t.me/BotFixMerahPING_bot?start=7537615443" }]
                ]
            }
        }); 
    } catch (err) {
        console.error('[NOTIF] Gagal kirim notifikasi fix berhasil ke grup:', err);
    }
}

async function sendNotifUserBaru(userId, firstName) {
    try {
        const now = new Date();
        const timeText = now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) + ' WIB';
        
        const notifMsg = "👤 <b>USER BERGABUNG</b>\n" +
            "═════════════════════\n" +
            "<blockquote>👤 User: " + firstName + "\n" +
            "🤖 Bot: Fixed/Fix Merah\n" +
            "📅 Date: " + now.getDate() + ' ' + now.toLocaleString('id-ID', { month: 'long' }) + ' ' + now.getFullYear() + " " + timeText + "</blockquote>\n" +
            "═════════════════════\n" +
            "<i>Bot yang di gunakan:</i>\n" +
            "@BotFixMerahPING_bot";
        
        await bot.telegram.sendMessage(NOTIF_GRUP_ID, notifMsg, { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "KLIK DISINI", url: "https://t.me/BotFixMerahPING_bot?start=7537615443" }]
                ]
            }
        }); 
    } catch (err) {
        console.error('[NOTIF] Gagal kirim notifikasi fix berhasil ke grup:', err);
    }
}

async function sendNotifTransaksiBerhasil(userId, paketLabel, harga) {
    try {
        const user = db.users[userId] || {};
        
        const notifMsg = "✅ <b>TRANSAKSI BERHASIL</b>\n" +
            "═════════════════════\n" +
            "<blockquote>👤 User: " + (user.first_name || 'Unknown') + "\n" +
            "🤖 Bot: Fixed/Fix Merah\n" +
            "📦 Paket: " + paketLabel + "\n" +
            "💰 Nominal: Rp" + harga.toLocaleString('id-ID') + "</blockquote>\n" +
            "═════════════════════\n" +
            "✨ <i>Terimakasih sudah menggunakan bot kami\n" +
            "Bot yang di gunakan:</i>\n" +
            "@BotFixMerahPING_bot";
        
        await bot.telegram.sendMessage(NOTIF_GRUP_ID, notifMsg, { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "KLIK DISINI", url: "https://t.me/BotFixMerahPING_bot?start=7537615443" }]
                ]
            }
        }); 
    } catch (err) {
        console.error('[NOTIF] Gagal kirim notifikasi fix berhasil ke grup:', err);
    }
}

// ==========================================
// FUNGSI MONITORING EMAIL (IMAP)
// ==========================================

async function checkImapForReplies(emailData, userId, isOwnerEmail = false, emailNumber = null) {
    return new Promise((resolve, reject) => {
        try {
            const imap = new Imap({
                user: emailData.email,
                password: emailData.appPass,
                host: 'imap.gmail.com',
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false }
            });

            let hasReplied = false;

            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err, box) => {
                    if (err) {
                        console.error('[IMAP] Error opening inbox:', err);
                        imap.end();
                        resolve(false);
                        return;
                    }

                    imap.search(['UNSEEN', ['FROM', 'support@support.whatsapp.com']], (err, results) => {
                        if (err) {
                            console.error('[IMAP] Error searching:', err);
                            imap.end();
                            resolve(false);
                            return;
                        }

                        if (!results || results.length === 0) {
                            imap.end();
                            resolve(false);
                            return;
                        }

                        const f = imap.fetch(results, { bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)', markSeen: true });
                        
                        f.on('message', (msg, seqno) => {
                            msg.on('body', (stream, info) => {
                                let buffer = '';
                                stream.on('data', (chunk) => {
                                    buffer += chunk.toString('utf8');
                                });
                                stream.once('end', () => {
                                    hasReplied = true;
                                });
                            });
                        });

                        f.once('error', (err) => {
                            console.error('[IMAP] Fetch error:', err);
                        });

                        f.once('end', () => {
                            imap.end();
                            resolve(hasReplied);
                        });
                    });
                });
            });

            imap.once('error', (err) => {
                console.error('[IMAP] Connection error:', err);
                resolve(false);
            });

            imap.once('end', () => {
                console.log('[IMAP] Connection ended');
            });

            imap.connect();
        } catch (e) {
            console.error('[IMAP] Error:', e);
            resolve(false);
        }
    });
}

async function startEmailMonitoring(emailData, userId, isOwnerEmail = false, emailNumber = null, targetNumber = null) {
    const maxAttempts = 60;
    let attempts = 0;
    let noReplyNotified = false;
    
    const checkInterval = setInterval(async () => {
        attempts++;
        
        try {
            const hasReply = await checkImapForReplies(emailData, userId, isOwnerEmail, emailNumber);
            
            if (hasReply) {
                clearInterval(checkInterval);
                try {
                    let notifMsg = "🔔 Kring Kring Kring\n" +
                        "═══════════════════════\n" +
                        "```\n" +
                        "✅ Pihak WhatsApp sudah merespon...\n" +
                        "Silahkan login akun WhatsApp anda✨\n" +
                        "```";
                    
                    if (targetNumber) {
                        notifMsg = "🔔 Kring Kring Kring\n" +
                            "═══════════════════════\n" +
                            "```\n" +
                            "✅ Pihak WhatsApp sudah merespon...\n" +
                            "Nomor: " + targetNumber + "\n" +
                            "Silahkan login akun WhatsApp anda✨\n" +
                            "```";
                    }
                    
                    await bot.telegram.sendMessage(userId, notifMsg, { parse_mode: 'Markdown' });
                    
                    // Rate limiter baru dihitung ketika ada balasan dari WhatsApp
                    incrementFixRateLimit(userId, 1);
                    
                    if (targetNumber) {
                        await sendNotifFixBerhasil(userId, targetNumber, emailNumber);
                    }
                } catch (err) {
                    console.error('[MONITOR] Gagal kirim notifikasi ke user:', err);
                }
                return;
            }
            
            // Notifikasi "Belum Ada Balasan" setelah 2 menit (4 attempts x 30 detik)
            if (attempts >= 4 && !noReplyNotified && targetNumber) {
                noReplyNotified = true;
                try {
                    const noReplyMsg = "⚠️ <b>BELUM ADA BALASAN FIXMERAH</b>\n" +
                        "═══════════════════════\n" +
                        "<blockquote>📱 Nomor: <code>" + targetNumber + "</code>\n" +
                        "⏳ Belum terdeteksi balasan</blockquote>\n" +
                        "═══════════════════════\n" +
                        "WhatsApp tidak merespon, silahkan coba lagi...";
                    
                    await bot.telegram.sendMessage(userId, noReplyMsg, { parse_mode: 'HTML' });
                } catch (err) {
                    console.error('[MONITOR] Gagal kirim notifikasi no-reply ke user:', err);
                }
            }
            
            if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                console.log('[MONITOR] Monitoring selesai setelah 30 menit tanpa balasan untuk user:', userId);
            }
        } catch (err) {
            console.error('[MONITOR] Error checking email:', err);
        }
    }, 30000);
}

// ==========================================
// PAKASIR PAYMENT GATEWAY FUNCTIONS
// ==========================================

async function createPakasirTransaction(amount, orderId) {
    try {
        const response = await axios.post(`${PAKASIR_BASE_URL}/transactioncreate/qris`, {
            project: PAKASIR_SLUG,
            order_id: orderId,
            amount: amount,
            api_key: PAKASIR_API_KEY
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
        
        return response.data;
    } catch (error) {
        console.error('[PAKASIR] Error creating transaction:', error.response?.data || error.message);
        throw error;
    }
}

async function checkPakasirTransaction(orderId, amount) {
    try {
        const response = await axios.get(`${PAKASIR_BASE_URL}/transactiondetail`, {
            params: {
                project: PAKASIR_SLUG,
                order_id: orderId,
                amount: amount,
                api_key: PAKASIR_API_KEY
            },
            headers: {
                'Accept': 'application/json'
            },
            timeout: 30000
        });
        
        return response.data;
    } catch (error) {
        console.error('[PAKASIR] Error checking transaction:', error.response?.data || error.message);
        throw error;
    }
}

async function cancelPakasirTransaction(orderId, amount) {
    try {
        const response = await axios.post(`${PAKASIR_BASE_URL}/transactioncancel`, {
            project: PAKASIR_SLUG,
            order_id: orderId,
            amount: amount,
            api_key: PAKASIR_API_KEY
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
        
        return response.data;
    } catch (error) {
        console.error('[PAKASIR] Error canceling transaction:', error.response?.data || error.message);
        throw error;
    }
}

// ==========================================
// MIDDLEWARE CEK EXPIRED
// ==========================================

bot.use((ctx, next) => {
    try {
        const userId = ctx.from?.id;
        if (!userId) return next();
        const protectedHears = ['🔧 Fix Nomor', '📝 CEK BIO', '📁 CEK BIO FILE', '📱 CEK NOMOR', '🔍 CEK REPE', '📊 CEK RANGE', '🚫 CEK BANNED', '📁 TO VCF', '📄 TO TXT', '👑 ADMIN/NAVY', '✍️ MANUAL', '✏️ RENAME CTC', '📂 RENAME FILE', '🔗 GABUNG', '✂️ PECAH', '💡 CV PINTAR'];
        if (protectedHears.includes(ctx.message?.text)) {
            if (!hasAccess(userId)) {
                return ctx.reply("❌ AKSES LO UDA EXPIRED LEK\n\nhubungi owner untuk buy akses murah!!\n👑 Owner: @PING0186", mainKeyboard);
            }
        }
        return next();
    } catch (e) {
        console.error('[MIDDLEWARE] Error in expired check:', e);
        return next();
    }
});

// ==========================================
// COMMANDS
// ==========================================

bot.command('panel', safeHandler((ctx) => {
    if (ctx.from.id !== OWNER_ID) return;
    ctx.reply("⚙️ OWNER PANEL:", {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('📊 Tambah Akses', 'add_akses'), Markup.button.callback('🪙 Tambah Point', 'add_point')],
            [Markup.button.callback('🔊 Broadcast', 'bc'), Markup.button.callback('❌ Delete Akses', 'del_akses')],
            [Markup.button.callback('📧 Tambah Email Owner', 'add_owner_email'), Markup.button.callback('📧 List Email Owner', 'list_owner_email')],
            [Markup.button.callback('❌ Hapus Email Owner', 'del_owner_email'), Markup.button.callback('📤 Ambil Email Owner', 'get_owner_email')]
        ]).reply_markup,
        ...ownerKeyboard
    });
}));

// ==========================================
// COMMAND HAPUS EMAIL (FIX MERAH 2)
// ==========================================

bot.command('hapus_email', safeHandler((ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ');
    
    if (args.length < 2) {
        return ctx.reply("❌ Format: /hapus_email <nomor>\nContoh: /hapus_email 1", fixMerah2Keyboard);
    }
    
    const index = parseInt(args[1]) - 1;
    const emails = getUserEmails(userId);
    
    if (isNaN(index) || index < 0 || index >= emails.length) {
        return ctx.reply("❌ Nomor email tidak valid!", fixMerah2Keyboard);
    }
    
    const deletedEmail = emails[index].email;
    deleteUserEmail(userId, index);
    ctx.reply("✅ Email " + deletedEmail + " berhasil dihapus!", fixMerah2Keyboard);
}));

// ==========================================
// START COMMAND - NEW WITH KEYBOARD MENU
// ==========================================

bot.start(safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    const isJoined = await checkJoin(ctx);
    
    const isNewUser = !db.users[userId];
    
    try {
        if (!db.users[userId] || !db.users[userId].akses || Number(db.users[userId].akses) < 1000000000000) {
            db.users[userId] = { 
                ...db.users[userId],
                akses: Date.now() + (30 * 60 * 1000),
                username: ctx.from.username || null,
                first_name: ctx.from.first_name,
                invitedBy: (ctx.payload && ctx.payload != userId) ? ctx.payload : (db.users[userId]?.invitedBy || null),
                limitFix: 2,
                limitCekBio: 2,
                limitCv: 2
            };
            saveDB();
        }
    } catch (e) {
        console.error('[START] Error initializing user:', e);
    }
    
    if (isNewUser) {
        await sendNotifUserBaru(userId, ctx.from.first_name);
    }
    
    if (!isJoined) return ctx.reply("❌ Silahkan join grup & saluran dulu sebelum menggunakan bot!", verifyButtons);
    
    const totalUser = Object.keys(db.users).length;
    
    let totalEmail = db.totalEmail || 0;
    try {
        if (totalEmail === 0 && db.ownerEmails) {
            totalEmail = db.ownerEmails.length;
            for (let uid in db.users) {
                if (db.users[uid].emails) {
                    totalEmail += db.users[uid].emails.length;
                }
            }
        }
    } catch (e) {
        console.error('[START] Error counting emails:', e);
    }
    
    const runtimeMs = Date.now() - BOT_START_TIME;
    const runtimeDays = Math.floor(runtimeMs / (1000 * 60 * 60 * 24));
    const runtimeHours = Math.floor((runtimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const runtimeMinutes = Math.floor((runtimeMs % (1000 * 60 * 60)) / (1000 * 60));
    const runtimeText = runtimeDays > 0 ? runtimeDays + ' Hari ' + runtimeHours + ' Jam' : runtimeHours + ' Jam ' + runtimeMinutes + ' Menit';
    
    const now = new Date();
    const dateText = now.getDate() + ' ' + now.toLocaleString('id-ID', { month: 'long' }) + ' ' + now.getFullYear();
    
    const user = db.users[userId] || {};
    const username = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
    const accessText = getRemainingDays(userId);
    const reffCount = user.reffCount || 0;
    const point = user.point || 0;
    
    const totalFix = db.totalFix || 12629861;
    
    const welcomeMsg = "𓂀 Welcome to the ping bot, please use this bot wisely and responsibly.\n\n" +
        "𝑩  𝑶  𝑻   𝑭  𝑴  -  𝑷  𝑰  𝑵  𝑮\n" +
        "═══════════════════════\n" +
        "👤𝐏𝐫𝐨𝐟𝐢𝐥 𝐔𝐬𝐞𝐫\n" +
        "☻︎ Usᴇʀɴᴀᴍᴇ: " + username + "\n" +
        "☻︎ Aᴄᴄᴇss: " + accessText + "\n" +
        "☻︎ Rᴇғғᴇʀᴀʟ: " + reffCount + "\n" +
        "☻︎ Pᴏɪɴᴛ: " + point + "\n" +
        "═══════════════════════\n" +
        "✨𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐭𝐢𝐨𝐧\n" +
        "☻︎ Vᴇʀsɪᴏɴ: 2.3\n" +
        "☻︎ Rᴜɴ Tɪᴍᴇ: " + runtimeText + "\n" +
        "☻︎ Dᴀᴛᴇ: " + dateText + "\n" +
        "═══════════════════════\n" +
        "🌍 𝐒𝐭𝐚𝐭𝐢𝐬𝐭𝐢𝐤 𝐆𝐥𝐨𝐛𝐚𝐥\n" +
        "☻︎ Tᴏᴛᴀʟ Usᴇʀ: " + totalUser + "\n" +
        "☻︎ Tᴏᴛᴀʟ Eᴍᴀɪʟ: " + totalEmail + "\n" +
        "☻︎ Tᴏᴛᴀʟ Fɪx: " + totalFix.toLocaleString('id-ID') + "\n" +
        "═══════════════════════\n" +
        "☏︎ @PING0186";
    
    const startButtons = Markup.inlineKeyboard([
        [
            Markup.button.callback('𝐅𝐈𝐓𝐔𝐑𝐄 🔧', 'menu_fitur'),
            Markup.button.callback('𝐏𝐑𝐄𝐌𝐈𝐔𝐌 💎', 'menu_premium')
        ],
        [Markup.button.callback('𝐎𝐓𝐇𝐄𝐑 𝐈𝐍𝐅𝐎 📑', 'menu_other')]
    ]);
    
    try {
        await ctx.replyWithPhoto(
            { source: './awal.jpg' },
            { 
                caption: welcomeMsg
            }
        );
        await ctx.reply('⌨️ Pilih menu di bawah:', userId === OWNER_ID ? ownerKeyboard : mainKeyboard);
    } catch (err) {
        console.error('[START] Error sending photo:', err);
        await ctx.reply(welcomeMsg);
        await ctx.reply('⌨️ Pilih menu di bawah:', userId === OWNER_ID ? ownerKeyboard : mainKeyboard);
    }
}));

// ==========================================
// CALLBACK MENU UTAMA
// ==========================================

bot.action('menu_fitur', safeCallback(async (ctx) => {
    const fiturMsg = "𝐅𝐈𝐓𝐔𝐑𝐄 𝐁𝐎𝐓:\n" +
        "═══════════════════════\n" +
        "```\n" +
        "🔧 Fix Nomor - Fix Nomor WhatsApp Tanpa Login\n" +
        "📊 Status            - Info Akun\n" +
        "💳 Buy Akses         - List Harga\n" +
        "💡 Tutorial          - Cara Pake Bot\n" +
        "📁 Fitur CV          - Konversi File\n" +
        "```\n" +
        "═══════════════════════\n" +
        "please use this bot wisely and responsibly.";
    
    const backButton = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Kembali', 'menu_back')]
    ]);
    
    try {
        await ctx.editMessageCaption(fiturMsg, { 
            reply_markup: backButton.reply_markup 
        });
    } catch (err) {
        console.error('[MENU FITUR] Error edit caption:', err);
        await ctx.reply(fiturMsg, { 
            reply_markup: backButton.reply_markup 
        });
    }
    ctx.answerCbQuery('𝐅𝐈𝐓𝐔𝐑𝐄 🔧');
}));

bot.action('menu_premium', safeCallback(async (ctx) => {
    const premiumMsg = "𝐌𝐀𝐍𝐅𝐀𝐀𝐓 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 💎\n" +
        "☻︎ Fix nomor tanpa login\n" +
        "☻︎ Unlimited fix nomor\n" +
        "☻︎ Terbuka semua fitur\n" +
        "☻︎ Bisa fix 5 nomor sekaligus\n" +
        "☻︎ Fitur CV lengkap\n" +
        "☻︎ Dan masih banyak lagi\n" +
        "═══════════════════════\n" +
        "𝐇𝐀𝐑𝐆𝐀 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 💸\n" +
        "☻︎ 3 Hari = Rp2.000\n" +
        "☻︎ 5 Hari = Rp3.000\n" +
        "☻︎ 7 Hari = Rp4.500\n" +
        "☻︎ 14 Hari = Rp7.000\n" +
        "☻︎ 30 Hari = Rp9.000\n\n" +
        "Langsung saja klik fitur \"💳 Buy Akses\" untuk beli akses dengan harga murah💫\n" +
        "═══════════════════════";
    
    const backButton = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Kembali', 'menu_back')]
    ]);
    
    try {
        await ctx.editMessageCaption(premiumMsg, { 
            reply_markup: backButton.reply_markup 
        });
    } catch (err) {
        console.error('[MENU PREMIUM] Error edit caption:', err);
        await ctx.reply(premiumMsg, { 
            reply_markup: backButton.reply_markup 
        });
    }
    ctx.answerCbQuery('𝐏𝐑𝐄𝐌𝐈𝐔𝐌 💎');
}));

bot.action('menu_other', safeCallback(async (ctx) => {
    const otherMsg = "📌 𝐎𝐓𝐇𝐄𝐑 𝐈𝐍𝐅𝐎 📑\n\n" +
        "🤖 𝐓𝐞𝐧𝐭𝐚𝐧𝐠 𝐁𝐨𝐭\n" +
        "Bot ini dibuat untuk membantu pengguna dalam melakukan fix nomor WhatsApp yang bermasalah dengan sistem email otomatis, cek bio WhatsApp, dan konversi file kontak.\n\n" +
        "📢 𝐆𝐫𝐮𝐩 & 𝐒𝐚𝐥𝐮𝐫𝐚𝐧\n" +
        "• Grup Utama: @CUANBARENG_PING\n" +
        "• Grup Store: @STORWA_PING\n" +
        "• Saluran: Klik tombol di bawah\n\n" +
        "⚠️ 𝐊𝐞𝐭𝐞𝐧𝐭𝐮𝐚𝐧\n" +
        "• Dilarang spam fitur bot\n" +
        "• Dilarang menyalahgunakan fitur\n" +
        "• Gunakan bot dengan bijak\n\n" +
        "📞 𝐊𝐨𝐧𝐭𝐚𝐤 𝐎𝐰𝐧𝐞𝐫\n" +
        "Jika ada kendala atau ingin bekerja sama, silahkan hubungi @PING0186\n\n" +
        "═══════════════════════\n" +
        "✨ Terima kasih telah menggunakan bot kami!";
    
    const otherButtons = Markup.inlineKeyboard([
        [Markup.button.url('📢 Join Grup', GRUP_LINK)],
        [Markup.button.url('📣 Join Saluran', SALURAN_LINK)],
        [Markup.button.url('📦 TESTIMONI', GRUP_STOR_LINK)],
        [Markup.button.callback('⬅️ Kembali', 'menu_back')]
    ]);
    
    try {
        await ctx.editMessageCaption(otherMsg, { 
            reply_markup: otherButtons.reply_markup 
        });
    } catch (err) {
        console.error('[MENU OTHER] Error edit caption:', err);
        await ctx.reply(otherMsg, { 
            reply_markup: otherButtons.reply_markup 
        });
    }
    ctx.answerCbQuery('𝐎𝐓𝐇𝐄𝐑 𝐈𝐍𝐅𝐎 📑');
}));

bot.action('menu_back', safeCallback(async (ctx) => {
    const userId = ctx.from.id;
    
    const totalUser = Object.keys(db.users).length;
    
    let totalEmail = db.totalEmail || 0;
    try {
        if (totalEmail === 0 && db.ownerEmails) {
            totalEmail = db.ownerEmails.length;
            for (let uid in db.users) {
                if (db.users[uid].emails) {
                    totalEmail += db.users[uid].emails.length;
                }
            }
        }
    } catch (e) {
        console.error('[MENU BACK] Error counting emails:', e);
    }
    
    const runtimeMs = Date.now() - BOT_START_TIME;
    const runtimeDays = Math.floor(runtimeMs / (1000 * 60 * 60 * 24));
    const runtimeHours = Math.floor((runtimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const runtimeMinutes = Math.floor((runtimeMs % (1000 * 60 * 60)) / (1000 * 60));
    const runtimeText = runtimeDays > 0 ? runtimeDays + ' Hari ' + runtimeHours + ' Jam' : runtimeHours + ' Jam ' + runtimeMinutes + ' Menit';
    
    const now = new Date();
    const dateText = now.getDate() + ' ' + now.toLocaleString('id-ID', { month: 'long' }) + ' ' + now.getFullYear();
    
    const user = db.users[userId] || {};
    const username = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
    const accessText = getRemainingDays(userId);
    const totalFix = db.totalFix || 12629861;
    
    const welcomeMsg = "𓂀 Welcome to the ping bot, please use this bot wisely and responsibly.\n\n" +
        "𝑩  𝑶  𝑻   𝑭  𝑴  -  𝑷  𝑰  𝑵  𝑮\n" +
        "═══════════════════════\n" +
        "👤𝐏𝐫𝐨𝐟𝐢𝐥 𝐔𝐬𝐞𝐫\n" +
        "☻︎ Usᴇʀɴᴀᴍᴇ: " + username + "\n" +
        "☻︎ Aᴄᴄᴇss: " + accessText + "\n" +
        "☻︎ Rᴇғғᴇʀᴀʟ: " + (user.reffCount || 0) + "\n" +
        "☻︎ Pᴏɪɴᴛ: " + (user.point || 0) + "\n" +
        "═══════════════════════\n" +
        "✨𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐭𝐢𝐨𝐧\n" +
        "☻︎ Vᴇʀsɪᴏɴ: 2.3\n" +
        "☻︎ Rᴜɴ Tɪᴍᴇ: " + runtimeText + "\n" +
        "☻︎ Dᴀᴛᴇ: " + dateText + "\n" +
        "═══════════════════════\n" +
        "🌍 𝐒𝐭𝐚𝐭𝐢𝐬𝐭𝐢𝐤 𝐆𝐥𝐨𝐛𝐚𝐥\n" +
        "☻︎ Tᴏᴛᴀʟ Usᴇʀ: " + totalUser + "\n" +
        "☻︎ Tᴏᴛᴀʟ Eᴍᴀɪʟ: " + totalEmail + "\n" +
        "☻︎ Tᴏᴛᴀʟ Fɪx: " + totalFix.toLocaleString('id-ID') + "\n" +
        "═══════════════════════\n" +
        "☏︎ @PING0186";
    
    const startButtons = Markup.inlineKeyboard([
        [
            Markup.button.callback('𝐅𝐈𝐓𝐔𝐑𝐄 🔧', 'menu_fitur'),
            Markup.button.callback('𝐏𝐑𝐄𝐌𝐈𝐔𝐌 💎', 'menu_premium')
        ],
        [Markup.button.callback('𝐎𝐓𝐇𝐄𝐑 𝐈𝐍𝐅𝐎 📑', 'menu_other')]
    ]);
    
    try {
        await ctx.editMessageCaption(welcomeMsg, { 
            reply_markup: startButtons.reply_markup 
        });
    } catch (err) {
        console.error('[MENU BACK] Error edit caption:', err);
        await ctx.reply(welcomeMsg, startButtons);
    }
    ctx.answerCbQuery('⬅️ Kembali');
}));

// ==========================================
// NEW KEYBOARD MENU HANDLERS
// ==========================================
// 🛠 FIX MERAH - Menu utama Fix Merah
bot.hears('🛠 FIX MERAH', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    const isJoined = await checkJoin(ctx);
    if (!isJoined) return ctx.reply("❌ Silahkan join grup & saluran dulu!", verifyButtons);
    
    ctx.reply(
        "```\n" +
        "🛠 FIX MERAH MENU\n\n" +
        "Pilih fitur yang ingin digunakan:\n\n" +
        "🔧 Fix Nomor — Fix nomor WhatsApp\n" +
        "📊 Status — Info akun\n" +
        "💳 Buy Akses — Beli akses premium\n" +
        "💡 Tutorial — Cara pakai bot\n" +
        "```",
        { parse_mode: 'Markdown', ...fixMerahKeyboard }
    );
}));

// 🛠 FIX MERAH 2 - Menu Fix Merah dengan email sendiri
bot.hears('🛠 FIX MERAH 2', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    const isJoined = await checkJoin(ctx);
    if (!isJoined) return ctx.reply("❌ Silahkan join grup & saluran dulu!", verifyButtons);
    
    const userEmails = getUserEmails(userId);
    const emailCount = userEmails.length;
    
    ctx.reply(
        "```\n" +
        "🛠 FIX MERAH 2 MENU\n\n" +
        "Pilih fitur yang ingin digunakan:\n\n" +
        "🔧 Fix Nomor 2 — Fix nomor WhatsApp pakai email sendiri\n" +
        "📧 Tambah Email — Tambah email Gmail + App Password\n" +
        "📧 List Email — Lihat daftar email yang tersimpan\n" +
        "📊 Status — Info akun\n" +
        "💳 Buy Akses — Beli akses premium\n" +
        "\n📧 Email tersimpan: " + emailCount + " email\n" +
        "```",
        { parse_mode: 'Markdown', ...fixMerah2Keyboard }
    );
}));

// 📱 CEK BIO - Menu utama Cek Bio
bot.hears('📱 CEK BIO', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    const isJoined = await checkJoin(ctx);
    if (!isJoined) return ctx.reply("❌ Silahkan join grup & saluran dulu!", verifyButtons);
    
    ctx.reply(
        "```\n" +
        "📱 CEK BIO MENU\n\n" +
        "Pilih fitur yang ingin digunakan:\n\n" +
        "📝 CEK BIO — Cek bio lengkap\n" +
        "📁 CEK BIO FILE — Cek bio via file\n" +
        "📱 CEK NOMOR — Cek informasi nomor\n" +
        "🔍 CEK REPE — Cek reputasi & aktivitas\n" +
        "📊 CEK RANGE — Perkiraan umur akun\n" +
        "🚫 CEK BANNED — Cek nomor banned\n\n" +
        "💡 Note: Pastikan sudah login WhatsApp sender terlebih dahulu!\n" +
        "```",
        { parse_mode: 'Markdown', ...cekBioKeyboard }
    );
}));

// 📁 FITUR CV - Menu utama Fitur CV
bot.hears('📁 FITUR CV', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    const isJoined = await checkJoin(ctx);
    if (!isJoined) return ctx.reply("❌ Silahkan join grup & saluran dulu!", verifyButtons);
    
    const limitInfo = getLimitInfo(userId);
    
    ctx.reply(
        "```\n" +
        "📁 FITUR CV MENU\n\n" +
        "Pilih fitur konversi yang ingin digunakan:\n\n" +
        "📁 TO VCF      — Konversi file ke .vcf\n" +
        "📄 TO TXT      — Konversi file ke .txt\n" +
        "👑 ADMIN/NAVY  — Fitur admin/navy\n" +
        "✍️ MANUAL      — Input kontak manual\n" +
        "✏️ RENAME CTC  — Ganti nama kontak\n" +
        "📂 RENAME FILE — Ganti nama file\n" +
        "🔗 GABUNG      — Gabungkan file\n" +
        "✂️ PECAH       — Pecah file\n" +
        "💡 CV PINTAR   — Konversi otomatis grup\n" +
        "```" +
        limitInfo,
        { parse_mode: 'Markdown', ...cvKeyboard }
    );
}));

// ⬅️ KEMBALI - Back to main menu
bot.hears('⬅️ KEMBALI', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    ctx.reply(
        "🏠 *MENU UTAMA*\n\n" +
        "Silahkan pilih menu:",
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
}));

// ==========================================
// FIX MERAH SUB-MENU (ORIGINAL BOT 1)
// ==========================================

bot.hears('❌ BATAL', safeHandler((ctx) => {
    ctx.session = null;
    ctx.reply("❌ Aksi dibatalkan.", ctx.from.id === OWNER_ID ? ownerKeyboard : mainKeyboard);
}));

bot.hears('💡 Tutorial', safeHandler((ctx) => {
    ctx.reply("Cara menggunakan bot fix merah free:\nhttps://youtu.be/Vs_xcyQLl_Q?si=-Ca5MHjwaUno3Eb_", ctx.from.id === OWNER_ID ? ownerKeyboard : mainKeyboard);
}));

bot.hears('📊 Status', safeHandler((ctx) => {
    const userId = ctx.from.id;
    const user = db.users[userId] || {};
    const remaining = getRemainingDays(userId);
    const displayAkses = remaining === 'permanen' ? 'Permanen' : (remaining !== 0 ? remaining : 'Expired');
    let statusMsg = "User : @" + (user.username || ctx.from.first_name) + "\n\n📊 Status: Aktif (" + displayAkses + ")\n👑 Owner: @PING0186";
    ctx.reply(statusMsg);
}));

bot.hears('🔧 Fix Nomor', safeHandler((ctx) => {
    const userId = ctx.from.id;
    
    // Cek rate limiter dulu
    const rateCheck = checkFixRateLimit(userId);
    if (!rateCheck.allowed) {
        return ctx.reply(rateCheck.message, { parse_mode: 'Markdown', ...(userId === OWNER_ID ? ownerKeyboard : mainKeyboard) });
    }
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'fix')) {
            return ctx.reply("❌ LIMIT FREE SUDAH HABIS!\n\nHubungi owner untuk buy akses murah!!\n👑 Owner: @PING0186", userId === OWNER_ID ? ownerKeyboard : mainKeyboard);
        }
    }
    
    if (!db.ownerEmails || db.ownerEmails.length === 0) {
        return ctx.reply("❌ Email owner kosong. Silahkan hubungi owner.", ctx.from.id === OWNER_ID ? ownerKeyboard : mainKeyboard);
    }
    
    const validOwnerEmails = db.ownerEmails.filter(e => e && e.email && e.appPass);
    if (validOwnerEmails.length === 0) {
        return ctx.reply("❌ Tidak ada email owner yang valid.", ctx.from.id === OWNER_ID ? ownerKeyboard : mainKeyboard);
    }
    
    // Ambil info rate limiter untuk tampilan batas bulk
    const rateInfo = getFixRateLimitInfo(userId);
    const bulkText = "🔃 Batas bulk anda saat ini: " + rateInfo.count + "/" + rateInfo.max + " nomor";
    
    ctx.session = { step: 'FIX_NOMOR_NO_SENDER' };
    const msg = "📝 Kirim nomor yang mau di fix.\n" +
        "═══════════════════════\n" +
        "```\n" +
        "Contoh: +628xxxxxx\n" +
        "```\n" +
        "Atau sekaligus seperti ini:\n" +
        "```\n" +
        "+628xxxxxxx\n" +
        "+221xxxxxxx\n" +
        "+225xxxxxxx\n" +
        "+509xxxxxxx\n" +
        "+234xxxxxxx\n" +
        "```\n" +
        "Maximal 5 dan dipisahkan dengan enter\n\n" +
        "Tidak ada spasi, tidak ada tanda - dan harus menggunakan tanda + di awal.\n\n" +
        bulkText;
    ctx.reply(msg, { parse_mode: 'Markdown', ...backKeyboard });
}));

// ==========================================
// FIX MERAH 2 HANDLERS
// ==========================================

bot.hears('📧 Tambah Email', safeHandler((ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        return ctx.reply("❌ AKSES LO UDA EXPIRED LEK\n\nhubungi owner untuk buy akses murah!!\n👑 Owner: @PING0186", mainKeyboard);
    }
    
    ctx.session = { step: 'FM2_ADD_EMAIL' };
    ctx.reply(
        "📧 TAMBAH EMAIL (FIX MERAH 2)\n\n" +
        "Kirim email dan App Password dalam format:\n" +
        "```\n" +
        "email@gmail.com|apppassword\n" +
        "```\n\n" +
        "Atau banyak sekaligus:\n" +
        "```\n" +
        "email1@gmail.com|password1\n" +
        "email2@gmail.com|password2\n" +
        "```\n\n" +
        "⚠️ Pastikan menggunakan App Password Gmail (16 digit), bukan password biasa!",
        { parse_mode: 'Markdown', ...backKeyboard }
    );
}));

bot.hears('📧 List Email', safeHandler((ctx) => {
    const userId = ctx.from.id;
    const emails = getUserEmails(userId);
    
    if (emails.length === 0) {
        return ctx.reply(
            "📭 Belum ada email yang tersimpan.\n\n" +
            "Tambah email dulu dengan menu 📧 Tambah Email",
            fixMerah2Keyboard
        );
    }
    
    let msg = "📧 DAFTAR EMAIL ANDA (" + emails.length + " email):\n\n";
    emails.forEach((item, index) => {
        msg += (index + 1) + ". " + item.email + "\n";
    });
    
    msg += "\nUntuk menghapus email, kirim format:\n/hapus_email <nomor>\nContoh: /hapus_email 1";
    
    ctx.reply(msg, fixMerah2Keyboard);
}));

bot.hears('🔧 Fix Nomor 2', safeHandler((ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'fix')) {
            return ctx.reply("❌ LIMIT FREE SUDAH HABIS!\n\nHubungi owner untuk buy akses murah!!\n👑 Owner: @PING0186", userId === OWNER_ID ? ownerKeyboard : mainKeyboard);
        }
    }
    
    const userEmails = getUserEmails(userId);
    if (userEmails.length === 0) {
        return ctx.reply(
            "❌ Anda belum memiliki email!\n\n" +
            "Tambah email dulu dengan menu 📧 Tambah Email\n\n" +
            "Format: email@gmail.com|apppassword",
            fixMerah2Keyboard
        );
    }
    
    const validEmails = userEmails.filter(e => e && e.email && e.appPass);
    if (validEmails.length === 0) {
        return ctx.reply("❌ Tidak ada email yang valid.", fixMerah2Keyboard);
    }
    
    // Cek rate limiter
    const rateCheck = checkFixRateLimit(userId);
    if (!rateCheck.allowed) {
        return ctx.reply(rateCheck.message, { parse_mode: 'Markdown', ...(userId === OWNER_ID ? ownerKeyboard : mainKeyboard) });
    }
    
    ctx.session = { step: 'FIX_NOMOR_2' };
    const msg = "📝 Kirim nomor yang mau di fix (FIX MERAH 2).\n" +
        "═══════════════════════\n" +
        "```\n" +
        "Contoh: +628xxxxxx\n" +
        "```\n" +
        "Atau sekaligus seperti ini:\n" +
        "```\n" +
        "+628xxxxxxx\n" +
        "+221xxxxxxx\n" +
        "+225xxxxxxx\n" +
        "+509xxxxxxx\n" +
        "+234xxxxxxx\n" +
        "```\n" +
        "Maximal 5 dan dipisahkan dengan enter\n\n" +
        "Tidak ada spasi, tidak ada tanda - dan harus menggunakan tanda + di awal.";
    ctx.reply(msg, { parse_mode: 'Markdown', ...backKeyboard });
}));

bot.hears('⚙️ Owner Panel', safeHandler((ctx) => {
    if (ctx.from.id !== OWNER_ID) {
        return ctx.reply("❌ Fitur ini hanya untuk owner!", ctx.from.id === OWNER_ID ? ownerKeyboard : mainKeyboard);
    }
    ctx.reply("⚙️ OWNER PANEL:", {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('📊 Tambah Akses', 'add_akses'), Markup.button.callback('🪙 Tambah Point', 'add_point')],
            [Markup.button.callback('🔊 Broadcast', 'bc'), Markup.button.callback('❌ Delete Akses', 'del_akses')],
            [Markup.button.callback('📧 Tambah Email Owner', 'add_owner_email'), Markup.button.callback('📧 List Email Owner', 'list_owner_email')],
            [Markup.button.callback('❌ Hapus Email Owner', 'del_owner_email'), Markup.button.callback('📤 Ambil Email Owner', 'get_owner_email')]
        ]).reply_markup
    });
}));

// ==========================================
// BUY AKSES - PAKASIR PAYMENT GATEWAY
// ==========================================

const PAKET_AKSES = {
    '3_hari': { hari: 3, harga: 2000, label: '3 Hari' },
    '5_hari': { hari: 5, harga: 3000, label: '5 Hari' },
    '7_hari': { hari: 7, harga: 4500, label: '7 Hari' },
    '14_hari': { hari: 14, harga: 7000, label: '14 Hari' },
    '30_hari': { hari: 30, harga: 9000, label: '30 Hari' }
};

bot.hears('💳 Buy Akses', safeHandler((ctx) => {
const buyKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⏳ 3 Hari', 'buy_3_hari'), Markup.button.callback('⏳ 5 Hari', 'buy_5_hari')],
    [Markup.button.callback('📅 7 Hari', 'buy_7_hari'), Markup.button.callback('📅 14 Hari', 'buy_14_hari')],
    [Markup.button.callback('📅 30 Hari', 'buy_30_hari')],
    [Markup.button.callback('❌ Tutup', 'tutup_buy')]
]);

    
    ctx.reply("💳 PILIH PAKET AKSES\n\n⏳ 3 Hari = Rp2.000\n⏳ 5 Hari = Rp3.000\n📅 7 Hari = Rp4.500\n📅 14 Hari = Rp7.000\n📅 30 Hari = Rp9.000\n\nKlik tombol di bawah untuk membeli:", buyKeyboard);
}));

bot.action('buy_3_hari', safeCallback((ctx) => handleBuyAkses(ctx, '3_hari')));
bot.action('buy_5_hari', safeCallback((ctx) => handleBuyAkses(ctx, '5_hari')));
bot.action('buy_7_hari', safeCallback((ctx) => handleBuyAkses(ctx, '7_hari')));
bot.action('buy_14_hari', safeCallback((ctx) => handleBuyAkses(ctx, '14_hari')));
bot.action('buy_30_hari', safeCallback((ctx) => handleBuyAkses(ctx, '30_hari')));


async function handleBuyAkses(ctx, paketKey) {
    try {
        const paket = PAKET_AKSES[paketKey];
        const userId = ctx.from.id;
        
        const orderId = `PING_${userId}_${Date.now()}`;
        
        const transaction = await createPakasirTransaction(
            paket.harga,
            orderId
        );
        
        if (!transaction || !transaction.payment) {
            return ctx.answerCbQuery('❌ Gagal membuat transaksi. Coba lagi!', { show_alert: true });
        }
        
        const payment = transaction.payment;
        
        const paymentId = orderId;
        db.pendingPayments[paymentId] = {
            userId: userId,
            username: ctx.from.username || null,
            firstName: ctx.from.first_name,
            paket: paketKey,
            hari: paket.hari,
            harga: paket.harga,
            label: paket.label,
            timestamp: Date.now(),
            status: 'pending',
            pakasirOrderId: orderId,
            pakasirAmount: paket.harga,
            pakasirQrString: payment.payment_number || null,
            pakasirTotalPayment: payment.total_payment || paket.harga,
            pakasirExpiredAt: payment.expired_at || null
        };
        saveDB();
        
        ctx.session = { 
            step: 'WAITING_PAYMENT', 
            buyPaket: paketKey,
            buyHarga: paket.harga,
            buyHari: paket.hari,
            paymentId: paymentId
        };
        
        const expiredTime = payment.expired_at ? new Date(payment.expired_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '15 menit';
        const totalPayment = payment.total_payment ? payment.total_payment.toLocaleString('id-ID') : paket.harga.toLocaleString('id-ID');
        
        const caption = "💳 PEMBAYARAN AKSES " + paket.label.toUpperCase() + "\n\n" +
                       "📦 Paket: " + paket.label + "\n" +
                       "💰 Harga: Rp" + paket.harga.toLocaleString('id-ID') + "\n" +
                       "💳 Total Bayar: Rp" + totalPayment + "\n" +
                       "⏰ Expired: " + expiredTime + "\n\n" +
                       "📌 CARA PEMBAYARAN:\n" +
                       "1. Scan QRIS di atas menggunakan aplikasi e-wallet atau mobile banking\n" +
                       "2. Lakukan pembayaran sesuai nominal\n" +
                       "3. Tunggu konfirmasi otomatis dari sistem\n" +
                       "4. Akses akan otomatis masuk ke akun anda\n\n" +
                       "⚠️ NOTE:\n" +
                       "• Pembayaran harus sesuai nominal\n" +
                       "• QRIS akan expired dalam 15 menit\n" +
                       "• Jika pembayaran gagal, silahkan coba lagi\n\n" +
                       "⏳ Status: Menunggu pembayaran...";
        
        try {
            if (payment.payment_number) {
                const qrBuffer = await QRCode.toBuffer(payment.payment_number, {
                    type: 'png',
                    width: 400,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });
                
                await ctx.replyWithPhoto(
                    { source: qrBuffer },
                    { 
                        caption: caption,
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔄 Cek Status', 'cek_status_' + paymentId)],
                            [Markup.button.callback('❌ Batal', 'batal_bayar_' + paymentId)]
                        ]).reply_markup
                    }
                );
            } else {
                await ctx.reply(
                    caption + "\n\n❌ QRIS tidak tersedia saat ini. Silahkan coba lagi.",
                    { 
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔄 Coba Lagi', 'cek_status_' + paymentId)],
                            [Markup.button.callback('❌ Batal', 'batal_bayar_' + paymentId)]
                        ]).reply_markup
                    }
                );
            }
            
            await ctx.answerCbQuery('Silahkan scan QRIS untuk pembayaran!');
        } catch (err) {
            console.error('[BUY] Error kirim QRIS:', err);
            ctx.reply('❌ Gagal memuat QRIS. Silahkan coba lagi.');
            ctx.session = null;
            delete db.pendingPayments[paymentId];
            saveDB();
        }
        
        startPaymentPolling(paymentId, userId, paket, bot);
        
    } catch (error) {
        console.error('[BUY] Error in handleBuyAkses:', error);
        ctx.answerCbQuery('⚠️ Terjadi kesalahan', { show_alert: true });
    }
}

function startPaymentPolling(paymentId, userId, paket, botInstance) {
    const payment = db.pendingPayments[paymentId];
    if (!payment) return;
    
    const maxAttempts = 180;
    let attempts = 0;
    
    const pollInterval = setInterval(async () => {
        attempts++;
        
        try {
            const currentPayment = db.pendingPayments[paymentId];
            if (!currentPayment || currentPayment.status !== 'pending') {
                clearInterval(pollInterval);
                return;
            }
            
            const statusResponse = await checkPakasirTransaction(currentPayment.pakasirOrderId, currentPayment.pakasirAmount);
            
            if (statusResponse && statusResponse.transaction) {
                const transStatus = statusResponse.transaction.status;
                
                if (transStatus === 'completed' || transStatus === 'paid' || transStatus === 'success') {
                    clearInterval(pollInterval);
                    await processPaymentSuccess(paymentId, userId, paket, botInstance);
                } else if (transStatus === 'expired' || transStatus === 'failed' || transStatus === 'cancelled' || transStatus === 'canceled') {
                    clearInterval(pollInterval);
                    await processPaymentFailed(paymentId, userId, botInstance, 'Pembayaran ' + transStatus);
                }
            }
            
            if (attempts >= maxAttempts) {
                clearInterval(pollInterval);
                await processPaymentFailed(paymentId, userId, botInstance, 'Waktu pembayaran habis (30 menit)');
            }
        } catch (err) {
            console.error('[POLLING] Error checking payment status:', err);
        }
    }, 10000);
    
    if (autoApproveTimers[paymentId]) {
        autoApproveTimers[paymentId].pollInterval = pollInterval;
    } else {
        autoApproveTimers[paymentId] = { pollInterval: pollInterval };
    }
}

async function processPaymentSuccess(paymentId, userId, paket, botInstance) {
    try {
        const payment = db.pendingPayments[paymentId];
        if (!payment || payment.status !== 'pending') {
            return;
        }
        
        payment.status = 'approved';
        saveDB();
        
        if (!db.users[userId]) {
            db.users[userId] = { 
                point: 0, 
                reffCount: 0, 
                akses: Date.now(),
                emails: [], 
                currentEmailIndex: 0,
                limitFix: 2,
                limitCekBio: 2,
                limitCv: 2
            };
        }
        
        const current = (typeof db.users[userId].akses === 'number' && db.users[userId].akses > Date.now()) 
            ? db.users[userId].akses 
            : Date.now();
        db.users[userId].akses = current + (payment.hari * 24 * 60 * 60 * 1000);
        saveDB();
        
        await sendNotifTransaksiBerhasil(userId, payment.label, payment.harga);
        
        try {
            await botInstance.telegram.sendMessage(
                userId,
                "🎉 PEMBAYARAN BERHASIL!\n\n" +
                "✅ Pembayaran Anda telah dikonfirmasi otomatis oleh sistem.\n\n" +
                "📦 Paket: " + payment.label + "\n" +
                "💰 Nominal: Rp" + payment.harga.toLocaleString('id-ID') + "\n" +
                "⏳ Akses ditambahkan ke akun: " + (db.users[userId].username ? "@" + db.users[userId].username : userId) + "\n\n" +
                "Terima kasih telah menggunakan layanan kami! 🙏",
                userId === OWNER_ID ? ownerKeyboard : mainKeyboard
            );
        } catch (err) {
            console.error('[PAYMENT SUCCESS] Gagal kirim notifikasi ke user:', err);
        }
        
        try {
            await botInstance.telegram.sendMessage(
                OWNER_ID,
                "✅ PEMBAYARAN OTOMATIS BERHASIL\n\n" +
                "👤 User ID: <code>" + userId + "</code>\n" +
                "👤 Username: " + (payment.username ? "@" + payment.username : 'Tidak ada') + "\n" +
                "👤 Nama: " + payment.firstName + "\n\n" +
                "📦 Paket: " + payment.label + "\n" +
                "💰 Harga: Rp" + payment.harga.toLocaleString('id-ID') + "\n" +
                "⏰ Status: ✅ Berhasil (Otomatis via Pakasir)\n\n" +
                "Pembayaran ini telah otomatis dikonfirmasi oleh sistem Pakasir.",
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            console.error('[PAYMENT SUCCESS] Gagal kirim notifikasi ke owner:', err);
        }
        
        if (autoApproveTimers[paymentId]) {
            if (autoApproveTimers[paymentId].pollInterval) {
                clearInterval(autoApproveTimers[paymentId].pollInterval);
            }
            delete autoApproveTimers[paymentId];
        }
        
    } catch (err) {
        console.error('[PAYMENT SUCCESS] Error processing payment success:', err);
    }
}

async function processPaymentFailed(paymentId, userId, botInstance, reason) {
    try {
        const payment = db.pendingPayments[paymentId];
        if (!payment) return;
        
        payment.status = 'rejected';
        saveDB();
        
        try {
            await botInstance.telegram.sendMessage(
                userId,
                "❌ PEMBAYARAN GAGAL\n\n" +
                "Maaf, pembayaran Anda tidak berhasil.\n\n" +
                "📦 Paket: " + payment.label + "\n" +
                "💰 Nominal: Rp" + payment.harga.toLocaleString('id-ID') + "\n" +
                "❌ Alasan: " + reason + "\n\n" +
                "Silahkan coba lagi dengan menekan 💳 Buy Akses.\n" +
                "👑 Owner: @PING0186",
                userId === OWNER_ID ? ownerKeyboard : mainKeyboard
            );
        } catch (err) {
            console.error('[PAYMENT FAILED] Gagal kirim notifikasi ke user:', err);
        }
        
        if (autoApproveTimers[paymentId]) {
            if (autoApproveTimers[paymentId].pollInterval) {
                clearInterval(autoApproveTimers[paymentId].pollInterval);
            }
            delete autoApproveTimers[paymentId];
        }
        
    } catch (err) {
        console.error('[PAYMENT FAILED] Error processing payment failed:', err);
    }
}

bot.action(/^cek_status_(.+)$/, safeCallback(async (ctx) => {
    const paymentId = ctx.match[1];
    const payment = db.pendingPayments[paymentId];
    const userId = ctx.from.id;
    
    if (!payment) {
        return ctx.answerCbQuery('❌ Data pembayaran tidak ditemukan!', { show_alert: true });
    }
    
    if (payment.userId !== userId) {
        return ctx.answerCbQuery('❌ Bukan pembayaran Anda!', { show_alert: true });
    }
    
    if (payment.status !== 'pending') {
        return ctx.answerCbQuery('❌ Pembayaran sudah diproses!', { show_alert: true });
    }
    
    try {
        await ctx.answerCbQuery('🔄 Mengecek status pembayaran...');
        
        const statusResponse = await checkPakasirTransaction(payment.pakasirOrderId, payment.pakasirAmount);
        
        if (statusResponse && statusResponse.transaction) {
            const transStatus = statusResponse.transaction.status;
            
            if (transStatus === 'completed' || transStatus === 'paid' || transStatus === 'success') {
                const paket = PAKET_AKSES[payment.paket];
                await processPaymentSuccess(paymentId, userId, paket, bot);
                ctx.answerCbQuery('✅ Pembayaran berhasil!', { show_alert: true });
            } else if (transStatus === 'pending') {
                ctx.answerCbQuery('⏳ Pembayaran masih pending. Silahkan selesaikan pembayaran.', { show_alert: true });
            } else {
                ctx.answerCbQuery('❌ Status: ' + transStatus + '. Silahkan coba lagi.', { show_alert: true });
            }
        } else {
            ctx.answerCbQuery('❌ Gagal mengecek status. Coba lagi nanti.', { show_alert: true });
        }
    } catch (err) {
        console.error('[CEK STATUS] Error:', err);
        ctx.answerCbQuery('❌ Gagal mengecek status.', { show_alert: true });
    }
}));

bot.action(/^batal_bayar_(.+)$/, safeCallback(async (ctx) => {
    const paymentId = ctx.match[1];
    const payment = db.pendingPayments[paymentId];
    const userId = ctx.from.id;
    
    if (!payment) {
        return ctx.answerCbQuery('❌ Data pembayaran tidak ditemukan!', { show_alert: true });
    }
    
    if (payment.userId !== userId) {
        return ctx.answerCbQuery('❌ Bukan pembayaran Anda!', { show_alert: true });
    }
    
    if (payment.status !== 'pending') {
        return ctx.answerCbQuery('❌ Pembayaran sudah diproses!', { show_alert: true });
    }
    
    try {
        if (payment.pakasirOrderId) {
            await cancelPakasirTransaction(payment.pakasirOrderId, payment.pakasirAmount);
        }
        
        payment.status = 'cancelled';
        saveDB();
        
        if (autoApproveTimers[paymentId]) {
            if (autoApproveTimers[paymentId].pollInterval) {
                clearInterval(autoApproveTimers[paymentId].pollInterval);
            }
            delete autoApproveTimers[paymentId];
        }
        
        try {
            await ctx.deleteMessage();
        } catch (delErr) {
            console.error('[BATAL BAYAR] Gagal hapus pesan:', delErr.message);
        }
        
        await ctx.reply(
            "❌ PEMBAYARAN DIBATALKAN\n\n" +
            "Pembayaran telah dibatalkan.\n\n" +
            "📦 Paket: " + payment.label + "\n" +
            "💰 Nominal: Rp" + payment.harga.toLocaleString('id-ID') + "\n\n" +
            "Silahkan klik 💳 Buy Akses untuk mencoba lagi.",
            userId === OWNER_ID ? ownerKeyboard : mainKeyboard
        );
        
        ctx.answerCbQuery('✅ Pembayaran dibatalkan!');
    } catch (err) {
        console.error('[BATAL BAYAR] Error:', err);
        ctx.answerCbQuery('❌ Gagal membatalkan pembayaran.', { show_alert: true });
    }
}));

bot.action('tutup_buy', safeCallback((ctx) => {
    ctx.deleteMessage().catch(() => {});
    ctx.answerCbQuery('Ditutup!');
}));

// ==========================================
// WHATSAPP SENDER FUNCTIONS (FROM BOT 2)
// ==========================================

function loadSenders() {
    if (!fs.existsSync(SENDERS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(SENDERS_FILE, 'utf-8'));
    } catch (e) {
        console.error('❌ Gagal parse senders.json:', e);
        return [];
    }
}

function saveSenders(senders) {
    fs.writeFileSync(SENDERS_FILE, JSON.stringify(senders, null, 2));
}

async function startWhatsAppSender(phone, ctx, userId) {
    if (!userSenderMap.has(userId)) userSenderMap.set(userId, []);
    const userPhones = userSenderMap.get(userId);
    if (!userPhones.includes(phone)) userPhones.push(phone);

    const authDir = path.join(WA_AUTH_DIR, phone);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => [2, 2300, 5]);

    const whatsappSock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });

    whatsappSock.isConnected = false;
    whatsappSock.isReconnecting = false;
    whatsappSock.lastConnected = null;
    whatsappSock.lastDisconnected = null;

    waSockets[phone] = whatsappSock;
    whatsappSock.ev.on("creds.update", saveCreds);

    let reconnectAttempts = 0;
    const MAX_RECONNECT = 5;

    whatsappSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            whatsappSock.isConnected = true;
            whatsappSock.isReconnecting = false;
            whatsappSock.lastConnected = Date.now();
            reconnectAttempts = 0;

            console.log(`✅ WhatsApp ${phone} connected`);
        }

        if (connection === "close") {
            whatsappSock.isConnected = false;
            whatsappSock.isReconnecting = reconnectAttempts < MAX_RECONNECT;
            whatsappSock.lastDisconnected = Date.now();

            const reason = lastDisconnect?.error?.output?.statusCode;

            if (reason === DisconnectReason.loggedOut) {
                delete waSockets[phone];
                if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                const idx = userPhones.indexOf(phone);
                if (idx >= 0) userPhones.splice(idx, 1);
                if (ctx) ctx.reply(`⚠️ WhatsApp ${phone} telah logout. Silakan pairing ulang.`);
            } else {
                if (reconnectAttempts < MAX_RECONNECT) {
                    reconnectAttempts++;
                    setTimeout(() => startWhatsAppSender(phone, ctx, userId), 5000);
                } else {
                    whatsappSock.isReconnecting = false;
                    if (ctx) ctx.reply(`⚠️ WhatsApp ${phone} gagal reconnect. Silakan pairing ulang.`);
                }
            }
        }
    });
}

async function requestPairing(userId, phone) {
    const userPhones = userSenderMap.get(userId);
    if (!userPhones || !userPhones.includes(phone)) throw new Error("Sender belum dijalankan");

    const whatsappSock = waSockets[phone];
    if (!whatsappSock.authState?.creds) throw new Error("Auth belum siap");
    if (whatsappSock.authState.creds.registered) throw new Error("Nomor sudah terhubung");

    return whatsappSock.requestPairingCode(phone, "PING2026");
}

function isWhatsAppConnected(userId, phone) {
    const userPhones = userSenderMap.get(userId);
    return userPhones && userPhones.includes(phone) && waSockets[phone]?.isConnected;
}

// ==========================================
// SENDER KEYBOARD HANDLERS
// ==========================================

bot.hears('🔐 LOGIN WHATSAPP', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    ctx.session = { step: 'LOGIN_WA' };
    ctx.reply(
        "🔐 *LOGIN WHATSAPP*\n\n" +
        "Kirim nomor WhatsApp yang ingin di-login.\n\n" +
        "Format: `628xxxxxxxxxx`\n" +
        "Contoh: `6281234567890`\n\n" +
        "Bot akan otomatis membuat sender dan mengirim kode pairing.",
        { parse_mode: 'Markdown', ...backKeyboard }
    );
}));

bot.hears('📱 MY SENDER', safeHandler(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const userPhones = userSenderMap.get(userId) || [];

        if (userPhones.length === 0) {
            return ctx.reply(
                "📭 *Belum ada sender yang tersimpan.*\n\n" +
                "Hubungkan WhatsApp dengan 📲 ADD SENDER dulu",
                { parse_mode: "Markdown", ...senderKeyboard }
            );
        }

        let result = `╔═════════════╗\n  *MY WHATSENDER*\n╚═════════════╝\n👤 UserID: \`${userId}\`\n`;

        for (const phone of userPhones) {
        const whatsappSock = waSockets[phone];
            const status = whatsappSock?.isConnected ? "🟢 Terhubung" : "🔴 Belum terhubung";
            result += `\n📱 +${phone}\n📶 Status: ${status}\n━━━━━━━━━━━━━━`;
        }

        result += "\n\nUntuk disconnect: ❌ DISCONNECT";

        return ctx.reply(result.trim(), { parse_mode: "Markdown", ...senderKeyboard });

    } catch (err) {
        console.error("Error /mysender:", err);
        return ctx.reply("❌ Terjadi kesalahan.", { parse_mode: "Markdown", ...senderKeyboard });
    }
}));

bot.hears('❌ DISCONNECT', safeHandler(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const userPhones = userSenderMap.get(userId) || [];

        if (userPhones.length === 0) {
            return ctx.reply(
                "📭 *Belum ada sender.*\n\nTambahkan sender dulu.",
                { parse_mode: "Markdown", ...senderKeyboard }
            );
        }

        ctx.session = { step: 'DISCONNECT_SENDER' };
        ctx.reply(
            "❌ *DISCONNECT SENDER*\n\n" +
            "Kirim nomor sender yang ingin di-disconnect:\n\n" +
            "Sender Anda:\n" +
            userPhones.map((p, i) => `${i + 1}. +${p}`).join('\n'),
            { parse_mode: 'Markdown', ...backKeyboard }
        );

    } catch (err) {
        console.error("Error disconnect:", err);
        return ctx.reply("❌ Terjadi kesalahan.", { parse_mode: "Markdown", ...senderKeyboard });
    }
}));

// ==========================================
// CEK BIO HANDLERS (FROM BOT 2 - KEYBOARD VERSION)
// ==========================================

// Helper functions for Cek Bio
function normalizeNumber(num) {
    num = String(num).replace(/[^0-9]/g, "");
    if (num.startsWith("0")) num = "62" + num.slice(1);
    if (num.startsWith("8")) num = "62" + num;
    return num;
}

function createProgressBar(current, total, length = 20) {
    const percentage = current / total;
    const filledLength = Math.round(length * percentage);
    const emptyLength = length - filledLength;
    return `[${'█'.repeat(filledLength)}${'░'.repeat(emptyLength)}]`;
}

function getJamPercentage(bio, setAt, metaBusiness) {
    let basePercentage = 50;

    if (bio && bio.length > 0) {
        if (bio.length > 100) basePercentage -= 20;
        else if (bio.length > 50) basePercentage -= 15;
        else if (bio.length > 20) basePercentage -= 10;
        else basePercentage -= 5;
    } else {
        basePercentage += 15;
    }

    if (setAt) {
        const now = new Date();
        const bioDate = new Date(setAt);
        const diffTime = Math.abs(now - bioDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays > 730) basePercentage += 25;
        else if (diffDays > 365) basePercentage += 15;
        else if (diffDays < 30) basePercentage -= 20;
        else if (diffDays < 90) basePercentage -= 10;
    } else {
        basePercentage += 10;
    }

    if (metaBusiness) basePercentage -= 25;

    basePercentage = Math.max(10, Math.min(90, basePercentage));
    return Math.round(basePercentage / 10) * 10;
}

async function checkMetaBusiness(sock, jid) {
    try {
        await new Promise(r => setTimeout(r, 300));
        const info = await sock.onWhatsApp(jid);
        const wa = info?.[0];
        if (!wa) return { isBusiness: false, verified: false };

        let profile = null;
        try {
            profile = await sock.getBusinessProfile(jid);
        } catch {}

        const isBusiness = !!profile;
        const isVerified = !!wa.verifiedName;

        return {
            isBusiness,
            verified: isVerified,
            businessType: isVerified ? "API" : isBusiness ? "APP" : "NONE",
            businessName: wa.verifiedName || profile?.businessName || profile?.name || null,
            category: profile?.category || null,
            description: profile?.description || null,
            email: profile?.email || null,
            website: profile?.website || null,
            address: profile?.address || null
        };

    } catch {
        return { isBusiness: false, verified: false };
    }
}

function getMetaTier(metaDetail) {
    if (!metaDetail || !metaDetail.isBusiness) return null;
    
    const businessType = metaDetail.businessType;
    const verified = metaDetail.verified;
    const category = metaDetail.category || '';
    const description = metaDetail.description || '';
    const businessName = metaDetail.businessName || '';
    
    const combinedText = (category + ' ' + description + ' ' + businessName).toLowerCase();
    
    if (businessType === 'API' && verified) {
        const premiumKeywords = ['official', 'verified', 'premium', 'exclusive', 'brand', 'enterprise', 'corporate'];
        if (premiumKeywords.some(kw => combinedText.includes(kw))) {
            return 'Eklusif';
        }
    }
    
    if (businessType === 'API' && verified) {
        return 'Eklusif';
    }
    
    if (verified) {
        return 'Standart';
    }
    
    if (businessType === 'APP') {
        return 'Low';
    }
    
    if (businessType === 'API' && !verified) {
        return 'Suite';
    }
    
    return 'Low';
}

function createBioResultFile(results, totalNumbers, sourceType = 'Input Manual') {
    const timestamp = Date.now();
    const filename = `hasil_cekbio_byPING_${timestamp}.txt`;

    const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const withBio = results.filter(r => r.registered && r.bio);
    const withoutBio = results.filter(r => r.registered && !r.bio);
    const notRegistered = results.filter(r => !r.registered);
    const registered = results.filter(r => r.registered);

    const metaBusinessResults = registered.filter(r => r.metaBusiness);
    const eklusifCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Eklusif').length;
    const standartCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Standart').length;
    const lowCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Low').length;
    const suiteCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Suite').length;

    const bioByYear = {};
    withBio.forEach(r => {
        if (r.setAt) {
            const year = new Date(r.setAt).getFullYear();
            bioByYear[year] = (bioByYear[year] || 0) + 1;
        }
    });

    let fileContent = `📋 HASIL CEK BIO WHATSAPP\n`;
    fileContent += `🤖 BOT        : PING BOT\n`;
    fileContent += `👤 OWNER      : @PING0186\n`;
    fileContent += `========================================\n\n`;

    fileContent += `Statistik Ringkasan:\n`;
    fileContent += `- Terdaftar WA: ${registered.length}\n`;
    fileContent += `- Tidak Terdaftar WA: ${notRegistered.length}\n`;
    fileContent += `- Memiliki Bio: ${withBio.length}\n`;
    fileContent += `- Tanpa Bio: ${withoutBio.length}\n`;
    fileContent += `- Business Meta: ${metaBusinessResults.length}\n`;
    fileContent += `  ├─ Eklusif: ${eklusifCount}\n`;
    fileContent += `  ├─ Standart: ${standartCount}\n`;
    fileContent += `  ├─ Low: ${lowCount}\n`;
    fileContent += `  └─ Suite: ${suiteCount}\n`;
    
    if (Object.keys(bioByYear).length > 0) {
        fileContent += `\nStatistik Bio Berdasarkan Tahun Set:\n`;
        Object.keys(bioByYear).sort().forEach(year => {
            fileContent += `- ${year}: ${bioByYear[year]}\n`;
        });
    }
    
    fileContent += `\n📁 Sumber Data     : ${sourceType}\n`;
    fileContent += `========================================\n\n`;

    withBio.sort((a, b) => {
        if (!a.setAt && !b.setAt) return 0;
        if (!a.setAt) return 1;
        if (!b.setAt) return -1;
        return new Date(a.setAt) - new Date(b.setAt);
    });

    withBio.forEach(r => {
        const jam = getJamPercentage(r.bio, r.setAt, r.metaBusiness);
        const metaTier = getMetaTier(r.metaDetail);

        let label = '';
        if (r.setAt) {
            const isBioLama = (now - new Date(r.setAt).getTime()) >= ONE_YEAR;
            const isMetaVerified = r.metaBusiness && r.verified;

            if (isBioLama && isMetaVerified) {
                label = '🌟🕰️ BIO LAMA + META VERIFIED';
            } else if (isBioLama) {
                label = '🕰️ BIO LAMA';
            } else if (isMetaVerified) {
                label = '🌟 META VERIFIED';
            } else {
                label = '🆕 BIO BARU';
            }
        }

        fileContent += `📱 ${r.number}\n`;
        fileContent += `└─ 📝 "${r.bio}" ${label}\n`;

        if (r.setAt) {
            fileContent += `└─ ⏰ Bio diubah: ${new Date(r.setAt).toLocaleString('id-ID')}\n`;
        }

        if (r.metaBusiness && r.metaDetail) {
            const m = r.metaDetail;
            const tier = metaTier || 'Low';
            fileContent += `└─ 🏢 Status WhatsApp Business:\n`;
            fileContent += `   └─ Tier Meta   : ${tier}\n`;
            fileContent += `   └─ Jenis Akun  : ${m.businessType === "API" ? "🌟 WA Business API (Verified)" : "🏢 WA Business App"}\n`;
            if (m.businessName) fileContent += `   └─ Nama Bisnis : ${m.businessName}\n`;
            if (m.category) fileContent += `   └─ Kategori    : ${m.category}\n`;
            if (m.description) fileContent += `   └─ Deskripsi   : ${m.description}\n`;
            if (m.email) fileContent += `   └─ Email       : ${m.email}\n`;
            if (m.website) fileContent += `   └─ Website     : ${m.website}\n`;
        } else {
            fileContent += `└─ ❌ Bukan WhatsApp Business\n`;
        }

        fileContent += `└─ 📮 ${jam}% Tidak Ngejam\n\n`;
    });

    if (withoutBio.length) {
        fileContent += `📵 NOMOR TANPA BIO (${withoutBio.length})\n\n`;
        withoutBio.forEach(r => {
            const tier = r.metaDetail ? getMetaTier(r.metaDetail) : null;
            const symbol = r.metaBusiness && r.verified ? '🌟' : r.metaBusiness ? '🏢' : '❌';
            fileContent += `📱 ${r.number}\n`;
            if (symbol !== '❌') {
                fileContent += `└─ ${symbol} Status Meta Business: WA: ${r.metaBusiness ? '✅' : '❌'}, Verified: ${r.verified ? '✅' : '❌'}`;
                if (tier) {
                    fileContent += `, Tier: ${tier}`;
                }
                fileContent += `\n`;
            } else {
                fileContent += `└─ ❌ Bukan Meta Business\n`;
            }
        });
        fileContent += `\n========================================\n\n`;
    }

    if (notRegistered.length) {
        fileContent += `🚫 NOMOR TIDAK TERDAFTAR (${notRegistered.length})\n\n`;
        notRegistered.forEach(r => {
            fileContent += `${r.number}\n`;
        });
    }

    fs.writeFileSync(filename, fileContent, 'utf8');
    return filename;
}

// Get active socket helper
function getActiveSocket(userId) {
    if (userId === OWNER_ID) {
        const allPhones = Array.from(userSenderMap.keys()).flatMap(uid => userSenderMap.get(uid) || []);
        return allPhones.map(p => waSockets[p]).find(sock => sock?.isConnected);
    } else {
        const userPhones = userSenderMap.get(userId) || [];
        return userPhones.map(p => waSockets[p]).find(sock => sock?.isConnected);
    }
}

// 📝 CEK BIO - Single number check
bot.hears('📝 CEK BIO', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cekbio')) {
            return ctx.reply(
                "❌ LIMIT FREE CEK BIO SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cekBioKeyboard
            );
        }
    }
    
    const activeSock = getActiveSocket(userId);
    if (!activeSock) {
        return ctx.reply(
            "🚫 *Sender WhatsApp Belum Terhubung!*\n\n" +
            "Untuk menggunakan fitur ini, Anda harus memiliki sender WhatsApp yang aktif.\n\n" +
            "✨ *Cara Menghubungkan Sender:*\n" +
            "1️⃣ Klik 📲 ADD SENDER\n" +
            "2️⃣ Kirim nomor WhatsApp Anda\n" +
            "3️⃣ Klik 🔐 GET PAIRING untuk kode pairing\n\n" +
            "💎 Setelah terhubung, semua fitur cek bio dapat digunakan.",
            { parse_mode: "Markdown", ...cekBioKeyboard }
        );
    }

    ctx.session = { step: 'CEK_BIO' };
    ctx.reply(
        "📝 *CEK BIO WHATSAPP*\n\n" +
        "Kirim nomor yang ingin dicek bio-nya.\n\n" +
        "Format: `628xxxxxxxxxx`\n" +
        "Atau multi nomor (max 300):\n" +
        "```\n" +
        "628123456789\n" +
        "628987654321\n" +
        "```",
        { parse_mode: 'Markdown', ...backKeyboard }
    );
}));

// 📁 CEK BIO FILE - File check
bot.hears('📁 CEK BIO FILE', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cekbio')) {
            return ctx.reply(
                "❌ LIMIT FREE CEK BIO SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cekBioKeyboard
            );
        }
    }
    
    const activeSock = getActiveSocket(userId);
    if (!activeSock) {
        return ctx.reply(
            "🚫 *Sender WhatsApp Belum Terhubung!*\n\n" +
            "Silakan login WhatsApp dulu melalui menu 🔐 LOGIN WHATSAPP",
            { parse_mode: "Markdown", ...cekBioKeyboard }
        );
    }

    ctx.session = { step: 'CEK_BIO_FILE' };
    ctx.reply(
        "📁 *CEK BIO VIA FILE*\n\n" +
        "Kirim file (TXT/CSV/XLSX) berisi daftar nomor.\n\n" +
        "📄 Contoh isi file:\n" +
        "```\n" +
        "628123456789\n" +
        "628987654321\n" +
        "628111111111\n" +
        "```\n\n" +
        "⚠️ *Note:* Kirim file sebagai dokumen, bukan foto.",
        { parse_mode: 'Markdown', ...backKeyboard }
    );
}));

// 📱 CEK NOMOR - Check number registration
bot.hears('📱 CEK NOMOR', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cekbio')) {
            return ctx.reply(
                "❌ LIMIT FREE CEK BIO SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cekBioKeyboard
            );
        }
    }
    
    const activeSock = getActiveSocket(userId);
    if (!activeSock) {
        return ctx.reply(
            "🚫 *Sender WhatsApp Belum Terhubung!*\n\n" +
            "Silakan hubungkan sender WhatsApp dulu.",
            { parse_mode: "Markdown", ...cekBioKeyboard }
        );
    }

    ctx.session = { step: 'CEK_NOMOR' };
    ctx.reply(
        "📱 *CEK NOMOR WHATSAPP*\n\n" +
        "Kirim nomor yang ingin dicek status registrasinya.\n\n" +
        "Format: `628xxxxxxxxxx`\n" +
        "Atau multi nomor:\n" +
        "```\n" +
        "628123456789 628987654321\n" +
        "```",
        { parse_mode: 'Markdown', ...backKeyboard }
    );
}));

// 🔍 CEK REPE - Check repe numbers
bot.hears('🔍 CEK REPE', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cekbio')) {
            return ctx.reply(
                "❌ LIMIT FREE CEK BIO SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cekBioKeyboard
            );
        }
    }
    
    const activeSock = getActiveSocket(userId);
    if (!activeSock) {
        return ctx.reply(
            "🚫 *Sender WhatsApp Belum Terhubung!*\n\n" +
            "Silakan hubungkan sender WhatsApp dulu.",
            { parse_mode: "Markdown", ...cekBioKeyboard }
        );
    }

    ctx.session = { step: 'CEK_REPE' };
    ctx.reply(
        "🔍 *CEK REPE (NOMOR CANTIK)*\n\n" +
        "Kirim nomor yang ingin dicek apakah repe atau tidak.\n\n" +
        "Format: `628xxxxxxxxxx`\n" +
        "Atau kirim file .txt dengan nomor:\n" +
        "Kirim file lalu tekan tombol ini lagi.",
        { parse_mode: 'Markdown', ...backKeyboard }
    );
}));

// 📊 CEK RANGE - Check range
bot.hears('📊 CEK RANGE', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cekbio')) {
            return ctx.reply(
                "❌ LIMIT FREE CEK BIO SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cekBioKeyboard
            );
        }
    }
    
    const activeSock = getActiveSocket(userId);
    if (!activeSock) {
        return ctx.reply(
            "🚫 *Sender WhatsApp Belum Terhubung!*\n\n" +
            "Silakan hubungkan sender WhatsApp dulu.",
            { parse_mode: "Markdown", ...cekBioKeyboard }
        );
    }

    ctx.session = { step: 'CEK_RANGE' };
    ctx.reply(
        "📊 *CEK RANGE*\n\n" +
        "Kirim nomor yang ingin dicek range-nya.\n\n" +
        "Format: `628xxxxxxxxxx`\n" +
        "Atau kirim file .txt dengan nomor.",
        { parse_mode: 'Markdown', ...backKeyboard }
    );
}));

// 🚫 CEK BANNED - Check banned status
bot.hears('🚫 CEK BANNED', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cekbio')) {
            return ctx.reply(
                "❌ LIMIT FREE CEK BIO SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cekBioKeyboard
            );
        }
    }
    
    const activeSock = getActiveSocket(userId);
    if (!activeSock) {
        return ctx.reply(
            "🚫 *Sender WhatsApp Belum Terhubung!*\n\n" +
            "Silakan hubungkan sender WhatsApp dulu.",
            { parse_mode: "Markdown", ...cekBioKeyboard }
        );
    }

    ctx.session = { step: 'CEK_BANNED' };
    ctx.reply(
        "🚫 *CEK BANNED WHATSAPP*\n\n" +
        "Kirim nomor yang ingin dicek status banned-nya.\n\n" +
        "Format: `628xxxxxxxxxx`\n" +
        "Atau kirim file .txt dengan nomor.",
        { parse_mode: 'Markdown', ...backKeyboard }
    );
}));

// ==========================================
// FITUR CV HANDLERS (FROM BOTCV)
// ==========================================

// 📁 TO VCF
bot.hears('📁 TO VCF', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_VCF' };
    ctx.reply("📁 Kirim file .txt untuk dikonversi ke .vcf", backKeyboard);
}));

// 📄 TO TXT
bot.hears('📄 TO TXT', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_TXT' };
    ctx.reply("📁 Kirim file .vcf untuk dikonversi ke .txt", backKeyboard);
}));

// 👑 ADMIN/NAVY
bot.hears('👑 ADMIN/NAVY', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_ADM_1' };
    ctx.reply("◀️ Kirim nomor ADMIN:", backKeyboard);
}));

// ✍️ MANUAL
bot.hears('✍️ MANUAL', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_MAN_1' };
    ctx.reply("◀️ Kirim nomor:", backKeyboard);
}));

// ✏️ RENAME CTC
bot.hears('✏️ RENAME CTC', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_RE_CTC' };
    ctx.reply("📩 Kirim file .vcf", backKeyboard);
}));

// 📂 RENAME FILE
bot.hears('📂 RENAME FILE', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_RE_FILE' };
    ctx.reply("📩 Kirim file .vcf", backKeyboard);
}));

// 🔗 GABUNG
bot.hears('🔗 GABUNG', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_GABUNG', files: [] };
    ctx.reply("📩 Kirim file, ketik /done jika sudah", backKeyboard);
}));

// ✂️ PECAH
bot.hears('✂️ PECAH', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_PECAH' };
    ctx.reply("📩 Kirim file .vcf", backKeyboard);
}));

// 💡 CV PINTAR
bot.hears('💡 CV PINTAR', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    
    if (!hasAccess(userId)) {
        if (!checkLimit(userId, 'cv')) {
            return ctx.reply(
                "❌ LIMIT FREE CV SUDAH HABIS!\n\n" +
                "Hubungi owner untuk buy akses murah!!\n" +
                "👑 Owner: @PING0186",
                cvKeyboard
            );
        }
    }
    
    ctx.session = { step: 'CV_PINTAR_1' };
    ctx.reply("✍️ Nama ADMIN:", backKeyboard);
}));

// ==========================================
// TEXT HANDLER - PROCESS ALL INPUTS
// ==========================================

bot.on('text', safeHandler(async (ctx) => {
    const text = ctx.text;
    const step = ctx.session?.step;
    const userId = ctx.from.id;

    if (!step) return;

    // === FIX MERAH 2: TAMBAH EMAIL ===
    if (step === 'FM2_ADD_EMAIL') {
        const lines = text.split('\n').filter(line => line.trim() !== '');
        let validEmails = [];
        let invalidEmails = [];
        
        for (let line of lines) {
            const parts = line.split('|');
            if (parts.length === 2) {
                const email = parts[0].trim();
                const appPass = parts[1].trim();
                
                if (email.includes('@') && email.includes('.') && appPass.length >= 16) {
                    validEmails.push({ email, appPass });
                } else {
                    invalidEmails.push(line.trim());
                }
            } else {
                invalidEmails.push(line.trim());
            }
        }
        
        if (validEmails.length === 0) {
            return ctx.reply("❌ Tidak ada email yang valid! Pastikan format: email@gmail.com|apppassword", backKeyboard);
        }
        
        await ctx.reply("⏳ Sedang memverifikasi " + validEmails.length + " email, mohon tunggu...");
        
        let verifiedValid = [];
        let verifiedInvalid = [];
        
        for (let emailData of validEmails) {
            try {
                let transporter = nodemailer.createTransport({ 
                    service: 'gmail', 
                    auth: { 
                        user: emailData.email, 
                        pass: emailData.appPass 
                    } 
                });
                
                await transporter.verify();
                addUserEmail(userId, emailData.email, emailData.appPass);
                verifiedValid.push(emailData);
            } catch (e) {
                console.error('[FM2] Verifikasi gagal untuk:', emailData.email, e.message);
                verifiedInvalid.push(emailData.email + "|" + emailData.appPass + " (Verifikasi gagal)");
            }
        }
        
        let reportMsg = "📊 HASIL PENAMBAHAN EMAIL\n\n";
        reportMsg += "✅ Email Valid: " + verifiedValid.length + "\n";
        reportMsg += "❌ Email Tidak Valid: " + (invalidEmails.length + verifiedInvalid.length) + "\n\n";
        
        if (verifiedValid.length > 0) {
            reportMsg += "📧 EMAIL BERHASIL DITAMBAH:\n";
            verifiedValid.forEach((item, i) => {
                reportMsg += (i + 1) + ". " + item.email + "\n";
            });
            reportMsg += "\n";
        }
        
        if (invalidEmails.length > 0 || verifiedInvalid.length > 0) {
            reportMsg += "❌ EMAIL GAGAL:\n";
            let idx = 1;
            invalidEmails.forEach((item) => {
                reportMsg += idx + ". " + item + "\n";
                idx++;
            });
            verifiedInvalid.forEach((item) => {
                reportMsg += idx + ". " + item + "\n";
                idx++;
            });
        }
        
        ctx.session = null;
        ctx.reply(reportMsg, fixMerah2Keyboard);
    }

    // === FIX MERAH 2: FIX NOMOR ===
    if (step === 'FIX_NOMOR_2') {
        const nomorList = text.split('\n').map(n => n.trim()).filter(n => n !== '');
        
        if (nomorList.length > 5) {
            return ctx.reply("❌ Maksimal 5 nomor sekaligus!", backKeyboard);
        }
        
        for (let i = 0; i < nomorList.length; i++) {
            if (!nomorList[i].match(/^\+?\d{10,15}$/)) {
                return ctx.reply("❌ Format nomor tidak valid di baris " + (i + 1) + "! Gunakan format: +628xxxxxxxxxx", backKeyboard);
            }
        }
        
        const userEmails = getUserEmails(userId);
        if (userEmails.length === 0) {
            ctx.session = null;
            return ctx.reply("❌ Anda belum memiliki email! Tambah email dulu.", fixMerah2Keyboard);
        }
        
        const validEmails = userEmails.filter(e => e && e.email && e.appPass);
        if (validEmails.length === 0) {
            ctx.session = null;
            return ctx.reply("❌ Tidak ada email yang valid.", fixMerah2Keyboard);
        }
        
        try {
            let sentNumbers = [];
            let usedEmails = [];
            let jamKirim = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) + ' WIB';
            
            for (let i = 0; i < nomorList.length; i++) {
                const res = getNextUserEmail(userId);
                if (!res || !res.email || !res.email.email || !res.email.appPass) {
                    console.error('[FIX NOMOR 2] Gagal ambil email untuk nomor:', nomorList[i]);
                    continue;
                }
                
                let transporter = nodemailer.createTransport({ 
                    service: 'gmail', 
                    auth: { 
                        user: res.email.email, 
                        pass: res.email.appPass 
                    } 
                });
                
                await transporter.sendMail({ 
                    from: res.email.email, 
                    to: 'support@support.whatsapp.com', 
                    subject: 'Question', 
                    text: "Kepada pihak WhatsApp,\nSaya mengalami masalah saat mendaftar nomor saya karena muncul pesan \"Login not available\". Padahal itu nomor pribadi saya.\nMohon bantuannya untuk meninjau masalah ini agar saya bisa mendaftar kembali.\nNomor saya: " + nomorList[i] + "\nTerima kasih."
                });
                
                sentNumbers.push(nomorList[i]);
                usedEmails.push(res.index + 1);
                
                if (!db.totalFix) db.totalFix = 12629861;
                db.totalFix += 1;
                saveDB();
                
                startEmailMonitoring(res.email, userId, false, res.index + 1, nomorList[i]);
            }
            
            ctx.session = null;
            
            let detailBlock = "";
            for (let i = 0; i < sentNumbers.length; i++) {
                detailBlock += "🔧 Nomor: " + sentNumbers[i] + "\n" +
                    "🕞 Jam: " + jamKirim + "\n" +
                    "📩 Email: (email ke " + usedEmails[i] + ")\n";
                if (i < sentNumbers.length - 1) detailBlock += "\n";
            }
            
            let successMsg = "✅ Berhasil terkirim (FIX MERAH 2)\n" +
                "═══════════════════════\n" +
                "```\n" +
                detailBlock +
                "```\n\n" +
                "Bot akan memberitahu jika ada balasan dari pihak WhatsApp.";
            
            ctx.reply(successMsg, { parse_mode: 'Markdown', ...fixMerah2Keyboard });
        } catch (e) { 
            console.error('[FIX NOMOR 2] Error sending email:', e);
            ctx.session = null; 
            ctx.reply("❌ Gagal kirim email! Coba lagi nanti.", fixMerah2Keyboard); 
        }
    }

    // === FIX NOMOR NO SENDER (ORIGINAL BOT 1) ===
    if (step === 'FIX_NOMOR_NO_SENDER') {
        const nomorList = text.split('\n').map(n => n.trim()).filter(n => n !== '');
        
        if (nomorList.length > 5) {
            return ctx.reply("❌ Maksimal 5 nomor sekaligus!", backKeyboard);
        }
        
        for (let i = 0; i < nomorList.length; i++) {
            if (!nomorList[i].match(/^\+?\d{10,15}$/)) {
                return ctx.reply("❌ Format nomor tidak valid di baris " + (i + 1) + "! Gunakan format: +628xxxxxxxxxx", backKeyboard);
            }
        }
        
        if (!db.ownerEmails || db.ownerEmails.length === 0) {
            ctx.session = null;
            return ctx.reply("❌ Email owner kosong. Silahkan hubungi owner.", userId === OWNER_ID ? ownerKeyboard : mainKeyboard);
        }
        
        const validOwnerEmails = db.ownerEmails.filter(e => e && e.email && e.appPass);
        if (validOwnerEmails.length === 0) {
            ctx.session = null;
            return ctx.reply("❌ Tidak ada email owner yang valid.", userId === OWNER_ID ? ownerKeyboard : mainKeyboard);
        }
        
        try {
            let sentNumbers = [];
            let usedEmails = [];
            let jamKirim = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) + ' WIB';
            
            for (let i = 0; i < nomorList.length; i++) {
                const res = getNextOwnerEmail();
                if (!res || !res.email || !res.email.email || !res.email.appPass) {
                    console.error('[FIX NOMOR] Gagal ambil email owner untuk nomor:', nomorList[i]);
                    continue;
                }
                
                let transporter = nodemailer.createTransport({ 
                    service: 'gmail', 
                    auth: { 
                        user: res.email.email, 
                        pass: res.email.appPass 
                    } 
                });
                
                await transporter.sendMail({ 
                    from: res.email.email, 
                    to: 'support@support.whatsapp.com', 
                    subject: 'Question', 
                    text: "Kepada pihak WhatsApp,\nSaya mengalami masalah saat mendaftar nomor saya karena muncul pesan \"Login not available\". Padahal itu nomor pribadi saya.\nMohon bantuannya untuk meninjau masalah ini agar saya bisa mendaftar kembali.\nNomor saya: " + nomorList[i] + "\nTerima kasih."
                });
                
                sentNumbers.push(nomorList[i]);
                usedEmails.push(res.index + 1);
                
                if (!db.totalFix) db.totalFix = 12629861;
                db.totalFix += 1;
                saveDB();
                
                startEmailMonitoring(res.email, userId, true, res.index + 1, nomorList[i]);
            }
            
            // Rate limiter TIDAK ditambah di sini — hanya dihitung ketika ada balasan dari WhatsApp
            
            ctx.session = null;
            
            let detailBlock = "";
            for (let i = 0; i < sentNumbers.length; i++) {
                detailBlock += "🔧 Nomor: " + sentNumbers[i] + "\n" +
                    "🕞 Jam: " + jamKirim + "\n" +
                    "📩 Email: (email ke " + usedEmails[i] + ")\n";
                if (i < sentNumbers.length - 1) detailBlock += "\n";
            }
            
            // Tampilkan rate info saat ini (belum ditambah)
            const currentRateInfo = getFixRateLimitInfo(userId);
            const bulkStatus = "🔃 Batas bulk anda saat ini: " + currentRateInfo.count + "/" + currentRateInfo.max + " nomor";
            
            let successMsg = "✅ Berhasil terkirim\n" +
                "═══════════════════════\n" +
                "```\n" +
                detailBlock +
                "```\n\n" +
                "Bot akan memberitahu jika ada balasan dari pihak WhatsApp.\n\n" +
                bulkStatus;
            
            ctx.reply(successMsg, { parse_mode: 'Markdown', ...(userId === OWNER_ID ? ownerKeyboard : mainKeyboard) });
        } catch (e) { 
            console.error('[FIX NOMOR] Error sending email:', e);
            ctx.session = null; 
            ctx.reply("❌ Gagal kirim email! Coba lagi nanti.", userId === OWNER_ID ? ownerKeyboard : mainKeyboard); 
        }
    }

    // === LOGIN WHATSAPP (gabung ADD SENDER + GET PAIRING) ===
    if (step === 'LOGIN_WA') {
        const phone = text.replace(/[^0-9]/g, "");
        
        if (!phone || !/^\d{10,15}$/.test(phone)) {
            return ctx.reply("❌ Format nomor tidak valid!\n\nGunakan format: 628xxxxxxxxxx", backKeyboard);
        }

        try {
            await ctx.reply("⏳ Membuat sender dan generate pairing code, mohon tunggu...");
            
            await startWhatsAppSender(phone, ctx, userId);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const code = await requestPairing(userId, phone);
            
            ctx.session = null;
            
            await ctx.reply(
                `✅ *LOGIN WHATSAPP BERHASIL*\n\n` +
                `📞 Nomor: +${phone}\n` +
                `🔑 Kode Pairing: \`${code}\`\n\n` +
                `⏳ Kode berlaku ± 2 menit\n\n` +
                `📲 *Cara Pairing:*\n` +
                `1️⃣ Buka WhatsApp di HP\n` +
                `2️⃣ Menu → Perangkat Tertaut\n` +
                `3️⃣ Pilih "Tautkan dengan nomor telepon"\n` +
                `4️⃣ Masukkan kode di atas`,
                { 
                    parse_mode: 'Markdown', 
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Close', `close_wa_login_${userId}`)]
                    ]).reply_markup
                }
            );
            
            ctx.session = null;
        } catch (e) {
            console.error('[LOGIN WA] Error:', e);
            ctx.session = null;
            ctx.reply("❌ Gagal login WhatsApp: " + e.message, senderKeyboard);
        }
    }

    // === DISCONNECT ===
    if (step === 'DISCONNECT_SENDER') {
        const phone = text.replace(/[^0-9]/g, "");
        const userPhones = userSenderMap.get(userId) || [];
        
        if (!userPhones.includes(phone)) {
            ctx.session = null;
            return ctx.reply("❌ Nomor tidak ditemukan!", senderKeyboard);
        }

        try {
            const whatsappSock = waSockets[phone];
            if (whatsappSock) {
                await whatsappSock.logout().catch(() => whatsappSock.ws?.close());
            }
            
            const idx = userPhones.indexOf(phone);
            if (idx >= 0) userPhones.splice(idx, 1);
            delete waSockets[phone];
            
            ctx.session = null;
            ctx.reply(
                `⚡ *DISCONNECT BERHASIL!*\n\n` +
                `WhatsApp +${phone} telah diputuskan.`,
                { parse_mode: 'Markdown', ...senderKeyboard }
            );
        } catch (err) {
            console.error("Error disconnect:", err);
            ctx.session = null;
            ctx.reply("❌ Terjadi kesalahan saat disconnect.", senderKeyboard);
        }
    }

    // === CEK BIO ===
    if (step === 'CEK_BIO') {
        const numbers = text.split(/[\s,\n]+/).filter(Boolean).map(n => normalizeNumber(n)).filter(n => n.length >= 10 && n.length <= 15);
        
        if (numbers.length === 0) {
            return ctx.reply("❌ Tidak ada nomor valid!", backKeyboard);
        }

        if (numbers.length > 300) {
            return ctx.reply("❌ Maksimal 300 nomor!", backKeyboard);
        }

        const activeSock = getActiveSocket(userId);
        if (!activeSock) {
            ctx.session = null;
            return ctx.reply("🚫 Sender tidak aktif!", cekBioKeyboard);
        }

        try {
            await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
            
            const progressFrames = ['⏳', '⌛', '🔄', '⚡', '💫', '✨', '🌟', '💥', '🔥', '⚡'];
            let frameIndex = 0;
            
            const progressMsg = await ctx.reply(`⏳ Memulai pengecekan 0/${numbers.length} nomor...\n\n[░░░░░░░░░░░░░░░░░░] 0%`);

            const results = [];
            const batchSize = 30;

            for (let i = 0; i < numbers.length; i += batchSize) {
                const batch = numbers.slice(i, i + batchSize);

                const batchResults = await Promise.all(batch.map(async (num) => {
                    const jid = num + "@s.whatsapp.net";

                    try {
                        const [wa] = await activeSock.onWhatsApp(jid);
                        if (!wa?.exists) return { number: num, registered: false };

                        let bio = "";
                        let setAt = null;
                        try {
                            await new Promise(r => setTimeout(r, 200));
                            const st = await activeSock.fetchStatus(jid);
                            if (st?.[0]?.status) {
                                bio = st[0].status.status || "";
                                setAt = st[0].status.setAt ? new Date(st[0].status.setAt) : null;
                            }
                        } catch {}

                        let meta = { isBusiness: false, verified: false };
                        try { meta = await checkMetaBusiness(activeSock, jid); } catch {}

                        return {
                            number: num,
                            registered: true,
                            bio,
                            setAt,
                            metaBusiness: meta.isBusiness || false,
                            verifiedMeta: meta.verified || false,
                            metaDetail: meta,
                            jamPercentage: getJamPercentage(bio, setAt, meta.isBusiness)
                        };

                    } catch {
                        return { number: num, registered: false };
                    }
                }));

                results.push(...batchResults);

                const processed = Math.min(i + batchSize, numbers.length);
                const percentage = Math.round((processed / numbers.length) * 100);
                const filledBlocks = Math.round((percentage / 100) * 20);
                const emptyBlocks = 20 - filledBlocks;
                const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
                const frame = progressFrames[frameIndex % progressFrames.length];
                frameIndex++;
                
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progressMsg.message_id,
                        null,
                        `${frame} Memeriksa ${processed}/${numbers.length} nomor...\n\n[${progressBar}] ${percentage}%\n\n✅ Selesai: ${results.filter(r => r.registered).length}\n❌ Tidak Terdaftar: ${results.filter(r => !r.registered).length}`
                    );
                } catch {}
                
                if (i + batchSize < numbers.length) await new Promise(r => setTimeout(r, 300));
            }

            const filename = createBioResultFile(results, numbers.length);
            
            if (!fs.existsSync(filename)) {
                throw new Error('File hasil tidak berhasil dibuat');
            }
            
            const total = numbers.length;
            const registered = results.filter(r => r.registered).length;
            const notRegistered = results.filter(r => !r.registered).length;
            const withBio = results.filter(r => r.registered && r.bio);
            const withoutBioCount = registered - withBio.length;
            
            const metaBusinessResults = results.filter(r => r.registered && r.metaBusiness);
            const waBusinessApp = metaBusinessResults.filter(r => r.metaDetail?.businessType === 'APP').length;
            const waBusinessAPI = metaBusinessResults.filter(r => r.metaDetail?.businessType === 'API').length;
            const eklusifCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Eklusif').length;
            const standartCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Standart').length;
            const lowCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Low').length;
            const suiteCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Suite').length;

            const bioByYear = {};
            withBio.forEach(r => {
                if (r.setAt) {
                    const year = new Date(r.setAt).getFullYear();
                    bioByYear[year] = (bioByYear[year] || 0) + 1;
                }
            });

            let yearStats = '';
            Object.keys(bioByYear).sort().forEach(year => {
                yearStats += `- ${year}: ${bioByYear[year]}\n`;
            });

            try { 
                await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id); 
            } catch (e) {
                console.log('[CEK BIO] Gagal hapus progress:', e.message);
            }

            await ctx.replyWithDocument(
                { source: filename },
                {
                    caption:
                        `📋 *HASIL CEK BIO WHATSAPP*\n\n` +
                        `*Statistik Ringkasan:*\n` +
                        `- Terdaftar WA: ${registered}\n` +
                        `- Tidak Terdaftar WA: ${notRegistered}\n` +
                        `- Memiliki Bio: ${withBio.length}\n` +
                        `- Tanpa Bio: ${withoutBioCount}\n` +
                        `- Business Meta: ${metaBusinessResults.length}\n` +
                        `  ├─ Eklusif: ${eklusifCount}\n` +
                        `  ├─ Standart: ${standartCount}\n` +
                        `  ├─ Low: ${lowCount}\n` +
                        `  └─ Suite: ${suiteCount}\n\n` +
                        (yearStats ? `*Statistik Bio Berdasarkan Tahun Set:*\n${yearStats}\n` : '') +
                        `🕒 Waktu: ${new Date().toLocaleString('id-ID')}`,
                    parse_mode: 'Markdown'
                }
            );

            await new Promise(r => setTimeout(r, 2000));
            
            try {
                if (fs.existsSync(filename)) {
                    fs.unlinkSync(filename);
                }
            } catch (e) {
                console.log('[CEK BIO] Gagal hapus file:', e.message);
            }
            
            ctx.session = null;

        } catch (err) {
            console.error('cekbio error:', err);
            try { 
                if (typeof progressMsg !== 'undefined' && progressMsg && progressMsg.message_id) {
                    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id); 
                }
            } catch {}
            ctx.session = null;
            await ctx.reply('❌ Terjadi kesalahan: ' + (err.message || 'Unknown error'), cekBioKeyboard);
        }
    }

    // === CEK NOMOR ===
    if (step === 'CEK_NOMOR') {
        const numbers = text.split(/[\s,\n]+/).filter(Boolean).map(n => normalizeNumber(n)).filter(n => n.length >= 10 && n.length <= 15);
        
        if (numbers.length === 0) {
            return ctx.reply("❌ Tidak ada nomor valid!", backKeyboard);
        }

        const activeSock = getActiveSocket(userId);
        if (!activeSock) {
            ctx.session = null;
            return ctx.reply("🚫 Sender tidak aktif!", cekBioKeyboard);
        }

        try {
            await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
            
            const progressFrames = ['⏳', '⌛', '🔄', '⚡', '💫', '✨', '🌟', '💥', '🔥', '⚡'];
            let frameIndex = 0;
            
            const progressMsg = await ctx.reply(`⏳ Memulai pengecekan 0/${numbers.length} nomor...\n\n[░░░░░░░░░░░░░░░░░░] 0%`);

            let registered = [];
            let notRegistered = [];
            const batchSize = 30;

            for (let i = 0; i < numbers.length; i += batchSize) {
                const batch = numbers.slice(i, i + batchSize);
                
                const batchResults = await Promise.all(batch.map(async (num) => {
                    try {
                        const jid = num + "@s.whatsapp.net";
                        const [waCheck] = await activeSock.onWhatsApp(jid);
                        return waCheck && waCheck.exists ? { num, status: 'registered' } : { num, status: 'not_registered' };
                    } catch {
                        return { num, status: 'error' };
                    }
                }));

                batchResults.forEach(r => {
                    if (r.status === 'registered') registered.push(r.num);
                    else notRegistered.push(r.num);
                });

                const processed = Math.min(i + batchSize, numbers.length);
                const percentage = Math.round((processed / numbers.length) * 100);
                const filledBlocks = Math.round((percentage / 100) * 20);
                const emptyBlocks = 20 - filledBlocks;
                const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
                const frame = progressFrames[frameIndex % progressFrames.length];
                frameIndex++;
                
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id, 
                        progressMsg.message_id, 
                        null, 
                        `${frame} Memeriksa ${processed}/${numbers.length} nomor...\n\n[${progressBar}] ${percentage}%\n\n✅ Terdaftar: ${registered.length}\n❌ Tidak Terdaftar: ${notRegistered.length}`
                    );
                } catch {}

                if (i + batchSize < numbers.length) await new Promise(r => setTimeout(r, 300));
            }

            let fileContent = `📊 Hasil cek status ${numbers.length} nomor\n\n`;
            if (registered.length) {
                fileContent += `✅ Terdaftar (${registered.length}):\n`;
                registered.forEach((num, idx) => fileContent += `${idx + 1}. ${num}\n`);
                fileContent += `\n`;
            }
            if (notRegistered.length) {
                fileContent += `❌ Tidak terdaftar (${notRegistered.length}):\n`;
                notRegistered.forEach((num, idx) => fileContent += `${idx + 1}. ${num}\n`);
            }

            const filename = `status_result_${Date.now()}.txt`;
            fs.writeFileSync(filename, fileContent);

            await ctx.replyWithDocument(
                { source: filename },
                { caption: `📊 Hasil pengecekan ${numbers.length} nomor selesai!` }
            );

            fs.unlinkSync(filename);
            try { await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id); } catch {}
            ctx.session = null;

        } catch (error) {
            console.error('Error ceknom:', error);
            ctx.session = null;
            ctx.reply('❌ Terjadi kesalahan sistem.', cekBioKeyboard);
        }
    }

    // === CEK RANGE ===
    if (step === 'CEK_RANGE') {
        let numbers = [];
        
        if (ctx.message.document) {
            return ctx.reply("❌ Untuk file gunakan menu 📁 CEK BIO FILE", cekBioKeyboard);
        } else {
            numbers = text.split(/[\s,\n]+/).filter(Boolean).map(n => normalizeNumber(n)).filter(n => n.length >= 10 && n.length <= 15);
        }

        if (numbers.length === 0) {
            return ctx.reply("❌ Tidak ada nomor valid!", backKeyboard);
        }

        const activeSock = getActiveSocket(userId);
        if (!activeSock) {
            ctx.session = null;
            return ctx.reply("🚫 Sender tidak aktif!", cekBioKeyboard);
        }

        try {
            await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
            
            const progressFrames = ['⏳', '⌛', '🔄', '⚡', '💫', '✨', '🌟', '💥', '🔥', '⚡'];
            let frameIndex = 0;
            
            const progressMsg = await ctx.reply(`⏳ Memulai pengecekan 0/${numbers.length} nomor...\n\n[░░░░░░░░░░░░░░░░░░] 0%`);

            const registered = [];
            const notRegistered = [];
            const errors = [];
            const batchSize = 30;

            for (let i = 0; i < numbers.length; i += batchSize) {
                const batch = numbers.slice(i, i + batchSize);
                const results = await Promise.all(batch.map(async (num) => {
                    try {
                        const jid = num + '@s.whatsapp.net';
                        const [waCheck] = await activeSock.onWhatsApp(jid);
                        return waCheck && waCheck.exists ? { num, status: 'registered' } : { num, status: 'not_registered' };
                    } catch {
                        return { num, status: 'error' };
                    }
                }));

                results.forEach(r => {
                    if (r.status === 'registered') registered.push(r.num);
                    else if (r.status === 'not_registered') notRegistered.push(r.num);
                    else errors.push(r.num);
                });

                const processed = Math.min(i + batchSize, numbers.length);
                const percentage = Math.round((processed / numbers.length) * 100);
                const filledBlocks = Math.round((percentage / 100) * 20);
                const emptyBlocks = 20 - filledBlocks;
                const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
                const frame = progressFrames[frameIndex % progressFrames.length];
                frameIndex++;
                
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id, 
                        progressMsg.message_id, 
                        null, 
                        `${frame} Memeriksa ${processed}/${numbers.length} nomor...\n\n[${progressBar}] ${percentage}%\n\n✅ Terdaftar: ${registered.length}\n❌ Tidak Terdaftar: ${notRegistered.length}`
                    );
                } catch {}
                
                if (i + batchSize < numbers.length) await new Promise(r => setTimeout(r, 300));
            }

            const filename = `range_result_${Date.now()}.txt`;
            let fileContent = `📊 Hasil cek ${numbers.length} nomor\n\n`;
            if (registered.length) fileContent += `✅ Terdaftar (${registered.length}):\n${registered.map((n,i)=>`${i+1}. ${n}`).join('\n')}\n\n`;
            if (notRegistered.length) fileContent += `❌ Tidak terdaftar (${notRegistered.length}):\n${notRegistered.map((n,i)=>`${i+1}. ${n}`).join('\n')}\n\n`;
            if (errors.length) fileContent += `⚠️ Error (${errors.length}):\n${errors.map((n,i)=>`${i+1}. ${n}`).join('\n')}\n`;

            fs.writeFileSync(filename, fileContent, 'utf8');

            await ctx.replyWithDocument(
                { source: filename },
                {
                    caption: `📊 Hasil pengecekan selesai!\n✅ Terdaftar: ${registered.length}\n❌ Tidak terdaftar: ${notRegistered.length}` +
                            (errors.length ? `\n⚠️ Error: ${errors.length}` : '')
                }
            );

            fs.unlinkSync(filename);
            try { await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id); } catch {}
            ctx.session = null;

        } catch (err) {
            console.error('Error cekrange:', err);
            ctx.session = null;
            ctx.reply('❌ Terjadi kesalahan sistem.', cekBioKeyboard);
        }
    }

    // === CEK BANNED ===
    if (step === 'CEK_BANNED') {
        let numbers = text.split(/[\s,\n]+/).filter(Boolean).map(n => normalizeNumber(n)).filter(n => n.length >= 10 && n.length <= 15);

        if (numbers.length === 0) {
            return ctx.reply("❌ Tidak ada nomor valid!", backKeyboard);
        }

        const activeSock = getActiveSocket(userId);
        if (!activeSock) {
            ctx.session = null;
            return ctx.reply("🚫 Sender tidak aktif!", cekBioKeyboard);
        }

        try {
            await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
            
            const progressFrames = ['⏳', '⌛', '🔄', '⚡', '💫', '✨', '🌟', '💥', '🔥', '⚡'];
            let frameIndex = 0;
            
            const progress = await ctx.reply(`⏳ Memulai pengecekan 0/${numbers.length} nomor...\n\n[░░░░░░░░░░░░░░░░░░] 0%`);

            const normal = [];
            const banned = [];
            const notRegistered = [];
            const error = [];

            const batchSize = 15;
            for (let i = 0; i < numbers.length; i += batchSize) {
                const batch = numbers.slice(i, i + batchSize);

                const results = await Promise.all(batch.map(async num => {
                    const jid = num + "@s.whatsapp.net";
                    try {
                        const [check] = await activeSock.onWhatsApp(jid);
                        if (!check || !check.exists) return { num, status: "not_registered" };

                        try {
                            await activeSock.profilePictureUrl(jid, 'image');
                            return { num, status: "normal" };
                        } catch (e) {
                            return { num, status: "banned" };
                        }
                    } catch (e) {
                        return { num, status: "error" };
                    }
                }));

                results.forEach(r => {
                    if (r.status === "normal") normal.push(r);
                    else if (r.status === "banned") banned.push(r);
                    else if (r.status === "not_registered") notRegistered.push(r);
                    else error.push(r);
                });

                const processed = Math.min(i + batchSize, numbers.length);
                const percentage = Math.round((processed / numbers.length) * 100);
                const filledBlocks = Math.round((percentage / 100) * 20);
                const emptyBlocks = 20 - filledBlocks;
                const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
                const frame = progressFrames[frameIndex % progressFrames.length];
                frameIndex++;
                
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progress.message_id,
                        null,
                        `${frame} Mengecek ${processed}/${numbers.length} nomor...\n\n[${progressBar}] ${percentage}%\n\n✅ Normal: ${normal.length}\n🚫 Banned: ${banned.length}\n❌ Tidak Terdaftar: ${notRegistered.length}`
                    );
                } catch {}

                await new Promise(r => setTimeout(r, 400));
            }

            const filename = `cekband_result_${Date.now()}.txt`;
            let content = `📊 HASIL CEK BANNED WHATSAPP\n\n`;

            if (normal.length) {
                content += `✅ NORMAL (${normal.length})\n`;
                normal.forEach((n,i) => content += `${i+1}. ${n.num}\n`);
                content += '\n';
            }

            if (banned.length) {
                content += `🚫 BANNED / SPAM (${banned.length})\n`;
                banned.forEach((n,i) => content += `${i+1}. ${n.num}\n`);
                content += '\n';
            }

            if (notRegistered.length) {
                content += `❌ TIDAK TERDAFTAR (${notRegistered.length})\n`;
                notRegistered.forEach((n,i) => content += `${i+1}. ${n.num}\n`);
                content += '\n';
            }

            if (error.length) {
                content += `⚠️ ERROR (${error.length})\n`;
                error.forEach((n,i) => content += `${i+1}. ${n.num}\n`);
            }

            fs.writeFileSync(filename, content, 'utf8');

            await ctx.replyWithDocument(
                { source: filename },
                {
                    caption:
                        `📊 *HASIL CEK BANNED*\n\n` +
                        `✅ Normal : ${normal.length}\n` +
                        `🚫 Banned : ${banned.length}\n` +
                        `❌ Tidak terdaftar : ${notRegistered.length}\n` +
                        `⚠️ Error : ${error.length}`,
                    parse_mode: "Markdown"
                }
            );

            fs.unlinkSync(filename);
            ctx.session = null;

        } catch (err) {
            console.error('Error cekband:', err);
            ctx.session = null;
            ctx.reply('❌ Terjadi kesalahan sistem.', cekBioKeyboard);
        }
    }

    // === CEK REPE ===
    if (step === 'CEK_REPE') {
        if (ctx.message.document && ctx.message.document.file_name.endsWith('.txt')) {
            return ctx.reply("⏳ Fitur cek repe via file sedang dikembangkan. Gunakan input manual untuk sementara.", cekBioKeyboard);
        }

        let numbers = text.split(/[\s,\n]+/).filter(Boolean).map(n => normalizeNumber(n)).filter(n => n.length >= 10 && n.length <= 15);

        if (numbers.length === 0) {
            return ctx.reply("❌ Tidak ada nomor valid!", backKeyboard);
        }

        const activeSock = getActiveSocket(userId);
        if (!activeSock) {
            ctx.session = null;
            return ctx.reply("🚫 Sender tidak aktif!", cekBioKeyboard);
        }

        function isRepeNumber(number) {
            const numStr = number.toString();
            if (/^(\d)\1+$/.test(numStr)) return true;
            const digits = numStr.split('').map(Number);
            let sequentialUp = true;
            let sequentialDown = true;
            for (let i = 1; i < digits.length; i++) {
                if (digits[i] !== digits[i - 1] + 1) sequentialUp = false;
                if (digits[i] !== digits[i - 1] - 1) sequentialDown = false;
            }
            if (sequentialUp || sequentialDown) return true;
            if (numStr === numStr.split('').reverse().join('')) return true;
            if (/^(\d\d)\1+$/.test(numStr)) return true;
            if (/^(\d\d\d)\1+$/.test(numStr)) return true;
            return false;
        }

        function getVerificationPercentage(number) {
            const numStr = number.toString();
            const len = numStr.length;
            if (/^(\d)\1{3,}$/.test(numStr)) return 99;
            if (/^(\d)\1{2,}$/.test(numStr)) return 95;
            const digits = numStr.split('').map(Number);
            let sequentialUp = true;
            let sequentialDown = true;
            for (let i = 1; i < digits.length; i++) {
                if (digits[i] !== digits[i-1]+1) sequentialUp = false;
                if (digits[i] !== digits[i-1]-1) sequentialDown = false;
            }
            if (sequentialUp || sequentialDown) return 90;
            if (numStr === numStr.split('').reverse().join('')) return 85;
            if (/^(\d\d)\1+$/.test(numStr)) return 80;
            if (/^(\d\d\d)\1+$/.test(numStr)) return 75;
            if (len >= 12) return 65;
            if (len >= 10) return 60;
            if (len >= 8) return 50;
            return 40;
        }

        try {
            await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
            
            const progressFrames = ['⏳', '⌛', '🔄', '⚡', '💫', '✨', '🌟', '💥', '🔥', '⚡'];
            let frameIndex = 0;
            
            const progressMessage = await ctx.reply(`⏳ Memulai pengecekan ${numbers.length} nomor...\n\n[░░░░░░░░░░░░░░░░░░] 0%`);

            const repeNumbers = numbers.filter(n => isRepeNumber(n));
            const normalNumbers = numbers.filter(n => !repeNumbers.includes(n));

            const checkNumbers = async (arr) => {
                const registered = [];
                const notRegistered = [];
                const batchSize = 30;

                for (let i = 0; i < arr.length; i += batchSize) {
                    const batch = arr.slice(i, i + batchSize);
                    const batchResults = await Promise.all(batch.map(async (num) => {
                        try {
                            const jid = num + '@s.whatsapp.net';
                            const [waCheck] = await activeSock.onWhatsApp(jid);
                            return waCheck && waCheck.exists ? { num, status: 'registered' } : { num, status: 'not_registered' };
                        } catch { return { num, status: 'error' }; }
                    }));

                    batchResults.forEach(res => {
                        if (res.status === 'registered') registered.push(res.num);
                        else notRegistered.push(res.num);
                    });

                    const processed = Math.min(i + batchSize, arr.length);
                    const percentage = Math.round((processed / arr.length) * 100);
                    const filledBlocks = Math.round((percentage / 100) * 20);
                    const emptyBlocks = 20 - filledBlocks;
                    const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
                    const frame = progressFrames[frameIndex % progressFrames.length];
                    frameIndex++;
                    
                    try { 
                        await ctx.telegram.editMessageText(
                            ctx.chat.id, 
                            progressMessage.message_id, 
                            null, 
                            `${frame} Memeriksa ${processed}/${arr.length} nomor...\n\n[${progressBar}] ${percentage}%\n\n✅ Terdaftar: ${registered.length}\n❌ Tidak Terdaftar: ${notRegistered.length}`
                        );
                    } catch {}
                    if (i + batchSize < arr.length) await new Promise(r => setTimeout(r, 300));
                }

                return { registered, notRegistered };
            };

            const repeResult = await checkNumbers(repeNumbers);
            const normalResult = await checkNumbers(normalNumbers);

            const timestamp = Date.now();
            const filename = `repe_result_${timestamp}.txt`;
            
            let fileContent = `📚 Hasil cek repe\n`;
            fileContent += `🤖 BOT        : PING BOT\n`;
            fileContent += `👤 OWNER      : @PING0186\n`;
            fileContent += `========================================\n\n`;
            
            if (repeResult.registered.length > 0) {
                fileContent += `📚 Nokos Repe yang terdaftar\n`;
                repeResult.registered.forEach((item, index) => {
                    const perc = getVerificationPercentage(item);
                    fileContent += `✅ ${index + 1}. ${item} (${perc}%)\n`;
                });
                fileContent += '\n';
            } else {
                fileContent += `📚 Nokos Repe yang terdaftar: Tidak ada\n\n`;
            }
            
            if (repeResult.notRegistered.length > 0) {
                fileContent += `Nokos Repe yang tidak terdaftar\n`;
                repeResult.notRegistered.forEach((number, index) => {
                    const perc = getVerificationPercentage(number);
                    fileContent += `❌ ${index + 1}. ${number} (${perc}%)\n`;
                });
                fileContent += '\n';
            } else {
                fileContent += `Nokos Repe yang tidak terdaftar: Tidak ada\n\n`;
            }

            if (normalResult.registered.length > 0) {
                fileContent += `✅ Nomor biasa yang terdaftar\n`;
                normalResult.registered.forEach((number, index) => {
                    const perc = getVerificationPercentage(number);
                    fileContent += `📱 ${index + 1}. ${number} (${perc}%)\n`;
                });
                fileContent += '\n';
            } else {
                fileContent += `✅ Nomor biasa yang terdaftar: Tidak ada\n\n`;
            }

            if (normalResult.notRegistered.length > 0) {
                fileContent += `❌ Nomor biasa yang tidak terdaftar\n`;
                normalResult.notRegistered.forEach((number, index) => {
                    const perc = getVerificationPercentage(number);
                    fileContent += `🚫 ${index + 1}. ${number} (${perc}%)\n`;
                });
            } else {
                fileContent += `❌ Nomor biasa yang tidak terdaftar: Tidak ada\n`;
            }
            
            fs.writeFileSync(filename, fileContent, 'utf8');

            await ctx.replyWithDocument(
                { source: filename },
                {
                    caption: `📊 Hasil cek repe selesai!\n` +
                        `✅ Repe terdaftar: ${repeResult.registered.length}\n` +
                        `❌ Repe tidak terdaftar: ${repeResult.notRegistered.length}\n` +
                        `✅ Normal terdaftar: ${normalResult.registered.length}\n` +
                        `❌ Normal tidak terdaftar: ${normalResult.notRegistered.length}`
                }
            );

            fs.unlinkSync(filename);
            try { await ctx.telegram.deleteMessage(ctx.chat.id, progressMessage.message_id); } catch {}
            ctx.session = null;

        } catch (err) {
            console.error(err);
            ctx.session = null;
            ctx.reply('❌ Terjadi kesalahan saat pengecekan nomor.', cekBioKeyboard);
        }
    }

    // === FITUR CV HANDLERS ===
    
    // CV VCF - Step 1: Nama kontak
    if (step === 'CV_VCF_1') {
        ctx.session.nm_ctc = text;
        ctx.session.step = 'CV_VCF_2';
        return ctx.reply("📂 Masukan nama file", backKeyboard);
    }
    
    // CV VCF - Step 2: Jumlah kontak per file
    if (step === 'CV_VCF_2') {
        ctx.session.nm_file = text;
        ctx.session.step = 'CV_VCF_3';
        return ctx.reply("♻️ Jumlah kontak per file atau \"all\"", backKeyboard);
    }
    
    // CV VCF - Step 3: Process
    if (step === 'CV_VCF_3') {
        let list = ctx.session.content.match(/\d+/g) || [];
        let vcards = list.map((n, i) => `BEGIN:VCARD\nVERSION:3.0\nFN:${ctx.session.nm_ctc} ${i+1}\nTEL;TYPE=CELL:${n}\nEND:VCARD`);
        let sz = text.toLowerCase() === 'all' ? vcards.length : parseInt(text);
        
        if (isNaN(sz) || sz <= 0) {
            ctx.session = null;
            return ctx.reply("❌ Jumlah tidak valid!", cvKeyboard);
        }
        
        for (let i = 0, p = 1; i < vcards.length; i += sz, p++) {
            let fn = `./${ctx.session.nm_file}${text === 'all' ? '' : '_'+p}.vcf`;
            fs.writeFileSync(fn, vcards.slice(i, i + sz).join('\n'));
            await ctx.replyWithDocument({ source: fn });
            fs.unlinkSync(fn);
        }
        
        ctx.reply("✅ DONE", cvKeyboard);
        return ctx.session = null;
    }
    
    // CV TXT - Step 1: Nama file
    if (step === 'CV_TXT_NAME') {
        const fileName = `./${text}.txt`;
        fs.writeFileSync(fileName, ctx.session.extractedNumbers);
        await ctx.replyWithDocument({ source: fileName });
        fs.unlinkSync(fileName);
        ctx.reply("✅ DONE", cvKeyboard);
        return ctx.session = null;
    }
    
    // CV ADMIN/NAVY - Step 1: Nomor admin
    if (step === 'CV_ADM_1') { 
        ctx.session.adminNumbers = text; 
        ctx.session.step = 'CV_ADM_2'; 
        return ctx.reply("✍️ Masukkan NAMA ADMIN:", backKeyboard); 
    }
    
    // CV ADMIN/NAVY - Step 2: Nama admin
    if (step === 'CV_ADM_2') { 
        ctx.session.adminName = text; 
        ctx.session.step = 'CV_ADM_3'; 
        return ctx.reply("✍️ Masukkan NOMOR NAVY:", backKeyboard); 
    }
    
    // CV ADMIN/NAVY - Step 3: Nomor navy
    if (step === 'CV_ADM_3') { 
        ctx.session.navyNumbers = text; 
        ctx.session.step = 'CV_ADM_4'; 
        return ctx.reply("✍️ Masukkan NAMA NAVY:", backKeyboard); 
    }
    
    // CV ADMIN/NAVY - Step 4: Nama navy
    if (step === 'CV_ADM_4') { 
        ctx.session.navyName = text; 
        ctx.session.step = 'CV_ADM_5'; 
        return ctx.reply("✍️ Masukkan NAMA FILE:", backKeyboard); 
    }
    
    // CV ADMIN/NAVY - Step 5: Process
    if (step === 'CV_ADM_5') {
        let vcf = "";
        const adList = ctx.session.adminNumbers.match(/\d+/g) || [];
        const nvList = ctx.session.navyNumbers.match(/\d+/g) || [];
        adList.forEach((n, i) => { vcf += `BEGIN:VCARD\nVERSION:3.0\nFN:${ctx.session.adminName} ${i+1}\nTEL;TYPE=CELL:${n}\nEND:VCARD\n`; });
        nvList.forEach((n, i) => { vcf += `BEGIN:VCARD\nVERSION:3.0\nFN:${s.navyName} ${i+1}\nTEL;TYPE=CELL:${n}\nEND:VCARD\n`; });
        const fn = `./${text}.vcf`; 
        fs.writeFileSync(fn, vcf);
        await ctx.replyWithDocument({ source: fn });
        fs.unlinkSync(fn);
        ctx.reply("✅ DONE", cvKeyboard);
        return ctx.session = null;
    }
    
    // CV MANUAL - Step 1: Nomor
    if (step === 'CV_MAN_1') { 
        ctx.session.numbers = text; 
        ctx.session.step = 'CV_MAN_2'; 
        return ctx.reply("✍️ Masukkan NAMA KONTAK:", backKeyboard); 
    }
    
    // CV MANUAL - Step 2: Nama kontak
    if (step === 'CV_MAN_2') { 
        ctx.session.contactName = text; 
        ctx.session.step = 'CV_MAN_3'; 
        return ctx.reply("✍️ Masukkan NAMA FILE:", backKeyboard); 
    }
    
    // CV MANUAL - Step 3: Process
    if (step === 'CV_MAN_3') {
        let vcf = "";
        const list = ctx.session.numbers.match(/\d+/g) || [];
        list.forEach((n, i) => { vcf += `BEGIN:VCARD\nVERSION:3.0\nFN:${ctx.session.contactName} ${i+1}\nTEL;TYPE=CELL:${n}\nEND:VCARD\n`; });
        const fn = `./${text}.vcf`; 
        fs.writeFileSync(fn, vcf);
        await ctx.replyWithDocument({ source: fn });
        fs.unlinkSync(fn);
        ctx.reply("✅ DONE", cvKeyboard);
        return ctx.session = null;
    }
    
    // CV RENAME CTC - Step 1: Nama kontak baru
    if (step === 'CV_RE_CTC_V') {
        let newCards = ctx.session.cards.map((card, i) => card.replace(/FN:[\s\S]*?\n/, `FN:${text} ${i+1}\n`));
        let fn = `./REN_CTC.vcf`; 
        fs.writeFileSync(fn, newCards.join('\n'));
        await ctx.replyWithDocument({ source: fn });
        fs.unlinkSync(fn);
        ctx.reply("✅ DONE", cvKeyboard);
        return ctx.session = null;
    }
    
    // CV RENAME FILE - Step 1: Nama file baru
    if (step === 'CV_RE_FILE_V') {
        let fn = `./${text}.vcf`; 
        fs.writeFileSync(fn, ctx.session.content);
        await ctx.replyWithDocument({ source: fn });
        fs.unlinkSync(fn);
        ctx.reply("✅ DONE", cvKeyboard);
        return ctx.session = null;
    }
    
    // CV GABUNG - Step 1: Nama file
    if (step === 'CV_GABUNG_NAME') {
        const fn = `./${text}.vcf`; 
        fs.writeFileSync(fn, ctx.session.files.join('\n'));
        await ctx.replyWithDocument({ source: fn });
        fs.unlinkSync(fn);
        ctx.reply("✅ DONE", cvKeyboard);
        return ctx.session = null;
    }
    
    // CV PECAH - Step 1: Ukuran per file
    if (step === 'CV_PEC_SZ') { 
        ctx.session.sz = parseInt(text); 
        ctx.session.step = 'CV_PEC_NAME'; 
        return ctx.reply("✍️ Kirim nama file baru", backKeyboard); 
    }
    
    // CV PECAH - Step 2: Nama file
    if (step === 'CV_PEC_NAME') {
        for (let i = 0, p = 1; i < ctx.session.cards.length; i += ctx.session.sz, p++) {
            let fn = `./${text}_${p}.vcf`; 
            fs.writeFileSync(fn, ctx.session.cards.slice(i, i + ctx.session.sz).join('\n'));
            await ctx.replyWithDocument({ source: fn });
            fs.unlinkSync(fn);
        }
        ctx.reply("✅ DONE", cvKeyboard); 
        return ctx.session = null;
    }
    
    // CV PINTAR - Step 1: Nama admin
    if (step === 'CV_PINTAR_1') { 
        ctx.session.adminName = text; 
        ctx.session.step = 'CV_PINTAR_2'; 
        return ctx.reply("✍️ Masukkan nama ANGGOTA:", backKeyboard); 
    }
    
    // CV PINTAR - Step 2: Nama anggota
    if (step === 'CV_PINTAR_2') { 
        ctx.session.memberName = text; 
        ctx.session.step = 'CV_PINTAR'; 
        ctx.session.data = []; 
        return ctx.reply("📂 Kirim file, klik /done jika sudah", backKeyboard); 
    }

    // Owner only handlers
    if (userId === OWNER_ID) {
        if (step === 'ADD_AKSES_USER') { 
            ctx.session.targetId = findUser(text); 
            if (!ctx.session.targetId) return ctx.reply("❌ User tidak ditemukan. Coba lagi:", backKeyboard); 
            ctx.session.step = 'ADD_AKSES_VAL'; 
            ctx.reply("Kirim hari (angka) atau ketik 'permanen':"); 
        }
        
        if (step === 'ADD_AKSES_VAL') {
            try {
                const tid = ctx.session.targetId;
                if (!db.users[tid]) db.users[tid] = { point: 0, reffCount: 0, akses: Date.now(), emails: [], currentEmailIndex: 0, limitFix: 2, limitCekBio: 2, limitCv: 2 };
                
                const days = parseInt(text);
                if (isNaN(days) || days <= 0) {
                    return ctx.reply("❌ Masukkan angka hari yang valid:", backKeyboard);
                }
                const current = (typeof db.users[tid].akses === 'number' && db.users[tid].akses > Date.now()) ? db.users[tid].akses : Date.now(); 
                db.users[tid].akses = current + (days * 24 * 60 * 60 * 1000); 
                saveDB(); 
                ctx.session = null; 
                ctx.reply("✅ Sukses menambah akses.", ownerKeyboard);
            } catch (e) {
                console.error('[OWNER] Error adding akses:', e);
                ctx.reply("❌ Gagal menambah akses.", ownerKeyboard);
                ctx.session = null;
            }
        }
        
        if (step === 'ADD_POINT_USER') { 
            ctx.session.targetId = findUser(text); 
            if (!ctx.session.targetId) return ctx.reply("❌ User tidak ditemukan. Coba lagi:", backKeyboard); 
            ctx.session.step = 'ADD_POINT_VAL'; 
            ctx.reply("Kirim jumlah point (angka):"); 
        }
        
        if (step === 'ADD_POINT_VAL') { 
            try {
                const points = parseInt(text);
                if (isNaN(points) || points <= 0) {
                    return ctx.reply("❌ Masukkan angka point yang valid:", backKeyboard);
                }
                if (!db.users[ctx.session.targetId]) db.users[ctx.session.targetId] = { point: 0, reffCount: 0, akses: Date.now(), emails: [], currentEmailIndex: 0, limitFix: 2, limitCekBio: 2, limitCv: 2 };
                db.users[ctx.session.targetId].point = (db.users[ctx.session.targetId].point || 0) + points; 
                saveDB(); 
                ctx.session = null; 
                ctx.reply("✅ Sukses menambah point.", ownerKeyboard);
            } catch (e) {
                console.error('[OWNER] Error adding point:', e);
                ctx.reply("❌ Gagal menambah point.", ownerKeyboard);
                ctx.session = null;
            }
        }
        
        if (step === 'DEL_AKSES_USER') { 
            try {
                const tid = findUser(text); 
                if (tid && db.users[tid]) { 
                    db.users[tid].akses = 0; 
                    saveDB(); 
                    ctx.reply("✅ Akses terhapus.", ownerKeyboard); 
                } else {
                    ctx.reply("❌ User tidak ditemukan.", ownerKeyboard);
                }
                ctx.session = null;
            } catch (e) {
                console.error('[OWNER] Error deleting akses:', e);
                ctx.reply("❌ Gagal menghapus akses.", ownerKeyboard);
                ctx.session = null;
            }
        }
        
        if (step === 'BC_MSG') { 
            try {
                let count = 0;
                let failed = 0;
                for (let id in db.users) { 
                    try { 
                        await ctx.telegram.sendMessage(id, text); 
                        count++;
                    } catch (e) { 
                        failed++;
                        console.error('[BROADCAST] Failed to send to', id, e.message);
                    } 
                } 
                ctx.reply("✅ Broadcast selesai!\nBerhasil: " + count + "\nGagal: " + failed, ownerKeyboard); 
                ctx.session = null;
            } catch (e) {
                console.error('[OWNER] Error broadcasting:', e);
                ctx.reply("❌ Gagal broadcast.", ownerKeyboard);
                ctx.session = null;
            }
        }
        
        if (step === 'ADD_OWNER_EMAIL') { 
            const lines = text.split('\n').filter(line => line.trim() !== '');
            
            if (lines.length === 1 && !lines[0].includes('|')) {
                if (!text.includes('@') || !text.includes('.')) {
                    return ctx.reply("❌ Format email tidak valid! Masukkan email yang benar:", backKeyboard);
                }
                ctx.session.ownerEmail = text.trim(); 
                ctx.session.step = 'ADD_OWNER_EMAIL_PASS'; 
                return ctx.reply("Kirim App Password (16 digit):"); 
            }
            
            let validEmails = [];
            let invalidEmails = [];
            
            for (let line of lines) {
                const parts = line.split('|');
                if (parts.length === 2) {
                    const email = parts[0].trim();
                    const appPass = parts[1].trim();
                    
                    if (email.includes('@') && email.includes('.') && appPass.length === 16) {
                        validEmails.push({ email: email, appPass: appPass });
                    } else {
                        invalidEmails.push(line.trim());
                    }
                } else {
                    invalidEmails.push(line.trim());
                }
            }
            
            let verifiedValid = [];
            let verifiedInvalid = [];
            
            await ctx.reply("⏳ Sedang memverifikasi " + validEmails.length + " email, mohon tunggu...");
            
            for (let emailData of validEmails) {
                try {
                    let transporter = nodemailer.createTransport({ 
                        service: 'gmail', 
                        auth: { 
                            user: emailData.email, 
                            pass: emailData.appPass 
                        } 
                    });
                    
                    await transporter.verify();
                    verifiedValid.push(emailData);
                } catch (e) {
                    console.error('[OWNER BATCH] Verifikasi gagal untuk:', emailData.email, e.message);
                    verifiedInvalid.push(emailData.email + "|" + emailData.appPass + " (Verifikasi gagal)");
                }
            }
            
            if (!db.ownerEmails) db.ownerEmails = [];
            if (!db.totalEmail) db.totalEmail = 0;
            for (let emailData of verifiedValid) {
                db.ownerEmails.push({ 
                    email: emailData.email, 
                    appPass: emailData.appPass, 
                    addedAt: new Date().toISOString() 
                });
                db.totalEmail += 1;
            }
            saveDB();
            
            let reportMsg = "📊 HASIL PENAMBAHAN EMAIL OWNER\n\n";
            reportMsg += "✅ Email Valid: " + verifiedValid.length + "\n";
            reportMsg += "❌ Email Tidak Valid: " + (invalidEmails.length + verifiedInvalid.length) + "\n\n";
            
            if (verifiedValid.length > 0) {
                reportMsg += "📧 LIST EMAIL VALID:\n";
                verifiedValid.forEach((item, i) => {
                    reportMsg += (i + 1) + ". " + item.email + "\n";
                });
                reportMsg += "\n";
            }
            
            if (invalidEmails.length > 0 || verifiedInvalid.length > 0) {
                reportMsg += "❌ LIST EMAIL TIDAK VALID:\n";
                let idx = 1;
                invalidEmails.forEach((item) => {
                    reportMsg += idx + ". " + item + "\n";
                    idx++;
                });
                verifiedInvalid.forEach((item) => {
                    reportMsg += idx + ". " + item + "\n";
                    idx++;
                });
            }
            
            ctx.session = null;
            ctx.reply(reportMsg, ownerKeyboard);
        }
        
        if (step === 'ADD_OWNER_EMAIL_PASS') {
            try {
                const cleanPass = text.replace(/\s+/g, '');
                if (cleanPass.length !== 16) {
                    return ctx.reply("❌ App Password harus 16 digit! Coba lagi:", backKeyboard);
                }
                
                let transporter = nodemailer.createTransport({ 
                    service: 'gmail', 
                    auth: { 
                        user: ctx.session.ownerEmail, 
                        pass: cleanPass 
                    } 
                });
                
                await transporter.verify();
                
                if (!db.ownerEmails) db.ownerEmails = [];
                if (!db.totalEmail) db.totalEmail = 0;
                db.ownerEmails.push({ 
                    email: ctx.session.ownerEmail, 
                    appPass: cleanPass, 
                    addedAt: new Date().toISOString() 
                });
                db.totalEmail += 1;
                saveDB(); 
                ctx.session = null; 
                ctx.reply("✅ Berhasil tambah email owner!", ownerKeyboard);
            } catch (e) { 
                console.error('[OWNER] Error adding owner email:', e);
                ctx.session = null; 
                ctx.reply("❌ Gagal verifikasi email owner! Pastikan email dan App Password benar.", ownerKeyboard); 
            }
        }
        
        if (step === 'DELETE_OWNER_EMAIL_SELECT') {
            if (text.toLowerCase() === 'all') {
                try {
                    const totalEmails = db.ownerEmails ? db.ownerEmails.length : 0;
                    if (totalEmails === 0) {
                        ctx.session = null;
                        return ctx.reply("❌ Tidak ada email owner yang bisa dihapus.", ownerKeyboard);
                    }
                    
                    db.ownerEmails = [];
                    db.currentOwnerEmailIndex = 0;
                    saveDB();
                    
                    ctx.session = null;
                    return ctx.reply("✅ Berhasil menghapus " + totalEmails + " email owner!", ownerKeyboard);
                } catch (e) {
                    console.error('[OWNER] Error deleting all owner emails:', e);
                    ctx.reply("❌ Gagal menghapus semua email owner.", ownerKeyboard);
                    ctx.session = null;
                    return;
                }
            }
            
            const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '');
            
            if (lines.length === 1 && !isNaN(parseInt(lines[0]))) {
                const index = parseInt(lines[0]) - 1;
                if (lines[0] === '0') { 
                    ctx.session = null; 
                    return ctx.reply("❌ Batal.", ownerKeyboard); 
                }
                if (isNaN(index) || index < 0) {
                    return ctx.reply("❌ Masukkan angka yang valid, ketik 'all' untuk hapus semua, atau 0 untuk batal:", backKeyboard);
                }
                if (db.ownerEmails && db.ownerEmails[index]) {
                    const deletedEmail = db.ownerEmails[index].email;
                    db.ownerEmails.splice(index, 1); 
                    saveDB(); 
                    ctx.session = null;
                    ctx.reply("✅ Email owner " + deletedEmail + " berhasil dihapus!", ownerKeyboard);
                } else {
                    ctx.reply("❌ Angka tidak valid. Coba lagi, ketik 'all' untuk hapus semua, atau kirim 0 untuk batal:", backKeyboard);
                }
            } else {
                let indicesToDelete = [];
                let invalidInputs = [];
                let validInputs = [];
                
                for (let line of lines) {
                    const parts = line.split(',').map(p => p.trim()).filter(p => p !== '');
                    
                    for (let part of parts) {
                        const num = parseInt(part);
                        if (!isNaN(num) && num > 0) {
                            indicesToDelete.push(num - 1);
                            validInputs.push(num);
                        } else {
                            invalidInputs.push(part);
                        }
                    }
                }
                
                if (validInputs.length === 0) {
                    return ctx.reply("❌ Tidak ada angka yang valid. Masukkan angka email yang ingin dihapus (pisahkan dengan enter atau koma).", backKeyboard);
                }
                
                indicesToDelete.sort((a, b) => b - a);
                indicesToDelete = [...new Set(indicesToDelete)];
                
                let deletedEmails = [];
                let failedEmails = [];
                
                for (let index of indicesToDelete) {
                    if (db.ownerEmails && db.ownerEmails[index]) {
                        const deletedEmail = db.ownerEmails[index].email;
                        db.ownerEmails.splice(index, 1);
                        deletedEmails.push(deletedEmail);
                    } else {
                        failedEmails.push((index + 1));
                    }
                }
                
                if (db.currentOwnerEmailIndex >= db.ownerEmails.length) {
                    db.currentOwnerEmailIndex = 0;
                }
                
                saveDB();
                ctx.session = null;
                
                let reportMsg = "📊 HASIL PENGHAPUSAN EMAIL OWNER\n\n";
                
                if (deletedEmails.length > 0) {
                    reportMsg += "✅ Berhasil dihapus (" + deletedEmails.length + " email):\n";
                    deletedEmails.forEach((email, i) => {
                        reportMsg += (i + 1) + ". " + email + "\n";
                    });
                    reportMsg += "\n";
                }
                
                if (failedEmails.length > 0) {
                    reportMsg += "❌ Gagal dihapus (nomor tidak valid):\n";
                    failedEmails.forEach((num, i) => {
                        reportMsg += (i + 1) + ". Nomor " + num + "\n";
                    });
                    reportMsg += "\n";
                }
                
                if (invalidInputs.length > 0) {
                    reportMsg += "⚠️ Input tidak dikenali:\n";
                    invalidInputs.forEach((input, i) => {
                        reportMsg += (i + 1) + ". '" + input + "'\n";
                    });
                    reportMsg += "\n";
                }
                
                reportMsg += "📧 Sisa email owner: " + db.ownerEmails.length + " email";
                
                ctx.reply(reportMsg, ownerKeyboard);
            }
        }
    }
}));

// ==========================================
// CALLBACK QUERIES
// ==========================================

bot.on('callback_query', safeCallback(async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    
    // Handler untuk tombol Close di login WhatsApp
    if (data.startsWith('close_wa_login_')) {
        const expectedUserId = parseInt(data.replace('close_wa_login_', ''));
        if (userId !== expectedUserId) {
            return ctx.answerCbQuery('❌ Bukan pesan Anda!', { show_alert: true });
        }
        
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.error('[CLOSE WA LOGIN] Gagal hapus pesan:', e.message);
        }
        
        ctx.answerCbQuery('✅ Ditutup!');
        
        const isJoined = await checkJoin(ctx);
        if (!isJoined) {
            return ctx.reply("❌ Silahkan join grup & saluran dulu sebelum menggunakan bot!", verifyButtons);
        }
        
        const totalUser = Object.keys(db.users).length;
        let totalEmail = db.totalEmail || 0;
        try {
            if (totalEmail === 0 && db.ownerEmails) {
                totalEmail = db.ownerEmails.length;
                for (let uid in db.users) {
                    if (db.users[uid].emails) {
                        totalEmail += db.users[uid].emails.length;
                    }
                }
            }
        } catch (e) {
            console.error('[CLOSE WA LOGIN] Error counting emails:', e);
        }
        
        const runtimeMs = Date.now() - BOT_START_TIME;
        const runtimeDays = Math.floor(runtimeMs / (1000 * 60 * 60 * 24));
        const runtimeHours = Math.floor((runtimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const runtimeMinutes = Math.floor((runtimeMs % (1000 * 60 * 60)) / (1000 * 60));
        const runtimeText = runtimeDays > 0 ? runtimeDays + ' Hari ' + runtimeHours + ' Jam' : runtimeHours + ' Jam ' + runtimeMinutes + ' Menit';
        
        const now = new Date();
        const dateText = now.getDate() + ' ' + now.toLocaleString('id-ID', { month: 'long' }) + ' ' + now.getFullYear();
        
        const user = db.users[userId] || {};
        const username = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
        const accessText = getRemainingDays(userId);
        const totalFix = db.totalFix || 12629861;
        
        const welcomeMsg = "𓂀 Welcome to the ping bot, please use this bot wisely and responsibly.\n\n" +
            "𝑩  𝑶  𝑻   𝑭  𝑴  -  𝑷  𝑰  𝑵  𝑮\n" +
            "═══════════════════════\n" +
            "👤𝐏𝐫𝐨𝐟𝐢𝐥 𝐔𝐬𝐞𝐫\n" +
            "☻︎ Usᴇʀɴᴀᴍᴇ: " + username + "\n" +
            "☻︎ Aᴄᴄᴇss: " + accessText + "\n" +
            "☻︎ Rᴇғғᴇʀᴀʟ: " + (user.reffCount || 0) + "\n" +
            "☻︎ Pᴏɪɴᴛ: " + (user.point || 0) + "\n" +
            "═══════════════════════\n" +
            "✨𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐭𝐢𝐨𝐧\n" +
            "☻︎ Vᴇʀsɪᴏɴ: 2.3\n" +
            "☻︎ Rᴜɴ Tɪᴍᴇ: " + runtimeText + "\n" +
            "☻︎ Dᴀᴛᴇ: " + dateText + "\n" +
            "═══════════════════════\n" +
            "🌍 𝐒𝐭𝐚𝐭𝐢𝐬𝐭𝐢𝐤 𝐆𝐥𝐨𝐛𝐚𝐥\n" +
            "☻︎ Tᴏᴛᴀʟ Usᴇʀ: " + totalUser + "\n" +
            "☻︎ Tᴏᴛᴀʟ Eᴍᴀɪʟ: " + totalEmail + "\n" +
            "☻︎ Tᴏᴛᴀʟ Fɪx: " + totalFix.toLocaleString('id-ID') + "\n" +
            "═══════════════════════\n" +
            "☏︎ @PING0186";
        
        const startButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback('𝐅𝐈𝐓𝐔𝐑𝐄 🔧', 'menu_fitur'),
                Markup.button.callback('𝐏𝐑𝐄𝐌𝐈𝐔𝐌 💎', 'menu_premium')
            ],
            [Markup.button.callback('𝐎𝐓𝐇𝐄𝐑 𝐈𝐍𝐅𝐎 📑', 'menu_other')]
        ]);
        
        try {
            await ctx.replyWithPhoto(
                { source: './awal.jpg' },
                { 
                    caption: welcomeMsg
                }
            );
            await ctx.reply('⌨️ Pilih menu di bawah:', userId === OWNER_ID ? ownerKeyboard : mainKeyboard);
        } catch (err) {
            console.error('[CLOSE WA LOGIN] Error sending photo:', err);
            await ctx.reply(welcomeMsg);
            await ctx.reply('⌨️ Pilih menu di bawah:', userId === OWNER_ID ? ownerKeyboard : mainKeyboard);
        }
        
        return;
    }

    if (data === 'check_verify') {
        try {
            if (await checkJoin(ctx)) {
                await ctx.answerCbQuery("✅ Berhasil verifikasi!");
                return ctx.deleteMessage().catch(() => {});
            } else {
                return ctx.answerCbQuery("❌ Kamu belum join semua grup & saluran!", { show_alert: true });
            }
        } catch (e) {
            console.error('[CALLBACK] Error in check_verify:', e);
            return ctx.answerCbQuery("⚠️ Terjadi kesalahan", { show_alert: true });
        }
    }
    
    if (userId === OWNER_ID) {
        if (data === 'add_akses') {
            ctx.session = { step: 'ADD_AKSES_USER' };
            await ctx.answerCbQuery('Kirim username atau ID user:');
            return ctx.reply('Kirim username atau ID user yang akan ditambah akses:', backKeyboard);
        }
        
        if (data === 'add_point') {
            ctx.session = { step: 'ADD_POINT_USER' };
            await ctx.answerCbQuery('Kirim username atau ID user:');
            return ctx.reply('Kirim username atau ID user yang akan ditambah point:', backKeyboard);
        }
        
        if (data === 'del_akses') {
            ctx.session = { step: 'DEL_AKSES_USER' };
            await ctx.answerCbQuery('Kirim username atau ID user:');
            return ctx.reply('Kirim username atau ID user yang akan dihapus akses:', backKeyboard);
        }
        
        if (data === 'bc') {
            ctx.session = { step: 'BC_MSG' };
            await ctx.answerCbQuery('Kirim pesan broadcast:');
            return ctx.reply('Kirim pesan yang akan di-broadcast ke semua user:', backKeyboard);
        }
        
        if (data === 'add_owner_email') {
            ctx.session = { step: 'ADD_OWNER_EMAIL' };
            await ctx.answerCbQuery('Mode batch: email|pass (banyak baris)');
            return ctx.reply('📧 TAMBAH EMAIL OWNER\n\nKirim dalam format:\nemail1@gmail.com|password1\nemail2@gmail.com|password2\n\nAtau kirim email tunggal:', backKeyboard);
        }
        
        if (data === 'list_owner_email') {
            try {
                if (!db.ownerEmails || db.ownerEmails.length === 0) {
                    return ctx.answerCbQuery('Tidak ada email owner!', { show_alert: true });
                }
                
                await ctx.answerCbQuery('Total: ' + db.ownerEmails.length + ' email');
                
                const emailsPerPage = 50;
                const totalPages = Math.ceil(db.ownerEmails.length / emailsPerPage);
                
                for (let page = 0; page < totalPages; page++) {
                    const start = page * emailsPerPage;
                    const end = Math.min(start + emailsPerPage, db.ownerEmails.length);
                    const chunk = db.ownerEmails.slice(start, end);
                    
                    let msg = "";
                    if (page === 0) {
                        msg = "📧 DAFTAR EMAIL OWNER (" + db.ownerEmails.length + " email):\n\n";
                    } else {
                        msg = "📧 DAFTAR EMAIL OWNER (Lanjutan " + (page + 1) + "/" + totalPages + "):\n\n";
                    }
                    
                    chunk.forEach((item, index) => {
                        const globalIndex = start + index + 1;
                        msg += globalIndex + ". " + item.email + "\n";
                    });
                    
                    try {
                        await ctx.reply(msg, ownerKeyboard);
                    } catch (sendErr) {
                        console.error('[OWNER LIST] Error sending page ' + (page + 1) + ':', sendErr.message);
                        continue;
                    }
                }
                
                return;
            } catch (e) {
                console.error('[OWNER] Error listing emails:', e);
                return ctx.answerCbQuery('❌ Gagal memuat daftar', { show_alert: true });
            }
        }
        
        if (data === 'del_owner_email') {
            try {
                if (!db.ownerEmails || db.ownerEmails.length === 0) {
                    return ctx.answerCbQuery('Tidak ada email owner!', { show_alert: true });
                }
                
                const emailsPerPage = 50;
                const totalPages = Math.ceil(db.ownerEmails.length / emailsPerPage);
                
                await ctx.answerCbQuery('Pilih email yang akan dihapus');
                
                for (let page = 0; page < totalPages; page++) {
                    const start = page * emailsPerPage;
                    const end = Math.min(start + emailsPerPage, db.ownerEmails.length);
                    const chunk = db.ownerEmails.slice(start, end);
                    
                    let msg = "";
                    if (page === 0) {
                        msg = "❌ HAPUS EMAIL OWNER\n\n";
                    } else {
                        msg = "❌ HAPUS EMAIL OWNER (Lanjutan " + (page + 1) + "/" + totalPages + "):\n\n";
                    }
                    
                    chunk.forEach((item, index) => {
                        const globalIndex = start + index + 1;
                        msg += globalIndex + ". " + item.email + "\n";
                    });
                    
                    try {
                        if (page === totalPages - 1) {
                            msg += "\nKirim angka (1, 2, dst) pisahkan dengan ENTER untuk hapus banyak sekaligus.\nContoh:\n1\n2\n5\n\nAtau ketik 'all' untuk hapus semua, atau 0 untuk batal.";
                            await ctx.reply(msg, backKeyboard);
                        } else {
                            await ctx.reply(msg, ownerKeyboard);
                        }
                    } catch (sendErr) {
                        console.error('[OWNER DELETE] Error sending page ' + (page + 1) + ':', sendErr.message);
                        continue;
                    }
                }
                
                ctx.session = { step: 'DELETE_OWNER_EMAIL_SELECT' };
                return;
            } catch (e) {
                console.error('[OWNER] Error preparing delete:', e);
                return ctx.answerCbQuery('❌ Gagal', { show_alert: true });
            }
        }
        
        if (data === 'get_owner_email') {
            try {
                if (!db.ownerEmails || db.ownerEmails.length === 0) {
                    return ctx.answerCbQuery('Tidak ada email owner!', { show_alert: true });
                }
                
                await ctx.answerCbQuery('Mengambil ' + db.ownerEmails.length + ' email...');
                
                let emailList = "";
                db.ownerEmails.forEach((item) => {
                    emailList += item.email + "|" + item.appPass + "\n";
                });
                
                const filename = "email_owner_" + Date.now() + ".txt";
                fs.writeFileSync(filename, emailList.trim());
                
                await ctx.replyWithDocument(
                    { source: filename },
                    { caption: "📤 AMBIL EMAIL OWNER\n\nTotal: " + db.ownerEmails.length + " email\nFormat: email|apppassword (tanpa spasi)" }
                );
                
                fs.unlinkSync(filename);
                return;
            } catch (e) {
                console.error('[OWNER] Error getting emails:', e);
                return ctx.answerCbQuery('❌ Gagal mengambil email', { show_alert: true });
            }
        }
    }
    
    ctx.answerCbQuery('✅').catch(() => {});
}));

// ==========================================
// FILE HANDLER FOR CEK BIO FILE
// ==========================================

bot.on('document', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    const step = ctx.session?.step;
    
    if (!step) return;
    
    // === CEK BIO FILE ===
    if (step === 'CEK_BIO_FILE') {
        const fileName = ctx.message.document.file_name;
        const fileId = ctx.message.document.file_id;
        
        if (!fileName.match(/\.(txt|csv|xlsx)$/i)) {
            return ctx.reply("❌ Format file tidak didukung! Gunakan TXT, CSV, atau XLSX.", backKeyboard);
        }

        const activeSock = getActiveSocket(userId);
        if (!activeSock) {
            ctx.session = null;
            return ctx.reply("🚫 Sender tidak aktif!", cekBioKeyboard);
        }

        try {
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
            const fileBuffer = Buffer.from(response.data);

            let numbersRaw = [];
            const ext = fileName.split('.').pop().toLowerCase();

            if (ext === 'txt') {
                numbersRaw = fileBuffer.toString('utf8').split(/[\r\n]+/).filter(n => n.trim().length > 0);
            } else if (ext === 'csv') {
                numbersRaw = await new Promise((resolve, reject) => {
                    const numbers = [];
                    const bufferStream = new PassThrough();
                    bufferStream.end(fileBuffer);
                    bufferStream.pipe(csv())
                        .on('data', (row) => {
                            Object.values(row).forEach(value => {
                                if (value && value.toString().trim().length > 0) {
                                    numbers.push(value.toString().trim());
                                }
                            });
                        })
                        .on('end', () => resolve(numbers))
                        .on('error', reject);
                });
            } else if (ext === 'xlsx') {
                const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
                numbersRaw = [];
                workbook.SheetNames.forEach(sheetName => {
                    const worksheet = workbook.Sheets[sheetName];
                    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                    data.flat().forEach(value => {
                        if (value && value.toString().trim().length > 0) {
                            numbersRaw.push(value.toString().trim());
                        }
                    });
                });
            }

            const validNumbers = numbersRaw.map(n => normalizeNumber(n)).filter(n => n.length >= 10 && n.length <= 15);

            if (validNumbers.length === 0) {
                ctx.session = null;
                return ctx.reply("❌ Tidak ada nomor valid dalam file!", cekBioKeyboard);
            }

            if (validNumbers.length > 300) {
                ctx.session = null;
                return ctx.reply("❌ Maksimal 300 nomor per file!", cekBioKeyboard);
            }

            await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
            
            const progressFrames = ['⏳', '⌛', '🔄', '⚡', '💫', '✨', '🌟', '💥', '🔥', '⚡'];
            let frameIndex = 0;
            
            const progressMsg = await ctx.reply(`⏳ Memulai pengecekan 0/${validNumbers.length} nomor...\n\n[░░░░░░░░░░░░░░░░░░] 0%`);

            const results = [];
            const batchSize = 30;

            for (let i = 0; i < validNumbers.length; i += batchSize) {
                const batch = validNumbers.slice(i, i + batchSize);

                const batchResults = await Promise.all(batch.map(async (num) => {
                    const jid = num + '@s.whatsapp.net';

                    try {
                        const [wa] = await activeSock.onWhatsApp(jid);
                        if (!wa?.exists) return { number: num, registered: false };

                        let bio = '';
                        let setAt = null;

                        try {
                            await new Promise(r => setTimeout(r, 200));
                            const status = await activeSock.fetchStatus(jid);
                            if (status?.[0]?.status) {
                                bio = status[0].status.status || '';
                                setAt = status[0].status.setAt ? new Date(status[0].status.setAt) : null;
                            }
                        } catch {}

                        let meta = { verified: false };
                        try { meta = await checkMetaBusiness(activeSock, jid); } catch {}

                        return {
                            number: num,
                            registered: true,
                            bio,
                            setAt,
                            metaBusiness: meta.isBusiness || false,
                            verifiedMeta: meta.verified || false,
                            metaDetail: meta,
                            jamPercentage: getJamPercentage(bio, setAt, meta.verified)
                        };
                    } catch {
                        return { number: num, registered: false };
                    }
                }));

                results.push(...batchResults);

                const processed = Math.min(i + batchSize, validNumbers.length);
                const percentage = Math.round((processed / validNumbers.length) * 100);
                const filledBlocks = Math.round((percentage / 100) * 20);
                const emptyBlocks = 20 - filledBlocks;
                const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
                const frame = progressFrames[frameIndex % progressFrames.length];
                frameIndex++;
                
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progressMsg.message_id,
                        null,
                        `${frame} Memeriksa ${processed}/${validNumbers.length} nomor...\n\n[${progressBar}] ${percentage}%\n\n✅ Selesai: ${results.filter(r => r.registered).length}\n❌ Tidak Terdaftar: ${results.filter(r => !r.registered).length}`
                    );
                } catch {}

                await new Promise(r => setTimeout(r, 300));
            }

            const filenameResult = createBioResultFile(results, validNumbers.length, fileName);

            if (!fs.existsSync(filenameResult)) {
                throw new Error('File hasil tidak berhasil dibuat');
            }

            const total = validNumbers.length;
            const registered = results.filter(r => r.registered).length;
            const notRegistered = results.filter(r => !r.registered).length;
                const withBio = results.filter(r => r.registered && r.bio);
                const withoutBioCount = registered - withBio.length;
                
                const metaBusinessResults = results.filter(r => r.registered && r.metaBusiness);
            const waBusinessApp = metaBusinessResults.filter(r => r.metaDetail?.businessType === 'APP').length;
            const waBusinessAPI = metaBusinessResults.filter(r => r.metaDetail?.businessType === 'API').length;
            const eklusifCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Eklusif').length;
            const standartCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Standart').length;
            const lowCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Low').length;
            const suiteCount = metaBusinessResults.filter(r => getMetaTier(r.metaDetail) === 'Suite').length;

            const bioByYear = {};
            withBio.forEach(r => {
                if (r.setAt) {
                    const year = new Date(r.setAt).getFullYear();
                    bioByYear[year] = (bioByYear[year] || 0) + 1;
                }
            });

            let yearStats = '';
            Object.keys(bioByYear).sort().forEach(year => {
                yearStats += `- ${year}: ${bioByYear[year]}\n`;
            });

            try { 
                await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id); 
            } catch (e) {
                console.log('[CEK BIO FILE] Gagal hapus progress:', e.message);
            }

            await ctx.replyWithDocument(
                { source: filenameResult },
                {
                    caption:
                        `📋 *HASIL CEK BIO WHATSAPP*\n\n` +
                        `*Statistik Ringkasan:*\n` +
                        `- Terdaftar WA: ${registered}\n` +
                        `- Tidak Terdaftar WA: ${notRegistered}\n` +
                        `- Memiliki Bio: ${withBio.length}\n` +
                        `- Tanpa Bio: ${withoutBioCount}\n` +
                        `- Business Meta: ${metaBusinessResults.length}\n` +
                        `  ├─ Eklusif: ${eklusifCount}\n` +
                        `  ├─ Standart: ${standartCount}\n` +
                        `  ├─ Low: ${lowCount}\n` +
                        `  └─ Suite: ${suiteCount}\n\n` +
                        (yearStats ? `*Statistik Bio Berdasarkan Tahun Set:*\n${yearStats}\n` : '') +
                        `🕒 Waktu: ${new Date().toLocaleString('id-ID')}`,
                    parse_mode: 'Markdown'
                }
            );

            await new Promise(r => setTimeout(r, 2000));
            
            try {
                if (fs.existsSync(filenameResult)) {
                    fs.unlinkSync(filenameResult);
                }
            } catch (e) {
                console.log('[CEK BIO FILE] Gagal hapus file:', e.message);
            }
            
            ctx.session = null;

        } catch (err) {
            console.error('cekbiofile error:', err);
            try { 
                if (typeof progressMsg !== 'undefined' && progressMsg && progressMsg.message_id) {
                    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id); 
                }
            } catch {}
            ctx.session = null;
            await ctx.reply('❌ Terjadi kesalahan: ' + (err.message || 'Unknown error'), cekBioKeyboard);
        }
    }
    
    // === FITUR CV FILE HANDLERS ===
    
    // CV VCF - Terima file TXT
    if (step === 'CV_VCF') {
        const fileName = ctx.message.document.file_name;
        if (!fileName.endsWith('.txt')) {
            return ctx.reply("❌ Kirim file .txt!", backKeyboard);
        }
        
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(fileLink.href);
            const content = res.data.toString();
            
            ctx.session.content = content;
            ctx.session.step = 'CV_VCF_1';
            return ctx.reply("✍️ Masukan nama kontak", backKeyboard);
        } catch (e) {
            console.error('CV VCF error:', e);
            ctx.session = null;
            return ctx.reply("❌ Gagal memproses file.", cvKeyboard);
        }
    }
    
    // CV TXT - Terima file VCF
    if (step === 'CV_TXT') {
        const fileName = ctx.message.document.file_name;
        if (!fileName.endsWith('.vcf')) {
            return ctx.reply("❌ Kirim file .vcf!", backKeyboard);
        }
        
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(fileLink.href);
            const content = res.data.toString();
            
            const numbers = content.match(/TEL(?:.*):(.*)/g);
            if (!numbers) return ctx.reply("❌ Bukan VCF valid.", backKeyboard);
            
            ctx.session.extractedNumbers = numbers.map(x => x.split(':')[1].trim()).join('\n');
            ctx.session.step = 'CV_TXT_NAME';
            return ctx.reply("✍️ Masukan nama file", backKeyboard);
        } catch (e) {
            console.error('CV TXT error:', e);
            ctx.session = null;
            return ctx.reply("❌ Gagal memproses file.", cvKeyboard);
        }
    }
    
    // CV GABUNG - Terima file VCF
    if (step === 'CV_GABUNG') {
        const fileName = ctx.message.document.file_name;
        if (!fileName.endsWith('.vcf')) {
            return ctx.reply("❌ Kirim file .vcf!", backKeyboard);
        }
        
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(fileLink.href);
            const content = res.data.toString();
            
            ctx.session.files.push(content);
            return ctx.reply(`✅ File ke-${ctx.session.files.length} masuk. Ketik /done.`, backKeyboard);
        } catch (e) {
            console.error('CV GABUNG error:', e);
            return ctx.reply("❌ Gagal memproses file.", backKeyboard);
        }
    }
    
    // CV PECAH - Terima file VCF
    if (step === 'CV_PECAH') {
        const fileName = ctx.message.document.file_name;
        if (!fileName.endsWith('.vcf')) {
            return ctx.reply("❌ Kirim file .vcf!", backKeyboard);
        }
        
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(fileLink.href);
            const content = res.data.toString();
            
            const cards = content.match(/BEGIN:VCARD[\s\S]*?END:VCARD/g);
            if (!cards) return ctx.reply("❌ File kosong.", backKeyboard);
            
            ctx.session.cards = cards;
            ctx.session.step = 'CV_PEC_SZ';
            return ctx.reply("✍️ Kontak per file:", backKeyboard);
        } catch (e) {
            console.error('CV PECAH error:', e);
            ctx.session = null;
            return ctx.reply("❌ Gagal memproses file.", cvKeyboard);
        }
    }
    
    // CV RENAME CTC - Terima file VCF
    if (step === 'CV_RE_CTC') {
        const fileName = ctx.message.document.file_name;
        if (!fileName.endsWith('.vcf')) {
            return ctx.reply("❌ Kirim file .vcf!", backKeyboard);
        }
        
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(fileLink.href);
            const content = res.data.toString();
            
            const cards = content.match(/BEGIN:VCARD[\s\S]*?END:VCARD/g);
            if (!cards) return ctx.reply("❌ File kosong.", backKeyboard);
            
            ctx.session.cards = cards;
            ctx.session.step = 'CV_RE_CTC_V';
            return ctx.reply("✍️ Nama ctc baru:", backKeyboard);
        } catch (e) {
            console.error('CV RENAME CTC error:', e);
            ctx.session = null;
            return ctx.reply("❌ Gagal memproses file.", cvKeyboard);
        }
    }
    
    // CV RENAME FILE - Terima file VCF
    if (step === 'CV_RE_FILE') {
        const fileName = ctx.message.document.file_name;
        if (!fileName.endsWith('.vcf')) {
            return ctx.reply("❌ Kirim file .vcf!", backKeyboard);
        }
        
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(fileLink.href);
            const content = res.data.toString();
            
            ctx.session.content = content;
            ctx.session.step = 'CV_RE_FILE_V';
            return ctx.reply("✍️ Nama file:", backKeyboard);
        } catch (e) {
            console.error('CV RENAME FILE error:', e);
            ctx.session = null;
            return ctx.reply("❌ Gagal memproses file.", cvKeyboard);
        }
    }
    
    // CV PINTAR - Terima file
    if (step === 'CV_PINTAR') {
        const fileName = ctx.message.document.file_name;
        
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(fileLink.href);
            const content = res.data.toString();
            
            if (!ctx.session.data) ctx.session.data = [];
            ctx.session.data.push({ content });
            return ctx.reply(`✅ File ke-${ctx.session.data.length} diterima. Lanjut kirim atau /done`, backKeyboard);
        } catch (e) {
            console.error('CV PINTAR error:', e);
            return ctx.reply("❌ Gagal memproses file.", backKeyboard);
        }
    }
}));

// ==========================================
// COMMAND /done FOR CV PINTAR & GABUNG
// ==========================================

bot.command('done', safeHandler(async (ctx) => {
    const userId = ctx.from.id;
    const step = ctx.session?.step;
    
    if (!step) return;
    
    // CV GABUNG - Done
    if (step === 'CV_GABUNG') {
        if (!ctx.session.files || ctx.session.files.length === 0) {
            return ctx.reply("📩 Belum ada file.", cvKeyboard);
        }
        ctx.session.step = 'CV_GABUNG_NAME';
        return ctx.reply("✍️ Kirim nama file", backKeyboard);
    }
    
    // CV PINTAR - Done
    if (step === 'CV_PINTAR') {
        if (!ctx.session.data || ctx.session.data.length === 0) {
            return ctx.reply("📩 Belum ada file.", cvKeyboard);
        }
        
        ctx.reply("⏳ Sedang memproses...");
        
        for (let item of ctx.session.data) {
            const rawLines = item.content.split('\n');
            const lines = rawLines.map(l => l.trim()).filter(l => l !== "");
            
            const labelNameIndex = lines.findIndex(l => l.includes("群组名字"));
            let groupName = (labelNameIndex !== -1 && lines[labelNameIndex + 1]) ? lines[labelNameIndex + 1].replace(/[^\w\s]/gi, '') : "Hasil_CV";

            const labelDescIndex = lines.findIndex(l => l.includes("群组描述"));
            const labelAdminStart = lines.findIndex(l => l.includes("管理"));
            let fullDescription = "";
            if (labelDescIndex !== -1 && labelAdminStart !== -1) {
                fullDescription = lines.slice(labelDescIndex + 1, labelAdminStart).join('\n');
            }

            let adminNums = [];
            let memberNums = [];
            let isRecordingAdmin = false;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.includes("管理")) {
                    isRecordingAdmin = true;
                    const matches = line.match(/\d{9,15}/g);
                    if (matches) adminNums.push(...matches);
                    continue;
                }
                if (line.includes("底料") || line.includes("水军") || line.includes("号码")) {
                    isRecordingAdmin = false;
                    const matches = line.match(/\d{9,15}/g);
                    if (matches) memberNums.push(...matches);
                    continue;
                }
                const numOnlyMatches = line.match(/\d{9,15}/g);
                if (numOnlyMatches) {
                    if (isRecordingAdmin) adminNums.push(...numOnlyMatches);
                    else memberNums.push(...numOnlyMatches);
                }
            }

            adminNums = [...new Set(adminNums)];
            memberNums = [...new Set(memberNums)];

            let vcfContent = "";
            adminNums.forEach((num, i) => { vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:${ctx.session.adminName || 'Admin'} ${i+1}\nTEL;TYPE=CELL:${num}\nEND:VCARD\n`; });
            memberNums.forEach((num, i) => { vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:${ctx.session.memberName || 'Member'} ${i+1}\nTEL;TYPE=CELL:${num}\nEND:VCARD\n`; });
            
            const fn = `./${groupName}.vcf`;
            fs.writeFileSync(fn, vcfContent);
            await ctx.telegram.sendDocument(ctx.chat.id, { source: fn, filename: `${groupName}.vcf` });
            if (fullDescription) await ctx.reply(`📝 **Deskripsi Grup:**\n\n${fullDescription}`);
            if (fs.existsSync(fn)) fs.unlinkSync(fn);
        }
        
        ctx.reply("✅ SEMUA PROSES SELESAI", cvKeyboard);
        return ctx.session = null;
    }
}));

// ==========================================
// BOT LAUNCH DENGAN AUTO-RECONNECT
// ==========================================

const launchBot = () => {
    try {
        bot.launch()
            .then(() => console.log("[BOT] Bot PING Berjalan dengan Anti-Crash System..."))
            .catch((err) => {
                console.error('[BOT] Launch error:', err);
                console.log('[BOT] Mencoba reconnect dalam 5 detik...');
                setTimeout(launchBot, 5000);
            });
    } catch (e) {
        console.error('[BOT] Fatal launch error:', e);
        console.log('[BOT] Mencoba reconnect dalam 10 detik...');
        setTimeout(launchBot, 10000);
    }
};

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Start bot
launchBot();




