/* ============================================================
   src/utils/helpers.js
   - Định dạng response THUẤT NHẤT cho mọi API.
   - Mã lỗi thống nhất.
   - Sinh & kiểm tra trùng mã mời (prefix HY / PXE / GNTU + 6 ký tự).
   - Phân loại mã: mã người dùng vs mã hệ thống.
   - Cấu hình thưởng referral (đệ quy 2 cấp) + mốc thưởng theo lượt mời.
   - Làm sạch dữ liệu user trước khi trả về client.
   ============================================================ */
'use strict';
const { db } = require('../config/firebase');

/* ---------------- Mã lỗi thống nhất ---------------- */
const ERROR_CODES = Object.freeze({
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    AUTH_INVALID: 'AUTH_INVALID',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    USER_NOT_INITIALIZED: 'USER_NOT_INITIALIZED',
    CODE_NOT_FOUND: 'CODE_NOT_FOUND',
    CODE_OWN: 'CODE_OWN',
    CODE_USED: 'CODE_USED',               // đã từng nhập mã người dùng (chỉ 1 lần)
    CODE_EXPIRED: 'CODE_EXPIRED',         // mã hệ thống đã ngừng kích hoạt
    CODE_MAX_USES: 'CODE_MAX_USES',       // mã hệ thống đã hết lượt dùng
    CODE_ALREADY_USED: 'CODE_ALREADY_USED', // người dùng đã dùng mã hệ thống này rồi
    ADMIN_REQUIRED: 'ADMIN_REQUIRED',
    RATE_LIMITED: 'RATE_LIMITED',
    SERVER_ERROR: 'SERVER_ERROR'
});

/* ---------------- Response thống nhất ---------------- */
function attachResponseHelpers(req, res, next) {
    res.ok = function (data = null, message = 'Thành công', status = 200) {
        return res.status(status).json({ success: true, message, data, error: null });
    };
    res.fail = function (message = 'Có lỗi xảy ra', error = ERROR_CODES.SERVER_ERROR, status = 400) {
        return res.status(status).json({ success: false, message, data: null, error });
    };
    next();
}

/* ---------------- Mã mời ----------------
   Tiền tố nhận diện (theo yêu cầu):
     AC   = mã mời người dùng (user) — thay thế HY cũ.
     HY   = mã hệ thống (system).
     PXE / GNTU = mã đặc biệt (special promo — vẫn là system_codes).
     ADM  = mã mời quản trị viên (admin-created, vẫn trong system_codes).
   Lưu ý: tương thích ngược — user cũ vẫn có mã HY... và vẫn dùng được.
------------------------------------------------------ */
const CODE_PREFIX = Object.freeze({
    USER: 'AC',
    SYSTEM_HY: 'HY',
    SYSTEM_PXE: 'PXE',
    SYSTEM_GNTU: 'GNTU',
    ADMIN: 'ADM'
});
// Các prefix hợp lệ cho system_codes (dùng khi admin tạo mã).
const SYSTEM_PREFIXES = [CODE_PREFIX.SYSTEM_HY, CODE_PREFIX.SYSTEM_PXE, CODE_PREFIX.SYSTEM_GNTU, CODE_PREFIX.ADMIN];
/* ---------------- Admin (chống giả mạo) ----------------
   Danh sách email được quyền admin. Lấy từ env ADMIN_EMAILS
   (phân tách bằng dấu phẩy). Mặc định gồm tài khoản test của chủ dự án.
   - Email được lấy TỪ Firebase token đã verify (không tin client).
   - Đồng thời server kiểm tra users.doc(uid).role === 'admin' (role chỉ
     server mới set được, client không ghi đè). Hai lớp này phải đồng thời
     thỏa mãn → không thể giả mạo admin bằng cách sửa payload.
------------------------------------------------------ */
const DEFAULT_ADMIN_EMAILS = ['thanhlinh182005@gmail.com'];
function getAdminEmails() {
    const raw = String(process.env.ADMIN_EMAILS || '').trim().toLowerCase();
    const fromEnv = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const set = new Set([...DEFAULT_ADMIN_EMAILS, ...fromEnv]);
    return Array.from(set);
}
function isAdminEmail(email) {
    if (!email) return false;
    return getAdminEmails().includes(String(email).trim().toLowerCase());
}
/* Khóa mở panel quản trị viên (yếu tố thứ 2, ngoài role admin).
   Client phải gửi header x-admin-panel-key khớp mới gọi được /admin/*.
   Mặc định = key của nick thanhlinh. Đổi qua env ADMIN_PANEL_KEY.
   Để trống env (rỗng) sẽ vô hiệu hóa lớp khóa này (không khuyến nghị). */
function getAdminPanelKey() {
    const v = process.env.ADMIN_PANEL_KEY;
    if (v === undefined) return '2306#GNtu_HY'; // mặc định
    return String(v);
}
// 6 ký tự ngẫu nhiên đằng sau mỗi mã.
const CODE_RANDOM_LENGTH = 6;
// Bảng chữ cái loại bỏ ký tự dễ nhầm: 0/O, 1/I/L.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRandomPart(length = CODE_RANDOM_LENGTH) {
    let part = '';
    for (let i = 0; i < length; i++) {
        part += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return part;
}

function generateInviteCode(prefix = CODE_PREFIX.USER, length = CODE_RANDOM_LENGTH) {
    return prefix + generateRandomPart(length);
}

/**
 * Phân loại mã mời dựa trên prefix.
 * @returns {{type:'user'|'system', prefix:string, subtype?:string}|null}
 */
function classifyCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (new RegExp(`^${CODE_PREFIX.USER}[A-Z0-9]{${CODE_RANDOM_LENGTH},}$`).test(c)) {
        return { type: 'user', prefix: CODE_PREFIX.USER };
    }
    if (c.startsWith(CODE_PREFIX.SYSTEM_HY)) return { type: 'system', prefix: CODE_PREFIX.SYSTEM_HY, subtype: 'hệ thống' };
    if (c.startsWith(CODE_PREFIX.SYSTEM_PXE)) return { type: 'system', prefix: CODE_PREFIX.SYSTEM_PXE, subtype: 'đặc biệt' };
    if (c.startsWith(CODE_PREFIX.SYSTEM_GNTU)) return { type: 'system', prefix: CODE_PREFIX.SYSTEM_GNTU, subtype: 'đặc biệt' };
    if (c.startsWith(CODE_PREFIX.ADMIN)) return { type: 'system', prefix: CODE_PREFIX.ADMIN, subtype: 'quản trị viên' };
    return null;
}

/**
 * Sinh mã mời DUY NHẤT — kiểm tra trùng trong CẢ users.inviteCode lẫn system_codes.
 */
async function generateUniqueInviteCode(prefix = CODE_PREFIX.USER, length = CODE_RANDOM_LENGTH, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const code = generateInviteCode(prefix, length);
        const userSnap = await db.collection('users').where('inviteCode', '==', code).limit(1).get();
        if (!userSnap.empty) continue;
        const sysSnap = await db.collection('system_codes').doc(code).get();
        if (sysSnap.exists) continue;
        return code;
    }
    // Rất hiếm: tăng độ dài phần ngẫu nhiên và thử lại.
    return generateUniqueInviteCode(prefix, length + 2, 3);
}

/* ---------------- Thưởng referral (đệ quy 2 cấp) ----------------
   Khi B nhập mã của A:
   - B (người được mời)  : WELCOME coin (quà chào mừng)
   - A (người mời trực tiếp, cấp 1): DIRECT coin
   - Nếu A cũng từng nhập mã của C → C (cấp 2, ông/bà mời): SECOND_LEVEL coin
------------------------------------------------------ */
const REFERRAL_REWARDS = Object.freeze({
    WELCOME: Number(process.env.INVITE_WELCOME_COINS) || 50,
    DIRECT: Number(process.env.INVITE_REWARD_COINS) || 100,
    SECOND_LEVEL: Number(process.env.REFERRAL_SECOND_LEVEL_COINS) || 20
});

/* ---------------- Mốc thưởng theo số lượt mời ---------------- */
const INVITE_MILESTONES = Object.freeze([
    { id: 'm3',  required: 3,  coins: 200,  label: 'Mời 3 bạn' },
    { id: 'm5',  required: 5,  coins: 300,  label: 'Mời 5 bạn' },
    { id: 'm10', required: 10, coins: 500,  label: 'Mời 10 bạn' },
    { id: 'm25', required: 25, coins: 1500, label: 'Mời 25 bạn' },
    { id: 'm50', required: 50, coins: 4000, label: 'Mời 50 bạn' }
]);

/* ---------------- Làm sạch dữ liệu user ----------------
   Chỉ trả về các field an toàn cho client.
   rewardsHistory cắt còn 50 mục gần nhất để response nhẹ.
------------------------------------------------------ */
function sanitizeUser(data) {
    if (!data) return null;
    const history = Array.isArray(data.rewardsHistory) ? data.rewardsHistory : [];
    const role = data.role || 'user';
    const email = data.email || '';
    const isAdmin = role === 'admin' || isAdminEmail(email);
    return {
        uid: data.uid || null,
        email: email,
        displayName: data.displayName || 'Người dùng',
        avatar: data.avatar || '',
        bio: data.bio || '',
        createdAt: data.createdAt || null,
        lastLoginAt: data.lastLoginAt || null,
        role: role,
        isAdmin: isAdmin,
        inviteBypass: !!data.inviteBypass || isAdmin,
        inviteCode: data.inviteCode || '',
        invitedBy: data.invitedBy || null,
        inviteUsed: !!data.inviteUsed,
        inviteCount: Number(data.inviteCount) || 0,
        inviteRewardsTotal: Number(data.inviteRewardsTotal) || 0,
        inviteHistory: Array.isArray(data.inviteHistory) ? data.inviteHistory : [],
        claimedMilestones: Array.isArray(data.claimedMilestones) ? data.claimedMilestones : [],
        coins: Number(data.coins) || 0,
        settings: data.settings || {},
        library: Array.isArray(data.library) ? data.library : [],
        highScores: data.highScores || {},
        progress: data.progress || {},
        rewardsHistory: history.slice(-50),
        systemCodesUsedCount: Array.isArray(data.usedSystemCodes) ? data.usedSystemCodes.length : 0
    };
}

/* ---------------- Thống kê user ---------------- */
function computeStats(data) {
    const highScores = data.highScores || {};
    const scores = Object.values(highScores).map((v) => Number(v) || 0);
    const bestScore = scores.length ? Math.max(...scores) : 0;
    return {
        totalGames: Array.isArray(data.library) ? data.library.length : 0,
        bestScore,
        highScores,
        inviteCount: Number(data.inviteCount) || 0,
        inviteRewardsTotal: Number(data.inviteRewardsTotal) || 0,
        coins: Number(data.coins) || 0,
        claimedMilestones: Array.isArray(data.claimedMilestones) ? data.claimedMilestones : []
    };
}

module.exports = {
    ERROR_CODES,
    attachResponseHelpers,
    CODE_PREFIX,
    SYSTEM_PREFIXES,
    CODE_RANDOM_LENGTH,
    generateInviteCode,
    generateUniqueInviteCode,
    classifyCode,
    getAdminEmails,
    isAdminEmail,
    getAdminPanelKey,
    REFERRAL_REWARDS,
    INVITE_MILESTONES,
    sanitizeUser,
    computeStats
};
