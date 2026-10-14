/* ============================================================
   src/middleware/auth.js
   verifyToken   — BẮT BUỘC cho mọi route cần xác thực.
                   Lấy uid TỪ TOKEN (bỏ qua hoàn toàn uid client gửi).
                   Sau khi verify → ghi nhận presence (online trên RAM).
   optionalAuth  — Không chặn nếu thiếu token (route công khai).
   requireAdmin  — Chống giả mạo: (token hợp lệ + email trong
                   ADMIN_EMAILS + users.doc(uid).role === 'admin')
                   HOẶC header x-admin-secret khớp. Role CHỈ server
                   mới set được → client không thể tự phong admin.
   ============================================================ */
'use strict';
const { auth, db } = require('../config/firebase');
const { ERROR_CODES, isAdminEmail } = require('../utils/helpers');
const presence = require('../utils/presence');
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
        // ✅ Ghi nhận online (RAM): login tự động → gọi server → vào list.
        try { presence.track(req.user, { isAdmin: isAdminEmail(req.user.email) }); } catch (_) {}
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
 * Xác thực tùy chọn: nếu có token hợp lệ thì gắn req.user + presence,
 * không có thì tiếp tục.
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
            try { presence.track(req.user, { isAdmin: isAdminEmail(req.user.email) }); } catch (_) {}
        }
    } catch (_) {
        req.user = null;
    }
    return next();
}
/**
 * Middleware admin — CHỐNG GIẢ MẠO.
 * Điều kiện đủ (theo thứ tự):
 *   1. Header x-admin-secret khớp ADMIN_SECRET (fallback cho script).
 *   2. HOẶC: token hợp lệ + email (từ token, đã verify) thuộc
 *      ADMIN_EMAILS + users.doc(uid).role === 'admin' trong Firestore.
 * Role 'admin' CHỈ được server ghi (xem user.js /init) → client không
 * thể tự set bằng request. Hai lớp (email whitelist + DB role) phải
 * đồng thời thỏa mãn, không thể bị giả mạo qua body/query.
 */
async function requireAdmin(req, res, next) {
    // Lớp 1: admin secret (dành cho script / curl).
    const secret = process.env.ADMIN_SECRET || '';
    const provided = req.headers['x-admin-secret'] || (req.body && req.body.adminSecret) || '';
    if (secret && provided && provided === secret) {
        req.adminVia = 'secret';
        return next();
    }
    // Lớp 2: token + email whitelist + DB role.
    if (!req.user || !req.user.uid) {
        return res.fail('Thiếu phiên đăng nhập.', ERROR_CODES.AUTH_REQUIRED, 401);
    }
    if (!isAdminEmail(req.user.email)) {
        return res.fail('Tài khoản này không có quyền quản trị viên.', ERROR_CODES.ADMIN_REQUIRED, 403);
    }
    try {
        const snap = await db.collection('users').doc(req.user.uid).get();
        if (!snap.exists || snap.data().role !== 'admin') {
            return res.fail('Tài khoản chưa được cấp quyền admin trên hệ thống.', ERROR_CODES.ADMIN_REQUIRED, 403);
        }
        req.adminVia = 'role';
        return next();
    } catch (err) {
        console.error('[requireAdmin] DB check failed:', err);
        return res.fail('Lỗi kiểm tra quyền admin.', ERROR_CODES.SERVER_ERROR, 500);
    }
}
module.exports = { verifyToken, optionalAuth, requireAdmin };
