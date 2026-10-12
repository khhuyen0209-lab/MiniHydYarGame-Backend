/* ============================================================
   src/middleware/auth.js
   verifyToken  — BẮT BUỘC cho mọi route cần xác thực.
                  Lấy uid TỪ TOKEN (bỏ qua hoàn toàn uid client gửi).
   optionalAuth — Không chặn nếu thiếu token (dùng cho route công khai).
   ============================================================ */
'use strict';

const { auth } = require('../config/firebase');
const { ERROR_CODES } = require('../utils/helpers');

/**
 * Header: Authorization: Bearer <idToken>
 * idToken được client lấy từ Firebase Auth: await user.getIdToken()
 */
async function verifyToken(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        if (!header.startsWith('Bearer ')) {
            return res.fail(
                'Thiếu token xác thực. Gửi header: Authorization: Bearer <idToken>',
                ERROR_CODES.AUTH_REQUIRED,
                401
            );
        }

        const idToken = header.slice('Bearer '.length).trim();
        if (!idToken) {
            return res.fail('Token rỗng.', ERROR_CODES.AUTH_REQUIRED, 401);
        }

        const decoded = await auth.verifyIdToken(idToken, true); // checkRevoked = true

        // ✅ Server luôn lấy uid từ token, KHÔNG tin tưởng uid từ body/query.
        req.user = {
            uid: decoded.uid,
            email: decoded.email || '',
            name: decoded.name || '',
            picture: decoded.picture || ''
        };

        return next();
    } catch (err) {
        // Token hết hạn / sai / bị thu hồi → 401, client cần refresh idToken.
        return res.fail(
            'Token không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
            ERROR_CODES.AUTH_INVALID,
            401
        );
    }
}

/**
 * Xác thực tùy chọn: nếu có token hợp lệ thì gắn req.user, không có thì tiếp tục.
 */
async function optionalAuth(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        if (header.startsWith('Bearer ')) {
            const idToken = header.slice('Bearer '.length).trim();
            const decoded = await auth.verifyIdToken(idToken, true);
            req.user = {
                uid: decoded.uid,
                email: decoded.email || '',
                name: decoded.name || '',
                picture: decoded.picture || ''
            };
        }
    } catch (_) {
        // Token không hợp lệ nhưng route không yêu cầu → bỏ qua.
        req.user = null;
    }
    return next();
}

module.exports = { verifyToken, optionalAuth };
