/* ============================================================
   src/utils/helpers.js
   - Định dạng response THUẬN NHẤT cho mọi API.
   - Mã lỗi thống nhất.
   - Sinh & kiểm tra trùng mã mời.
   - Cấu hình mốc thưởng (milestone) theo số lượt mời thành công.
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
    CODE_USED: 'CODE_USED',
    RATE_LIMITED: 'RATE_LIMITED',
    SERVER_ERROR: 'SERVER_ERROR'
});

/* ---------------- Response thống nhất ----------------
   Mọi API trả về đúng định dạng:
   { success, message, data, error }
   Gắn vào res qua middleware ở index.js.
------------------------------------------------------ */
function attachResponseHelpers(req, res, next) {
    res.ok = function (data = null, message = 'Thành công', status = 200) {
        return res.status(status).json({
            success: true,
            message,
            data,
            error: null
        });
    };
    res.fail = function (message = 'Có lỗi xảy ra', error = ERROR_CODES.SERVER_ERROR, status = 400) {
        return res.status(status).json({
            success: false,
            message,
            data: null,
            error
        });
    };
    next();
}

/* ---------------- Mã mời ---------------- */
// Bảng chữ cái loại bỏ ký tự dễ nhầm: 0/O, 1/I/L.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateInviteCode(length = 6) {
    let code = '';
    for (let i = 0; i < length; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return code;
}

/**
 * Sinh mã mời DUY NHẤT (kiểm tra trùng trong Firestore, thử lại tối đa 5 lần).
 * @returns {Promise<string>}
 */
async function generateUniqueInviteCode(length = 6, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const code = generateInviteCode(length);
        const snap = await db
            .collection('users')
            .where('inviteCode', '==', code)
            .limit(1)
            .get();
        if (snap.empty) return code;
    }
    // Rất hiếm: tăng độ dài và thử lại.
    return generateUniqueInviteCode(length + 2, 3);
}

/* ---------------- Mốc thưởng theo số lượt mời ----------------
   Mỗi mốc: đạt được khi inviteCount >= required.
   claimedMilestones lưu id các mốc đã nhận để tránh cộng trùng.
------------------------------------------------------ */
const INVITE_MILESTONES = Object.freeze([
    { id: 'm3', required: 3, coins: 200, label: 'Mời 3 bạn' },
    { id: 'm5', required: 5, coins: 300, label: 'Mời 5 bạn' },
    { id: 'm10', required: 10, coins: 500, label: 'Mời 10 bạn' },
    { id: 'm25', required: 25, coins: 1500, label: 'Mời 25 bạn' },
    { id: 'm50', required: 50, coins: 4000, label: 'Mời 50 bạn' }
]);

/* ---------------- Làm sạch dữ liệu user ----------------
   Chỉ trả về các field an toàn cho client.
------------------------------------------------------ */
function sanitizeUser(data) {
    if (!data) return null;
    return {
        uid: data.uid || null,
        email: data.email || '',
        displayName: data.displayName || 'Người dùng',
        avatar: data.avatar || '',
        bio: data.bio || '',
        createdAt: data.createdAt || null,
        lastLoginAt: data.lastLoginAt || null,
        inviteCode: data.inviteCode || '',
        invitedBy: data.invitedBy || null,
        inviteUsed: !!data.inviteUsed,
        inviteCount: Number(data.inviteCount) || 0,
        inviteRewardsTotal: Number(data.inviteRewardsTotal) || 0,
        coins: Number(data.coins) || 0,
        settings: data.settings || {},
        library: Array.isArray(data.library) ? data.library : [],
        highScores: data.highScores || {}
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
        coins: Number(data.coins) || 0
    };
}

module.exports = {
    ERROR_CODES,
    attachResponseHelpers,
    generateInviteCode,
    generateUniqueInviteCode,
    INVITE_MILESTONES,
    sanitizeUser,
    computeStats
};
