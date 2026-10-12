/* ============================================================
   src/config/app.js — Cấu hình ứng dụng tập trung
   ------------------------------------------------------------
   HOST CÔNG KHAI (động, đổi được sau này KHÔNG cần sửa code):
     - Đặt biến môi trường APP_HOST (vd trên Render: Environment
       Variables) thành domain mới là xong.
     - Nếu không set, mặc định dùng Render URL hiện tại.
   ============================================================ */
'use strict';

/**
 * Chuẩn hóa host: bỏ khoảng trắng thừa & dấu `/` cuối chuỗi.
 * @param {string} host
 * @returns {string}
 */
function normalizeHost(host) {
    if (!host) return '';
    return String(host).trim().replace(/\/+$/, '');
}

// Host công khai của backend. Mặc định = URL Render hiện tại.
// Sau này đổi host chỉ cần set env APP_HOST, KHÔNG cần đụng code.
const APP_HOST =
    normalizeHost(process.env.APP_HOST) ||
    'https://minihydyargame-backend.onrender.com';

// Prefix API (cho phép tùy chỉnh qua env nếu cần).
const API_PREFIX = process.env.API_PREFIX || '/api/v1';

// URL gốc đầy đủ của API — dùng cho log, health check, link chia sẻ…
const API_BASE_URL = `${APP_HOST}${API_PREFIX}`;

module.exports = {
    APP_HOST,
    API_PREFIX,
    API_BASE_URL,
    normalizeHost
};
