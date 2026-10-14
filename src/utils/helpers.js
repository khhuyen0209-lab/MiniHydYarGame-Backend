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
   ĐỊNH DẠNG MỚI (theo yêu cầu): tiền tố + dấu gạch ngang + phần ngẫu nhiên.
     AC-XXXXXX   = mã mời người dùng (user) — MÃ MỜI, nhập 1 lần → khóa.
     ADM-XXXXXX  = mã mời quản trị viên (admin) — MÃ MỜI, nhập 1 lần → khóa.
     HY-XXXXXX   = mã hệ thống (system) — MÃ CODE, thưởng cơ bản 250 coin,
                   không giới hạn số lần nhập (nhưng mỗi mã chỉ dùng 1 lần/user).
     PXE-/GNTU-  = mã sự kiện đặc biệt — MÃ CODE, thưởng tối thiểu 1000 coin,
                   cơ chế giống HY.
   Tương thích ngược: mã cũ không có dấu gạch ngang (vd HY_2306TL, ACXXXXXX)
   vẫn nhận diện và dùng được bình thường.
------------------------------------------------------ */
const CODE_PREFIX = Object.freeze({
    USER: 'AC',
    SYSTEM_HY: 'HY',
    SYSTEM_PXE: 'PXE',
    SYSTEM_GNTU: 'GNTU',
    ADMIN: 'ADM'
});
// Dấu phân cách giữa tiền tố và phần ngẫu nhiên.
const CODE_SEPARATOR = '-';
// MÃ CODE (quà tặng / sự kiện): nhập nhiều lần được, mỗi mã chỉ dùng 1 lần/user.
const GIFT_PREFIXES = [CODE_PREFIX.SYSTEM_HY, CODE_PREFIX.SYSTEM_PXE, CODE_PREFIX.SYSTEM_GNTU];
// MÃ MỜI (người dùng / quản trị): nhập 1 lần → khóa không nhập lại được.
const INVITE_PREFIXES = [CODE_PREFIX.ADMIN, CODE_PREFIX.USER];
// Các prefix hợp lệ cho system_codes (dùng khi admin tạo mã).
const SYSTEM_PREFIXES = [CODE_PREFIX.SYSTEM_HY, CODE_PREFIX.SYSTEM_PXE, CODE_PREFIX.SYSTEM_GNTU, CODE_PREFIX.ADMIN];
/* ---------------- Thưởng tối thiểu theo loại mã ----------------
   - HY: thưởng cơ bản 250 coin.
   - PXE / GNTU (sự kiện đặc biệt): tối thiểu 1000 coin.
   - ADM (admin): tối thiểu 900 coin. Mỗi admin có mức thưởng khác nhau;
     "thanh linh" được 950 coin — cao nhất trong các admin.
   - AC (người dùng thường): người được mời nhận tối thiểu 100 coin.
   Lưu ý: mức tối thiểu CHỈ áp dụng khi tạo mã qua API admin. Nếu admin
   chỉnh sửa trực tiếp trên Firestore, server chấp nhận nguyên giá trị
   rewardCoins trong doc (không ép lại ngưỡng) — xem invite.js.
------------------------------------------------------ */
const GIFT_CODE_DEFAULT_REWARD = Object.freeze({ HY: 250, PXE: 1000, GNTU: 1000 });
const GIFT_CODE_MIN_REWARD = Object.freeze({ HY: 250, PXE: 1000, GNTU: 1000 });
const ADMIN_CODE_MIN_REWARD = 900;
// Mức thưởng đặc biệt theo tên admin (key = tên thường / email lowercase, không dấu cách).
const ADMIN_CODE_NAMED_REWARD = Object.freeze({
    'thanhlinh': 950,
    'thanhlinh182005': 950,
    'thanhlinh182005@gmail.com': 950
});
const USER_WELCOME_MIN_REWARD = 100;
// Chuỗi ký tự hợp lệ trong mã (cho phép cả dấu gạch ngang & gạch dưới cũ).
const CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
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
    return prefix + CODE_SEPARATOR + generateRandomPart(length);
}

/**
 * Phân loại mã dựa trên tiền tố (có hoặc không có dấu gạch ngang).
 * @returns {{category:'gift'|'invite', type:'gift_hy'|'gift_pxe'|'gift_gntu'|'admin'|'user', prefix:string, subtype:string}|null}
 *  - category=gift   → MÃ CODE (HY/PXE/GNTU): không khóa, mỗi mã 1 lần/user.
 *  - category=invite → MÃ MỜI (ADM/AC): nhập 1 lần → khóa.
 */
