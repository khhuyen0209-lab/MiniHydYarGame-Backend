/* ============================================================
   src/routes/feedback.js — /api/v1/feedback
   POST /  Gửi báo lỗi / góp ý (cần đăng nhập).
   ✅ Thay thế cho việc client ghi trực tiếp collection "feedback".
   ============================================================ */
'use strict';
const express = require('express');
const { db, FieldValue, Timestamp } = require('../config/firebase');
const { verifyToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/limiter');
const { ERROR_CODES } = require('../utils/helpers');

const router = express.Router();
const FEEDBACK = () => db.collection('feedback');
const ALLOWED_TYPES = ['loi', 'gop-y', 'de-xuat'];

router.post('/', verifyToken, strictLimiter, async (req, res, next) => {
    try {
        const { uid, email } = req.user;
        const body = req.body || {};
        const type = ALLOWED_TYPES.includes(body.type) ? body.type : 'gop-y';
        const message = String(body.message || '').trim();
        if (!message || message.length > 5000) {
            return res.fail(
                'Nội dung phản hồi không hợp lệ (1–5000 ký tự).',
                ERROR_CODES.VALIDATION_ERROR, 400
            );
        }
        const appVersion = String(body.appVersion || '').slice(0, 50);
        const ua = String(body.ua || '').slice(0, 500);
        const docRef = FEEDBACK().doc();
        await docRef.set({
            uid, email: email || '',
            type, message,
            appVersion, ua,
            createdAt: Timestamp.now(),
            status: 'new'
        });
        return res.ok({ id: docRef.id }, 'Đã gửi phản hồi. Cảm ơn bạn!', 201);
    } catch (err) { return next(err); }
});

module.exports = router;
