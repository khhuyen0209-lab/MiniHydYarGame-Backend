/* ============================================================
   src/utils/presence.js — Danh sách người dùng ONLINE (trên RAM)
   ------------------------------------------------------------
   - Server lưu người dùng trên RAM: Map uid → {displayName, avatar,
     since, lastSeen}. "since" = lần đầu online kể từ khi server bật.
   - Bất kỳ request nào có token hợp lệ (login tự động → gọi server)
     đều kích hoạt track(): nếu uid chưa có → gán online (since = now),
     rồi cập nhật lastSeen. Người online sớm nhất (since nhỏ nhất) đứng
     đầu danh sách. Bảng Trực tuyến KHÔNG ghi hạng.
   - TTL: tự xóa người không còn hoạt động sau ONLINE_TTL_MS.
   - Khi server restart → danh sách reset (đúng yêu cầu "lúc sever bật").
   ============================================================ */
'use strict';
const ONLINE_TTL_MS = Number(process.env.ONLINE_TTL_MS) || 2 * 60 * 1000; // 2 phút
const MAX_ONLINE = 500;
/** @type {Map<string, {displayName:string, avatar:string, since:number, lastSeen:number}>} */
const online = new Map();
/**
 * Ghi nhận hoạt động của user (gọi từ middleware sau khi verify token).
 * @param {{uid:string, name?:string, picture?:string}} user
 * @param {{displayName?:string, avatar?:string}} [extra]
 */
function track(user, extra) {
    if (!user || !user.uid) return;
    const now = Date.now();
    const existing = online.get(user.uid);
    const displayName = (extra && extra.displayName) || user.name || 'Người chơi';
    const avatar = (extra && extra.avatar) || user.picture || '';
    if (existing) {
        existing.lastSeen = now;
        if (displayName && displayName !== 'Người chơi') existing.displayName = displayName;
        if (avatar) existing.avatar = avatar;
    } else {
        online.set(user.uid, { displayName: String(displayName).slice(0, 40), avatar: String(avatar || '').slice(0, 500), since: now, lastSeen: now });
        if (online.size > MAX_ONLINE) {
            // Xóa người không hoạt động lâu nhất nếu quá giới hạn.
            let oldestUid = null, oldestSeen = Infinity;
            for (const [uid, rec] of online) {
                if (rec.lastSeen < oldestSeen) { oldestSeen = rec.lastSeen; oldestUid = uid; }
            }
            if (oldestUid) online.delete(oldestUid);
        }
    }
}
/** Xóa người quá TTL. Gọi định kỳ. */
function cleanup() {
    const now = Date.now();
    for (const [uid, rec] of online) {
        if (now - rec.lastSeen > ONLINE_TTL_MS) online.delete(uid);
    }
}
setInterval(cleanup, 30 * 1000).unref();
/**
 * Danh sách online SẮP XẾP theo since tăng dần (online sớm nhất đứng đầu).
 * Bảng này KHÔNG xếp hạng → trả về mảng không có field rank.
 * @returns {Array<{uid:string, displayName:string, avatar:string, since:number, onlineForMs:number}>}
 */
function getOnlineList() {
    cleanup();
    const now = Date.now();
    return Array.from(online.entries())
        .map(([uid, rec]) => ({
            uid,
            displayName: rec.displayName,
            avatar: rec.avatar,
            since: rec.since,
            onlineForMs: Math.max(0, now - rec.since)
        }))
        .sort((a, b) => a.since - b.since);
}
function getOnlineCount() { cleanup(); return online.size; }
/** Kiểm tra 1 uid có đang online không (RAM, có TTL 2 phút). */
function isOnline(uid) {
    if (!uid) return false;
    cleanup();
    const rec = online.get(uid);
    if (!rec) return false;
    return (Date.now() - rec.lastSeen) <= ONLINE_TTL_MS;
}
function remove(uid) { if (uid) online.delete(uid); }
module.exports = { track, getOnlineList, getOnlineCount, isOnline, remove, cleanup, ONLINE_TTL_MS };
