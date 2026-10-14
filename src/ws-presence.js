/* ============================================================
   src/ws-presence.js — WebSocket broadcast danh sách online (realtime)
   ------------------------------------------------------------
   - Gắn vào HTTP server cùng port (path /ws). Client (rankings tab
     "Trực tuyến") kết nối để nhận cập nhật realtime thay vì poll 5s.
   - LAZY-REQUIRE `ws`: nếu môi trường chưa `npm install ws` → module
     tự vô hiệu hóa (return false), frontend tự fallback về polling.
     Khi deploy chạy `npm install` (ws có trong package.json) là hoạt động.
   - Bảo vệ:
     * Tối đa MAX_CLIENTS kết nối đồng thời, tối đa MAX_PER_IP / IP.
     * Broadcast bị throttle (BROADCAST_INTERVAL_MS) — không spam client.
     * Server ping mỗi 30s; client không pong trong 60s → đóng.
     * Client gửi tin > MAX_MSG_BYTES hoặc gửi quá nhanh → đóng.
     * Khi tab đóng / app ngừng → browser tự ngắt WS; server dọn trong
       'close'. Frontend cũng chủ động disconnect khi rời tab / ẩn tab.
   ============================================================ */
'use strict';
let WebSocketServer = null;
try {
    // eslint-disable-next-line global-require
    ({ WebSocketServer } = require('ws'));
} catch (_) {
    WebSocketServer = null; // ws chưa cài → vô hiệu hóa, frontend fallback poll
}
const MAX_CLIENTS = 1000;
const MAX_PER_IP = 5;
const MAX_MSG_BYTES = 1024;
const PING_INTERVAL_MS = 30 * 1000;
const PONG_TIMEOUT_MS = 60 * 1000;
const BROADCAST_THROTTLE_MS = 1000; // broadcast tối đa 1 lần / giây
const clients = new Set();
const ipCount = new Map();
let _broadcastTimer = null;
let _wss = null;
function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function snapshot() {
    const presence = require('./utils/presence');
    const list = presence.getOnlineList();
    return {
        type: 'presence',
        payload: { online: list, count: list.length, serverSince: process.uptime(), ts: Date.now() }
    };
}
function broadcast() {
    if (!_wss || !clients.size) return;
    // Throttle: nếu đã lên lịch trong khung 1s → bỏ qua.
    if (_broadcastTimer) return;
    _broadcastTimer = setTimeout(() => {
        _broadcastTimer = null;
        if (!clients.size) return;
        let msg = null;
        try { msg = JSON.stringify(snapshot()); } catch (_) { return; }
        for (const ws of clients) {
            if (ws.readyState === 1) { // OPEN
                try { ws.send(msg); } catch (_) {}
            }
        }
    }, BROADCAST_THROTTLE_MS);
}
/** Gọi từ bên ngoài (vd sau khi presence.track/remove) để kích hoạt broadcast. */
function notifyChange() { broadcast(); }
function attachWSServer(httpServer) {
    if (!WebSocketServer) {
        console.log('⚠️  WS presence: package "ws" chưa cài → bỏ qua (frontend fallback polling). Chạy: npm install ws');
        return false;
    }
    if (_wss) return true;
    const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MSG_BYTES });
    _wss = wss;
    // Heartbeat: ping định kỳ, đóng client không phản hồi.
    const pingTimer = setInterval(() => {
        for (const ws of clients) {
            if (ws._dead) { try { ws.terminate(); } catch (_) {} continue; }
            if (Date.now() - (ws._lastPong || ws._connectedAt) > PONG_TIMEOUT_MS) {
                ws._dead = true;
                try { ws.terminate(); } catch (_) {}
                continue;
            }
            try { ws.ping(); } catch (_) {}
        }
    }, PING_INTERVAL_MS);
    pingTimer.unref();
    wss.on('connection', (ws, req) => {
        const ip = clientIp(req);
        const count = ipCount.get(ip) || 0;
        if (clients.size >= MAX_CLIENTS || count >= MAX_PER_IP) {
            try { ws.close(1013, 'Too many connections'); } catch (_) {}
            return;
        }
        ipCount.set(ip, count + 1);
        ws._connectedAt = Date.now();
        ws._lastPong = Date.now();
        ws._ip = ip;
        clients.add(ws);
        ws.on('pong', () => { ws._lastPong = Date.now(); });
        ws.on('message', (data) => {
            // Client chỉ được ping nhẹ; gửi dữ liệu lớn / spam → đóng.
            const len = data ? data.length : 0;
            if (len > MAX_MSG_BYTES) { try { ws.close(1009, 'Message too big'); } catch (_) {} }
        });
        const cleanup = () => {
            clients.delete(ws);
            const c = (ipCount.get(ip) || 1) - 1;
            if (c <= 0) ipCount.delete(ip); else ipCount.set(ip, c);
        };
        ws.on('close', cleanup);
        ws.on('error', () => { try { ws.terminate(); } catch (_) {} cleanup(); });
        // Gửi snapshot ngay khi kết nối.
        try { ws.send(JSON.stringify(snapshot())); } catch (_) {}
    });
    wss.on('error', (err) => { console.warn('[WS presence] server error:', err && err.message); });
    // An toàn: broadcast định kỳ 2s làm lưới dự phòng (kể cả khi thiếu event change).
    const safetyTimer = setInterval(broadcast, 2000);
    safetyTimer.unref();
    console.log('✅ WS presence realtime đã bật (ws://<host>/ws).');
    return true;
}
module.exports = { attachWSServer, notifyChange, isAvailable: () => !!WebSocketServer };
