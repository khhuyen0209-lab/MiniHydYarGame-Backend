/* ============================================================
   src/routes/rankings.js — Xếp hạng & Trực tuyến
   ------------------------------------------------------------
   GET  /rankings/games        Danh sách game có bảng xếp hạng.
   GET  /rankings/board?game=  Top 50 theo điểm cao của 1 game (có hạng).
   GET  /presence/online       Danh sách người online (RAM, sớm nhất
                               đứng đầu, KHÔNG ghi hạng).
   POST /presence/heartbeat    Giữ trạng thái online (kèm token).
   ------------------------------------------------------------
   - Điểm cao lấy từ users.highScores (server đồng bộ từ progress
     khi client POST /user/sync). Cache 30s để không query toàn bộ
     users mỗi request.
   - Online lưu trên RAM (utils/presence.js): tự reset khi server
     khởi động lại. Bất kỳ request có token hợp lệ nào cũng kích
     hoạt track() → login tự động → server bắt → gán online.
   ============================================================ */
'use strict';
const express = require('express');
const { db } = require('../config/firebase');
const { verifyToken, optionalAuth } = require('../middleware/auth');
const presence = require('../utils/presence');
const router = express.Router();
/* Map game có bảng xếp hạng: key trong highScores ↔ tên hiển thị.
   (Khớp với HS_MAP trong routes/user.js & GameScriptMap frontend.) */
const LEADERBOARD_GAMES = [
    { key: 'neon-shooter', name: 'Xạ Thủ Neon',     id: 'mg001' },
    { key: 'block-puzzle', name: 'Ghép Khối Logic', id: 'mg002' },
    { key: 'cloud-jump',   name: 'Bước Trên Mây',   id: 'mg004' },
    { key: 'memory-game',  name: 'Lật Thẻ Nhớ',     id: 'mg007' },
    { key: 'guess-number', name: 'Đoán Số',         id: 'mg009' }
];
const RANK_CACHE_TTL = 30 * 1000; // 30s
let _rankCache = { at: 0, data: null };
async function getAllUsersForRank() {
    const now = Date.now();
    if (_rankCache.data && now - _rankCache.at < RANK_CACHE_TTL) return _rankCache.data;
    const snap = await db.collection('users').select('displayName', 'avatar', 'highScores').limit(2000).get();
    const users = snap.docs.map((d) => {
        const x = d.data();
        return { uid: d.id, displayName: x.displayName || 'Người chơi', avatar: x.avatar || '', highScores: x.highScores || {} };
    });
    _rankCache = { at: now, data: users };
    return users;
}
function invalidateRankCache() { _rankCache.at = 0; }
/* ------------------------------------------------------------
   GET /rankings/games
------------------------------------------------------------ */
router.get('/rankings/games', (req, res) => {
    return res.ok({ games: LEADERBOARD_GAMES.map((g) => ({ key: g.key, name: g.name, id: g.id })) }, 'Danh sách bảng xếp hạng.');
});
/* ------------------------------------------------------------
   GET /rankings/board?game=<key> — Top 50, CÓ ghi hạng.
------------------------------------------------------------ */
router.get('/rankings/board', optionalAuth, async (req, res, next) => {
    try {
        const game = String(req.query.game || '').trim();
        const meta = LEADERBOARD_GAMES.find((g) => g.key === game || g.id === game);
        if (!meta) {
            return res.status(400).json({ success: false, message: 'Game không hợp lệ.', data: null, error: 'VALIDATION_ERROR' });
        }
        const users = await getAllUsersForRank();
        const scored = users
            .map((u) => ({ uid: u.uid, displayName: u.displayName, avatar: u.avatar, score: Number((u.highScores || {})[meta.key]) || 0 }))
            .filter((u) => u.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 50)
            .map((u, i) => Object.assign({ rank: i + 1 }, u));
        // Vị trí của tôi (nếu đã đăng nhập).
        let myRank = null;
        if (req.user && req.user.uid) {
            const me = users.find((u) => u.uid === req.user.uid);
            const myScore = me ? Number((me.highScores || {})[meta.key]) || 0 : 0;
            if (myScore > 0) {
                myRank = users.filter((u) => (Number((u.highScores || {})[meta.key]) || 0) > myScore).length + 1;
            }
        }
        return res.ok({ game: meta.key, name: meta.name, board: scored, total: scored.length, myRank }, 'Lấy bảng xếp hạng thành công.');
    } catch (err) { return next(err); }
});
/* ------------------------------------------------------------
   GET /presence/online — Danh sách online (RAM). KHÔNG ghi hạng.
   Sắp xếp theo since tăng dần (online sớm nhất lúc server bật đứng đầu).
------------------------------------------------------------ */
router.get('/presence/online', optionalAuth, (req, res) => {
    const list = presence.getOnlineList();
    return res.ok({ online: list, count: list.length, serverSince: process.uptime() }, 'Danh sách trực tuyến.');
});
/* ------------------------------------------------------------
   POST /presence/heartbeat — Giữ online (verifyToken đã track sẵn,
   endpoint này chỉ để client chủ động ping + nhận số liệu).
------------------------------------------------------------ */
router.post('/presence/heartbeat', verifyToken, (req, res) => {
    return res.ok({ onlineCount: presence.getOnlineCount(), you: req.user.uid }, 'Heartbeat OK.');
});
module.exports = { router, invalidateRankCache };