function classifyCode(code) {
    const bare = String(code || '').trim().toUpperCase();
    if (bare.startsWith(CODE_PREFIX.SYSTEM_GNTU)) return { category: 'gift', type: 'gift_gntu', prefix: CODE_PREFIX.SYSTEM_GNTU, subtype: 'sự kiện đặc biệt' };
    if (bare.startsWith(CODE_PREFIX.SYSTEM_PXE)) return { category: 'gift', type: 'gift_pxe', prefix: CODE_PREFIX.SYSTEM_PXE, subtype: 'sự kiện đặc biệt' };
    if (bare.startsWith(CODE_PREFIX.SYSTEM_HY)) return { category: 'gift', type: 'gift_hy', prefix: CODE_PREFIX.SYSTEM_HY, subtype: 'hệ thống' };
    if (bare.startsWith(CODE_PREFIX.ADMIN)) return { category: 'invite', type: 'admin', prefix: CODE_PREFIX.ADMIN, subtype: 'quản trị viên' };
    if (bare.startsWith(CODE_PREFIX.USER)) return { category: 'invite', type: 'user', prefix: CODE_PREFIX.USER, subtype: 'người chơi' };
    return null;
}
/** Sinh các biến thể định dạng mã để chống nhầm lẫn dấu gạch ngang / gạch dưới
 *  khi admin tạo / sửa trực tiếp trên Firestore không theo đúng format.
 *  VD: "ADM2306X2" → [ADM2306X2, ADM-2306X2, ADM_2306X2, ...]
 *  Giúp nhập mã không bị "không tồn tại" chỉ do thiếu / thừa dấu gạch ngang. */
function codeVariants(code) {
    const bare = String(code || '').trim().toUpperCase();
    if (!bare) return [];
    const set = new Set([bare]);
    const compact = bare.replace(/[-_]/g, '');
    set.add(compact);
    // Tách prefix (2–4 chữ cái đầu) rồi chèn lại cả '-' và '_'.
    const m = compact.match(/^([A-Z]{2,4})([A-Z0-9]+)$/);
    if (m) {
        const pfx = m[1], rest = m[2];
        set.add(pfx + '-' + rest);
        set.add(pfx + '_' + rest);
    }
    // Thay thế trực tiếp dấu - ↔ _
    set.add(bare.replace(/-/g, '_'));
    set.add(bare.replace(/_/g, '-'));
    return Array.from(set);
}
/** Mức thưởng đề xuất cho mã admin theo tên (vd "thanh linh" → 950, cao nhất). */
function adminCodeRewardFor(nameOrEmail) {
    const key = String(nameOrEmail || '').toLowerCase().replace(/[^a-z0-9@.]/g, '');
    if (ADMIN_CODE_NAMED_REWARD[key]) return ADMIN_CODE_NAMED_REWARD[key];
    return ADMIN_CODE_MIN_REWARD;
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
    WELCOME: Number(process.env.INVITE_WELCOME_COINS) || USER_WELCOME_MIN_REWARD,
    DIRECT: Number(process.env.INVITE_REWARD_COINS) || 100,
    SECOND_LEVEL: Number(process.env.REFERRAL_SECOND_LEVEL_COINS) || 20
});
/* ---------------- Kho vật phẩm (Inventory) ----------------
   Mặc định mọi người chơi đều có "Thẻ người chơi" — giấy tờ tùy thân số hóa
   (CCCD) của người chơi trong hệ thống. Không thể bỏ / tiêu hủy.
------------------------------------------------------ */
const DEFAULT_INVENTORY_ITEM_ID = 'encrypted-id-card';
function buildDefaultInventory(now) {
    return [{
        id: DEFAULT_INVENTORY_ITEM_ID,
        name: 'Thẻ người chơi',
        kind: 'id-card',
        rarity: 'legendary',
        permanent: true,
        desc: 'CCCD số hóa của người chơi. Định danh duy nhất trong hệ thống MiniGame HY.',
        obtainedAt: now || null,
        count: 1
    }];
}

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
        inventory: Array.isArray(data.inventory) ? data.inventory : [],
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
    CODE_SEPARATOR,
    SYSTEM_PREFIXES,
    GIFT_PREFIXES,
    INVITE_PREFIXES,
    GIFT_CODE_DEFAULT_REWARD,
    GIFT_CODE_MIN_REWARD,
    ADMIN_CODE_MIN_REWARD,
    ADMIN_CODE_NAMED_REWARD,
    USER_WELCOME_MIN_REWARD,
    CODE_REGEX,
    CODE_RANDOM_LENGTH,
    generateInviteCode,
    generateUniqueInviteCode,
    classifyCode,
    codeVariants,
    adminCodeRewardFor,
    getAdminEmails,
    isAdminEmail,
    getAdminPanelKey,
    REFERRAL_REWARDS,
    INVITE_MILESTONES,
    DEFAULT_INVENTORY_ITEM_ID,
    buildDefaultInventory,
    sanitizeUser,
    computeStats
};
