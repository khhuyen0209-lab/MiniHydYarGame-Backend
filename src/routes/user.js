/* ============================================================
   src/routes/user.js — /api/v1/user
   POST   /init      Tạo tài khoản user lần đầu sau khi đăng nhập
   GET    /profile   Lấy thông tin cá nhân
   PATCH  /profile   Cập nhật thông tin cơ bản
   GET    /stats     Lấy số liệu: tổng game, điểm cao, số mời…
   ============================================================ */
'use strict';

const express = require('express');
const { db, FieldValue, Timestamp } = require('../config/firebase');
const { verifyToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/limiter');
const {
    ERROR_CODES,
    generateUniqueInviteCode,
    sanitizeUser,
    computeStats
} = require('../utils/helpers');

const router = express.Router();

// ✅ Mọi route trong này đều phải qua verifyToken.
router.use(verifyToken);

const USERS = () => db.collection('users');

/* ------------------------------------------------------------
   POST /init — Idempotent. Gọi sau khi client đăng nhập thành công.
   - Chưa có doc → tạo mới với đầy đủ field mặc định + sinh mã mời.
   - Đã có doc → chỉ cập nhật lastLoginAt (không ghi đè dữ liệu chơi).
   Body (tùy chọn): { displayName } — ưu tiên hơn tên từ Google.
------------------------------------------------------------ */
router.post('/init', strictLimiter, async (req, res, next) => {
    try {
        const { uid, email, name, picture } = req.user;
        const userRef = USERS().doc(uid);
        const snap = await userRef.get();
        const now = Timestamp.now();

        if (snap.exists) {
            // Đã có tài khoản → cập nhật lastLoginAt, không đụng tới dữ liệu game.
            await userRef.update({ lastLoginAt: now });
            const updated = (await userRef.get()).data();
            return res.ok(
                { user: sanitizeUser(updated), isNew: false },
                'Đã đồng bộ tài khoản.'
            );
        }

        // Tạo mới: sinh mã mời duy nhất trước.
        const inviteCode = await generateUniqueInviteCode(6);
        const displayName =
            (req.body && typeof req.body.displayName === 'string' &&
                req.body.displayName.trim()) ||
            name ||
            'Người chơi';

        const newUser = {
            uid,
            email,
            displayName: String(displayName).slice(0, 40),
            avatar: picture || '',
            bio: '',
            createdAt: now,
            lastLoginAt: now,

            inviteCode,
            invitedBy: null,
            inviteUsed: false,
            inviteCount: 0,
            inviteRewardsTotal: 0,
            inviteHistory: [],
            claimedMilestones: [],

            coins: 0,
            settings: {},
            library: [],
            highScores: {}
        };

        await userRef.set(newUser);
        return res.ok(
            { user: sanitizeUser(newUser), isNew: true },
            'Tạo tài khoản thành công.',
            201
        );
    } catch (err) {
        return next(err);
    }
});

/* ------------------------------------------------------------
   GET /profile — Trả về hồ sơ đã làm sạch.
------------------------------------------------------------ */
router.get('/profile', async (req, res, next) => {
    try {
        const snap = await USERS().doc(req.user.uid).get();
        if (!snap.exists) {
            return res.fail(
                'Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.',
                ERROR_CODES.USER_NOT_INITIALIZED,
                404
            );
        }
        return res.ok({ user: sanitizeUser(snap.data()) }, 'Lấy hồ sơ thành công.');
    } catch (err) {
        return next(err);
    }
});

/* ------------------------------------------------------------
   PATCH /profile — Chỉ cho phép cập nhật field TRẮNG DANH.
   Tuyệt đối không cho client sửa coins / invite* / uid / email.
   Body: { displayName?, avatar?, bio? }
------------------------------------------------------------ */
const ALLOWED_PROFILE_FIELDS = {
    displayName: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 40,
    avatar: (v) => typeof v === 'string' && v.length <= 500 * 1024, // ~500KB (dataURL)
    bio: (v) => typeof v === 'string' && v.length <= 200
};

router.patch('/profile', async (req, res, next) => {
    try {
        const body = req.body || {};
        const updates = {};

        for (const [field, validator] of Object.entries(ALLOWED_PROFILE_FIELDS)) {
            if (field in body) {
                const value = body[field];
                if (!validator(value)) {
                    return res.fail(
                        `Trường "${field}" không hợp lệ.`,
                        ERROR_CODES.VALIDATION_ERROR,
                        400
                    );
                }
                updates[field] = field === 'displayName' ? value.trim() : value;
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.fail(
                'Không có trường hợp lệ để cập nhật. Cho phép: displayName, avatar, bio.',
                ERROR_CODES.VALIDATION_ERROR,
                400
            );
        }

        const userRef = USERS().doc(req.user.uid);
        const snap = await userRef.get();
        if (!snap.exists) {
            return res.fail(
                'Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.',
                ERROR_CODES.USER_NOT_INITIALIZED,
                404
            );
        }

        updates.lastLoginAt = FieldValue.serverTimestamp();
        await userRef.update(updates);

        const updated = (await userRef.get()).data();
        return res.ok({ user: sanitizeUser(updated) }, 'Cập nhật hồ sơ thành công.');
    } catch (err) {
        return next(err);
    }
});

/* ------------------------------------------------------------
   GET /stats — Số liệu tổng hợp.
------------------------------------------------------------ */
router.get('/stats', async (req, res, next) => {
    try {
        const snap = await USERS().doc(req.user.uid).get();
        if (!snap.exists) {
            return res.fail(
                'Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.',
                ERROR_CODES.USER_NOT_INITIALIZED,
                404
            );
        }
        return res.ok({ stats: computeStats(snap.data()) }, 'Lấy số liệu thành công.');
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
