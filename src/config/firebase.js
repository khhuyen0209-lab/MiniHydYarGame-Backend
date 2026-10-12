/* ============================================================
   src/config/firebase.js
   Khởi tạo Firebase Admin SDK (singleton — chỉ khởi tạo 1 lần).

   Hỗ trợ 2 cách cung cấp Service Account JSON (chọn 1):
   ─────────────────────────────────────────────────────────
   CÁCH 1 (khuyến nghị cho Render / các platform env):
     Đặt TỪNG TRƯỜNG của file serviceAccountKey.json thành env var
     với tiền tố FIREBASE_ (đúng tên key trong JSON).
     Ví dụ:
       FIREBASE_TYPE=service_account
       FIREBASE_PROJECT_ID=minigame-hy
       FIREBASE_PRIVATE_KEY_ID=de98d...
       FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
       FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@minigame-hy.iam.gserviceaccount.com
       FIREBASE_CLIENT_ID=1081...
       FIREBASE_AUTH_URI=https://accounts.google.com/o/oauth2/auth
       FIREBASE_TOKEN_URI=https://oauth2.googleapis.com/token
       FIREBASE_AUTH_PROVIDER_X509_CERT_URL=https://www.googleapis.com/oauth2/v1/certs
       FIREBASE_CLIENT_X509_CERT_URL=https://www.googleapis.com/robot/v1/metadata/x509/...
       FIREBASE_UNIVERSE_DOMAIN=googleapis.com
     → private_key có thể dán THẲNG (kể cả chứa \n), code tự xử lý.

   CÁCH 2 (nhanh, 1 biến duy nhất):
     FIREBASE_SERVICE_ACCOUNT = toàn bộ nội dung file JSON
     (hoặc base64 của file JSON — code tự nhận diện).
   ============================================================ */
'use strict';

const admin = require('firebase-admin');

/**
 * Tự động sửa private_key: thay \\n (dạng chuỗi) thành xuống dòng thật.
 * Dùng được cả khi dán thẳng từ file JSON vào ô env trên Render.
 */
function _normalizePrivateKey(key) {
    if (!key) return null;
    return String(key).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
}

/**
 * Đọc Service Account từ env. Ưu tiên CÁCH 2 (1 biến) nếu có.
 */
function _loadServiceAccount() {
    // --- CÁCH 2: toàn bộ JSON trong 1 biến FIREBASE_SERVICE_ACCOUNT ---
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        let raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
        // Nếu không bắt đầu bằng '{' → coi là base64, tự decode.
        if (!raw.startsWith('{')) {
            raw = Buffer.from(raw, 'base64').toString('utf8');
        }
        const sa = JSON.parse(raw);
        if (sa.private_key) sa.private_key = _normalizePrivateKey(sa.private_key);
        return sa;
    }

    // --- CÁCH 1: từng trường riêng lẻ (đúng tên key trong file JSON) ---
    const sa = {
        type: process.env.FIREBASE_TYPE || 'service_account',
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || '',
        private_key: _normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID || '',
        auth_uri: process.env.FIREBASE_AUTH_URI || 'https://accounts.google.com/o/oauth2/auth',
        token_uri: process.env.FIREBASE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url:
            process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL ||
            'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL || '',
        universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN || 'googleapis.com'
    };

    // Giữ tương thích ngược: nếu không có FIREBASE_PRIVATE_KEY mà có FIREBASE_PRIVATE_KEY_BASE64
    if (!sa.private_key && process.env.FIREBASE_PRIVATE_KEY_BASE64) {
        sa.private_key = Buffer.from(
            process.env.FIREBASE_PRIVATE_KEY_BASE64,
            'base64'
        ).toString('utf8');
    }

    return sa;
}

function initFirebase() {
    if (admin.apps.length > 0) {
        return admin.apps[0];
    }

    const sa = _loadServiceAccount();

    if (!sa.project_id || !sa.client_email || !sa.private_key) {
        throw new Error(
            '[Firebase] Thiếu cấu hình Service Account. Cần ít nhất: ' +
            'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY ' +
            '(hoặc biến FIREBASE_SERVICE_ACCOUNT chứa toàn bộ JSON). Xem .env.example.'
        );
    }

    return admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: sa.project_id
    });
}

const app = initFirebase();

module.exports = {
    admin,
    app,
    db: admin.firestore(),
    auth: admin.auth(),
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp
};
