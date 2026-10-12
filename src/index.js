/* ============================================================
   src/index.js — Entry point
   Khởi động Express server, gắn middleware toàn cục, mount routes,
   xử lý lỗi tập trung (luôn trả về định dạng response thống nhất).
   ============================================================ */
'use strict';

// Load biến môi trường TRƯỚC khi import module khác.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { attachResponseHelpers, ERROR_CODES } = require('./utils/helpers');
const { apiLimiter } = require('./middleware/limiter');
const userRoutes = require('./routes/user');
const inviteRoutes = require('./routes/invite');

const app = express();
const PORT = process.env.PORT || 8080;
const API_PREFIX = '/api/v1';

/* ---------------- Middleware toàn cục ---------------- */
app.set('trust proxy', 1); // cần thiết cho rate-limit khi đứng sau proxy/Load Balancer
app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || '*').split(','),
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' })); // chặn body quá lớn (avatar dataURL)
if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
}

// Gắn res.ok() / res.fail() cho mọi response.
app.use(attachResponseHelpers);

// Giới hạn tốc độ chung cho toàn bộ API.
app.use(API_PREFIX, apiLimiter);

/* ---------------- Health check ---------------- */
app.get(`${API_PREFIX}/health`, (req, res) => {
    return res.ok({ status: 'ok', uptime: process.uptime() }, 'Server đang chạy.');
});

/* ---------------- Routes ---------------- */
app.use(`${API_PREFIX}/user`, userRoutes);
app.use(`${API_PREFIX}/invite`, inviteRoutes);

/* ---------------- 404 ---------------- */
app.use((req, res) => {
    return res.fail(
        `Không tìm thấy endpoint ${req.method} ${req.originalUrl}.`,
        'NOT_FOUND',
        404
    );
});

/* ---------------- Xử lý lỗi tập trung ----------------
   Mọi lỗi không bắt được đều rơi vào đây → trả về định dạng thống nhất,
   KHÔNG bao giờ lộ stack trace ra client.
------------------------------------------------------ */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    if (res.headersSent) return next(err);

    // Lỗi parse JSON body.
    if (err.type === 'entity.parse.failed') {
        return res.fail(
            'Body không phải JSON hợp lệ.',
            ERROR_CODES.VALIDATION_ERROR,
            400
        );
    }
    // Body quá lớn.
    if (err.status === 413) {
        return res.fail(
            'Dữ liệu gửi lên quá lớn (tối đa 1MB).',
            ERROR_CODES.VALIDATION_ERROR,
            413
        );
    }

    return res.fail(
        'Lỗi máy chủ nội bộ. Vui lòng thử lại sau.',
        ERROR_CODES.SERVER_ERROR,
        500
    );
});

/* ---------------- Khởi động ---------------- */
const server = app.listen(PORT, () => {
    console.log(`✅ MiniGame HY Backend đang chạy tại http://localhost:${PORT}`);
    console.log(`✅ API prefix: ${API_PREFIX}`);
});

// Tắt mềm: đóng kết nối DB khi nhận tín hiệu shutdown.
function gracefulShutdown(signal) {
    console.log(`\nNhận ${signal} — đang tắt server...`);
    server.close(() => {
        console.log('Đã đóng kết nối HTTP.');
        process.exit(0);
    });
    // Ép tắt sau 10s nếu chưa đóng được.
    setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
