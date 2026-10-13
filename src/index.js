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
const { APP_HOST, API_PREFIX, API_BASE_URL } = require('./config/app');
const userRoutes = require('./routes/user');
const inviteRoutes = require('./routes/invite');
const feedbackRoutes = require('./routes/feedback');
const adminRoutes = require('./routes/admin');
const { router: rankingsRouter } = require('./routes/rankings');

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------------- Middleware toàn cục ---------------- */
app.set('trust proxy', 1); // cần thiết cho rate-limit khi đứng sau proxy/Load Balancer
app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || '*').split(','),
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret', 'x-admin-panel-key']
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
    return res.ok({
        status: 'ok',
        uptime: process.uptime(),
        host: APP_HOST,
        apiBaseUrl: API_BASE_URL
    }, 'Server đang chạy.');
});

/* ---------------- Routes ---------------- */
app.use(`${API_PREFIX}/user`, userRoutes);
app.use(`${API_PREFIX}/invite`, inviteRoutes);
app.use(`${API_PREFIX}/feedback`, feedbackRoutes);
app.use(`${API_PREFIX}/admin`, adminRoutes);
app.use(API_PREFIX, rankingsRouter); // /rankings/* + /presence/*

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
    console.log(`✅ MiniGame HY Backend đang chạy.`);
    console.log(`   Local : http://localhost:${PORT}`);
    console.log(`   Public: ${APP_HOST}`);
    console.log(`   API   : ${API_BASE_URL}`);
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

/* Seed mã hệ thống mặc định HY_2306TL (idempotent — chỉ tạo nếu chưa có).
   Mã này cho phép MỌI người dùng nhập, KHÔNG khóa việc nhập mã mời người khác. */
async function seedSystemCodes() {
    try {
        const { db, Timestamp } = require('./config/firebase');
        const ref = db.collection('system_codes').doc('HY_2306TL');
        const snap = await ref.get();
        if (!snap.exists) {
            await ref.set({
                code: 'HY_2306TL',
                prefix: 'HY',
                rewardCoins: Number(process.env.SEED_HY2306TL_COINS) || 500,
                maxUses: 999999,
                uses: 0,
                active: true,
                note: 'Mã hệ thống giới thiệu — mọi người đều nhập được, không khóa mã mời.',
                createdAt: Timestamp.now(),
                createdBy: 'seed'
            });
            console.log('✅ Đã seed mã hệ thống HY_2306TL (+500 coin, không khóa).');
        }
    } catch (err) {
        console.warn('[Seed] Không seed được mã hệ thống:', err && err.message);
    }
}
seedSystemCodes();

module.exports = app;
