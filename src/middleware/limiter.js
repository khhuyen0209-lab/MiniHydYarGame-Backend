/* ============================================================
   src/middleware/limiter.js
   Chống spam / brute-force bằng express-rate-limit.
   - apiLimiter    : giới hạn chung toàn bộ API.
   - strictLimiter : siết chặt cho các route nhạy cảm (nhập mã mời, init).
   ============================================================ */
'use strict';

const rateLimit = require('express-rate-limit');
const { ERROR_CODES } = require('../utils/helpers');

// Trả về định dạng lỗi THUẬN NHẤT khi bị giới hạn.
function _rateLimitHandler(req, res) {
    return res.fail(
        'Quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.',
        ERROR_CODES.RATE_LIMITED,
        429
    );
}

// Toàn bộ API: 200 req / 15 phút / IP.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    handler: _rateLimitHandler,
    message: {} // không dùng, handler tự trả về JSON thống nhất
});

// Route nhạy cảm: 10 req / 1 giờ / IP (chống dò mã mời, spam tài khoản).
const strictLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: _rateLimitHandler,
    message: {}
});

module.exports = { apiLimiter, strictLimiter };
