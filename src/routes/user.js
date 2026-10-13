/* ============================================================
   src/routes/user.js — /api/v1/user
   POST   /init      Tạo tài khoản user lần đầu (idempotent) + sinh mã mời HY
   GET    /profile   Lấy thông tin cá nhân
   PATCH  /profile   Cập nhật thông tin cơ bản (whitelist field)
   GET    /stats     Số liệu tổng hợp
   GET    /sync      Kéo dữ liệu đồng bộ (profile/settings/library/progress)
   POST   /sync      Đẩy dữ liệu đồng bộ lên (merge sâu, không ghi đè field khác)
   ============================================================
   ✅ Mọi thay đổi Firestore của user đều đi qua API này — client KHÔNG
      được phép ghi trực tiếp (firestore.rules đã khóa toàn bộ client).
   ============================================================ */
'use strict';
const express = require('express');
const { db, FieldValue, Timestamp } = require('../config/firebase');
const { verifyToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/limiter');
const {
    ERROR_CODES,
    CODE_PREFIX,
    generateUniqueInviteCode,
    isAdminEmail,
    sanitizeUser,
    computeStats
} = require('../utils/helpers');

const router = express.Router();
router.use(verifyToken);
const USERS = () => db.collection('users');

/* ------------------------------------------------------------
   POST /init — Idempotent.
------------------------------------------------------------ */
router.post('/init', strictLimiter, async (req, res, next) => {
    try {
        const { uid, email, name, picture } = req.user;
        const userRef = USERS().doc(uid);
        const snap = await userRef.get();
        const now = Timestamp.now();
        const admin = isAdminEmail(email);
        if (snap.exists) {
            const data = snap.data();
            // Idempotent: nâng cấp role admin nếu email thuộc whitelist mà role chưa phải admin.
            // Role CHỈ server set ở đây — client không thể ghi đè (PATCH /profile whitelist không có role).
            const updates = { lastLoginAt: now };
            if (admin && data.role !== 'admin') {
                updates.role = 'admin';
                updates.inviteBypass = true; // admin không bị xét duyệt / giới hạn mã mời
            }
            await userRef.update(updates);
            const updated = (await userRef.get()).data();
            return res.ok({ user: sanitizeUser(updated), isNew: false }, 'Đã đồng bộ tài khoản.');
        }
        const inviteCode = await generateUniqueInviteCode(CODE_PREFIX.USER);
        const displayName =
            (req.body && typeof req.body.displayName === 'string' && req.body.displayName.trim()) ||
            name || 'Người chơi';
        const newUser = {
            uid, email,
            displayName: String(displayName).slice(0, 40),
            avatar: picture || '',
            bio: '',
            role: admin ? 'admin' : 'user',
            inviteBypass: admin ? true : false,
            createdAt: now, lastLoginAt: now,
            inviteCode,
            invitedBy: null, inviteUsed: false,
            inviteCount: 0, inviteRewardsTotal: 0,
            inviteHistory: [], claimedMilestones: [],
            usedSystemCodes: [], rewardsHistory: [],
            coins: 0,
            settings: {}, library: [], highScores: {}, progress: {}
        };
        await userRef.set(newUser);
        return res.ok({ user: sanitizeUser(newUser), isNew: true }, 'Tạo tài khoản thành công.', 201);
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   GET /profile
------------------------------------------------------------ */
router.get('/profile', async (req, res, next) => {
    try {
        const snap = await USERS().doc(req.user.uid).get();
        if (!snap.exists) return res.fail('Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        return res.ok({ user: sanitizeUser(snap.data()) }, 'Lấy hồ sơ thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   PATCH /profile — whitelist field.
------------------------------------------------------------ */
const ALLOWED_PROFILE_FIELDS = {
    displayName: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 40,
    avatar: (v) => typeof v === 'string' && v.length <= 500 * 1024,
    bio: (v) => typeof v === 'string' && v.length <= 200
};
router.patch('/profile', async (req, res, next) => {
    try {
        const body = req.body || {};
        const updates = {};
        for (const [field, validator] of Object.entries(ALLOWED_PROFILE_FIELDS)) {
            if (field in body) {
                const value = body[field];
                if (!validator(value)) return res.fail(`Trường "${field}" không hợp lệ.`, ERROR_CODES.VALIDATION_ERROR, 400);
                updates[field] = field === 'displayName' ? value.trim() : value;
            }
        }
        if (Object.keys(updates).length === 0) {
            return res.fail('Không có trường hợp lệ để cập nhật. Cho phép: displayName, avatar, bio.', ERROR_CODES.VALIDATION_ERROR, 400);
        }
        const userRef = USERS().doc(req.user.uid);
        const snap = await userRef.get();
        if (!snap.exists) return res.fail('Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        updates.lastLoginAt = FieldValue.serverTimestamp();
        await userRef.update(updates);
        const updated = (await userRef.get()).data();
        return res.ok({ user: sanitizeUser(updated) }, 'Cập nhật hồ sơ thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   GET /stats
------------------------------------------------------------ */
router.get('/stats', async (req, res, next) => {
    try {
        const snap = await USERS().doc(req.user.uid).get();
        if (!snap.exists) return res.fail('Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        return res.ok({ stats: computeStats(snap.data()) }, 'Lấy số liệu thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   GET /sync — Kéo toàn bộ dữ liệu đồng bộ về client.
   (Trả về user đã sanitize — đủ cho client merge local.)
------------------------------------------------------------ */
router.get('/sync', async (req, res, next) => {
    try {
        const snap = await USERS().doc(req.user.uid).get();
        if (!snap.exists) return res.fail('Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        const data = snap.data();
        return res.ok({
            profile: {
                displayName: data.displayName || '',
                bio: data.bio || '',
                avatar: data.avatar || '',
                email: data.email || ''
            },
            settings: data.settings || {},
            library: Array.isArray(data.library) ? data.library : [],
            progress: data.progress || {},
            highScores: data.highScores || {},
            coins: Number(data.coins) || 0,
            inviteCode: data.inviteCode || '',
            inviteUsed: !!data.inviteUsed,
            invitedBy: data.invitedBy || null,
            inviteCount: Number(data.inviteCount) || 0,
            updatedAt: data.updatedAt || data.lastLoginAt || null
        }, 'Lấy dữ liệu đồng bộ thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   POST /sync — Đẩy dữ liệu đồng bộ lên (merge sâu).
   Body: { profile?: {displayName,bio,avatar}, settings?: {}, library?: [], progress?: {} }
   Server merge (không ghi đè field khác) → trả về full data sau merge.
------------------------------------------------------------ */
router.post('/sync', async (req, res, next) => {
    try {
        const body = req.body || {};
        const userRef = USERS().doc(req.user.uid);
        const snap = await userRef.get();
        if (!snap.exists) return res.fail('Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.', ERROR_CODES.USER_NOT_INITIALIZED, 404);

        const updates = {};
        // Profile: chỉ cho phép 3 field (giới hạn độ dài).
        if (body.profile && typeof body.profile === 'object') {
            const p = body.profile;
            const profileUp = {};
            if (typeof p.displayName === 'string' && p.displayName.trim() && p.displayName.length <= 40) profileUp.displayName = p.displayName.trim();
            if (typeof p.bio === 'string' && p.bio.length <= 200) profileUp.bio = p.bio;
            if (typeof p.avatar === 'string' && p.avatar.length <= 500 * 1024) profileUp.avatar = p.avatar;
            Object.assign(updates, profileUp);
        }
        // Settings: object (giới hạn kích thước bằng JSON length).
        if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
            const s = JSON.stringify(body.settings);
            if (s.length <= 20 * 1024) updates.settings = body.settings;
        }
        // Library: mảng id game (giới hạn 200 phần tử, mỗi phần tử string <= 64).
        if (Array.isArray(body.library)) {
            const lib = body.library.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, 200);
            updates.library = lib;
        }
        // Progress: map key→value (giới hạn 100 key, key prefix mghy-).
        if (body.progress && typeof body.progress === 'object' && !Array.isArray(body.progress)) {
            const existing = snap.data().progress || {};
            const merged = Object.assign({}, existing);
            let count = 0;
            for (const [k, v] of Object.entries(body.progress)) {
                if (count >= 100) break;
                if (typeof k === 'string' && k.startsWith('mghy-') && k.length <= 64) {
                    merged[k] = v;
                    count++;
                }
            }
            updates.progress = merged;
            // Đồng bộ highScores từ các key điểm cao (nếu client gửi số).
            const hs = snap.data().highScores || {};
            const HS_MAP = {
                'mghy-ns-highscore': 'neon-shooter',
                'mghy-bp-highscore': 'block-puzzle',
                'mghy-cj-highscore': 'cloud-jump',
                'mghy-memory-best': 'memory-game',
                'mghy-guessnumber-best': 'guess-number'
            };
            let hsChanged = false;
            for (const [k, gameId] of Object.entries(HS_MAP)) {
                const val = Number(body.progress[k]);
                if (!Number.isNaN(val) && val > (Number(hs[gameId]) || 0)) {
                    hs[gameId] = val;
                    hsChanged = true;
                }
            }
            if (hsChanged) updates.highScores = hs;
        }

        updates.updatedAt = FieldValue.serverTimestamp();
        await userRef.update(updates);
        const after = (await userRef.get()).data();
        return res.ok({ user: sanitizeUser(after) }, 'Đồng bộ thành công.');
    } catch (err) { return next(err); }
});

module.exports = router;
