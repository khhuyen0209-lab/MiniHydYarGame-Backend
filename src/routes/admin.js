/* ============================================================
   src/routes/admin.js — /api/v1/admin
   ✅ MỌI route đều đi qua requireAdmin (chống giả mạo):
      token hợp lệ + email thuộc ADMIN_EMAILS + users.doc(uid).role==='admin'
      (hoặc x-admin-secret). Role CHỈ server set được.
   ✅ Mọi hành động đều ghi nhật ký admin_actions (kiểm duyệt).
   ------------------------------------------------------------
   GET    /users?search=   Tìm user (email / tên / mã mời / uid)
   GET    /user?target=    Chi tiết 1 user
   POST   /reset-invite    Reset lượt nhập mã mời của 1 user (để nhập lại)
   POST   /reset-account   Reset toàn bộ tài khoản chỉ định (để test)
   POST   /set-coins       Đặt lại số coin (test)
   GET    /audit           Nhật ký hành động admin
   ============================================================ */
'use strict';
const express = require('express');
const { db, FieldValue, Timestamp } = require('../config/firebase');
const { verifyToken, optionalAuth, requireAdmin } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/limiter');
const { ERROR_CODES, sanitizeUser, getAdminPanelKey, generateUniqueInviteCode, CODE_PREFIX, buildDefaultInventory } = require('../utils/helpers');
const router = express.Router();
/* ---------------- Khóa panel quản trị viên (yếu tố thứ 2) ----------------
   Nếu ADMIN_PANEL_KEY khác rỗng → mọi request /admin/* phải gửi header
   x-admin-panel-key khớp. Client nhập key trong panel mới mở được. */
function requirePanelKey(req, res, next) {
    const expected = getAdminPanelKey();
    if (!expected) return next(); // env rỗng → bỏ qua lớp khóa này
    const provided = req.headers['x-admin-panel-key'] || (req.body && req.body.adminPanelKey) || '';
    if (String(provided) !== expected) {
        return res.fail('Sai khóa quản trị viên.', ERROR_CODES.ADMIN_REQUIRED, 403);
    }
    return next();
}
// optionalAuth: nếu có token hợp lệ → gắn req.user (cho đường dẫn role admin).
// requireAdmin: chấp nhận x-admin-secret HOẶC token + email whitelist + DB role.
// requirePanelKey: khóa bổ sung (key của nick admin).
router.use(optionalAuth, requireAdmin, requirePanelKey, strictLimiter);
const USERS = () => db.collection('users');
const AUDIT = () => db.collection('admin_actions');
/* ---------------- Nhật ký hành động ---------------- */
async function logAction(req, action, target, detail) {
    try {
        await AUDIT().add({
            adminUid: (req.user && req.user.uid) || (req.adminVia === 'secret' ? 'secret' : 'unknown'),
            adminEmail: (req.user && req.user.email) || '',
            adminVia: req.adminVia || '',
            action, target: String(target || '').slice(0, 200),
            detail: String(detail || '').slice(0, 500),
            ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 64),
            at: Timestamp.now()
        });
    } catch (e) { console.warn('[admin audit] failed:', e.message); }
}
/* ---------------- Giải quyết target: uid / email / inviteCode ---------------- */
async function resolveTarget(target) {
    const t = String(target || '').trim();
    if (!t) return null;
    // 1. Uid (độ dài Firebase uid thường >= 20, nhưng thử trực tiếp trước).
    const byId = await USERS().doc(t).get();
    if (byId.exists) return byId.ref;
    // 2. Email.
    const byEmail = await USERS().where('email', '==', t.toLowerCase()).limit(1).get();
    if (!byEmail.empty) return byEmail.docs[0].ref;
    // 3. Invite code.
    const byCode = await USERS().where('inviteCode', '==', t.toUpperCase()).limit(1).get();
    if (!byCode.empty) return byCode.docs[0].ref;
    return null;
}
function publicUser(d) {
    const s = sanitizeUser(d);
    // Không lộ email cho danh sách chung (chỉ admin mới thấy, nhưng vẫn che bớt).
    return s;
}
/* ------------------------------------------------------------
   GET /users?search=
------------------------------------------------------------ */
router.get('/users', async (req, res, next) => {
    try {
        const q = String(req.query.search || '').trim().toLowerCase();
        let docs = [];
        if (q) {
            // Tìm theo email chính xác / inviteCode / displayName chứa.
            const [byEmail, byCode, byName] = await Promise.all([
                USERS().where('email', '==', q).limit(10).get(),
                USERS().where('inviteCode', '==', q.toUpperCase()).limit(10).get(),
                USERS().orderBy('displayName').startAt(q).endAt(q + '\uf8ff').limit(10).get().catch(() => ({ docs: [] }))
            ]);
            const seen = new Set();
            for (const snap of [byEmail, byCode, byName]) {
                for (const d of (snap.docs || [])) {
                    if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); }
                }
            }
        } else {
            const snap = await USERS().orderBy('createdAt', 'desc').limit(50).get();
            docs = snap.docs;
        }
        const users = docs.slice(0, 50).map((d) => publicUser(d.data()));
        return res.ok({ users, total: users.length }, 'Tìm kiếm thành công.');
    } catch (err) { return next(err); }
});
/* ------------------------------------------------------------
   GET /user?target=
------------------------------------------------------------ */
router.get('/user', async (req, res, next) => {
    try {
        const ref = await resolveTarget(req.query.target);
        if (!ref) return res.fail('Không tìm thấy người dùng (thử uid / email / mã mời).', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        const snap = await ref.get();
        return res.ok({ user: publicUser(snap.data()) }, 'Lấy thông tin thành công.');
    } catch (err) { return next(err); }
});
/* ------------------------------------------------------------
   POST /reset-invite — Reset lượt nhập mã mời của 1 user.
   - Bỏ khóa inviteUsed + xóa invitedBy (user đó nhập lại được).
   - Hoàn tác referral: giảm inviteCount + xóa khỏi inviteHistory
     của người đã mời họ (nếu có). Không hoàn coin (tránh lệch số dư).
   Body: { target }
------------------------------------------------------------ */
router.post('/reset-invite', async (req, res, next) => {
    try {
        const ref = await resolveTarget(req.body && req.body.target);
        if (!ref) return res.fail('Không tìm thấy người dùng.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        const snap = await ref.get();
        const data = snap.data();
        const inviterUid = data.invitedBy || null;
        const updates = { inviteUsed: false, invitedBy: null };
        // Hoàn tác đếm lượt mời ở người mời (nếu có).
        if (inviterUid) {
            const inviterRef = USERS().doc(inviterUid);
            const inviterSnap = await inviterRef.get();
            if (inviterSnap.exists) {
                const history = Array.isArray(inviterSnap.data().inviteHistory) ? inviterSnap.data().inviteHistory : [];
                const filtered = history.filter((h) => !(h && h.uid === snap.id));
                await inviterRef.update({
                    inviteCount: FieldValue.increment(-1),
                    inviteHistory: filtered
                });
            }
        }
        await ref.update(updates);
        await logAction(req, 'reset-invite', snap.id, `inviteUsed=false, invitedBy=${inviterUid || 'null'}`);
        return res.ok({ reset: true, uid: snap.id, inviterUndone: !!inviterUid }, 'Đã reset lượt nhập mã mời.');
    } catch (err) { return next(err); }
});
/* ------------------------------------------------------------
   POST /reset-account — Reset toàn bộ tài khoản chỉ định (test).
   Giữ lại: uid, email, displayName, avatar, bio, inviteCode, role,
   inviteBypass, createdAt. Xóa: coin, library, progress, highScores,
   inviteUsed, invitedBy, usedSystemCodes, rewardsHistory,
   claimedMilestones, inviteCount, inviteHistory, inviteRewardsTotal.
   Body: { target }
------------------------------------------------------------ */
router.post('/reset-account', async (req, res, next) => {
    try {
        const ref = await resolveTarget(req.body && req.body.target);
        if (!ref) return res.fail('Không tìm thấy người dùng.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        const snap = await ref.get();
        const data = snap.data();
        await ref.update({
            coins: 0,
            library: [],
            progress: {},
            highScores: {},
            settings: {},
            inviteUsed: false,
            invitedBy: null,
            usedSystemCodes: [],
            rewardsHistory: [],
            claimedMilestones: [],
            inviteCount: 0,
            inviteHistory: [],
            inviteRewardsTotal: 0,
            inventory: buildDefaultInventory(Timestamp.now()),
            lastLoginAt: FieldValue.serverTimestamp()
        });
        await logAction(req, 'reset-account', snap.id, `email=${data.email || ''}`);
        return res.ok({ reset: true, uid: snap.id }, 'Đã reset tài khoản về trạng thái mới.');
    } catch (err) { return next(err); }
});
/* ------------------------------------------------------------
   POST /set-coins — Đặt số coin (test). Body: { target, coins }
------------------------------------------------------------ */
router.post('/set-coins', async (req, res, next) => {
    try {
        const ref = await resolveTarget(req.body && req.body.target);
        if (!ref) return res.fail('Không tìm thấy người dùng.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        const coins = Number(req.body && req.body.coins);
        if (!Number.isFinite(coins) || coins < 0 || coins > 10000000) {
            return res.fail('Số coin không hợp lệ (0–10,000,000).', ERROR_CODES.VALIDATION_ERROR, 400);
        }
        await ref.update({ coins });
        await logAction(req, 'set-coins', ref.id, `coins=${coins}`);
        return res.ok({ coins }, 'Đã đặt số coin.');
    } catch (err) { return next(err); }
});
/* ------------------------------------------------------------
   GET /audit — Nhật ký hành động admin (200 gần nhất).
------------------------------------------------------------ */
router.get('/audit', async (req, res, next) => {
    try {
        const snap = await AUDIT().orderBy('at', 'desc').limit(200).get();
        const logs = snap.docs.map((d) => {
            const x = d.data();
            return { id: d.id, action: x.action, target: x.target, detail: x.detail, adminEmail: x.adminEmail, adminVia: x.adminVia, at: x.at || null, ip: x.ip };
        });
        return res.ok({ logs }, 'Lấy nhật ký thành công.');
    } catch (err) { return next(err); }
});
/* ------------------------------------------------------------
   POST /reset-all-invites — RESET TOÀN BỘ trạng thái mời trên toàn app.
   Chỉ admin (đã qua requireAdmin + requirePanelKey) mới kích hoạt được.
   - Mọi user: inviteUsed=false, invitedBy=null, inviteCount=0,
     inviteHistory=[], claimedMilestones=[], usedSystemCodes=[],
     rewardsHistory=[], inviteRewardsTotal=0, và TẠO MỚI inviteCode (AC...).
   - system_codes: reset uses=0 (giữ lại mã, có thể dùng lại từ đầu).
   - Giữ nguyên role/coin/tài khoản. Ghi nhật ký.
   Body: { confirm: true } (yêu cầu xác nhận).
------------------------------------------------------------ */
router.post('/reset-all-invites', async (req, res, next) => {
    try {
        if (!req.body || req.body.confirm !== true) {
            return res.fail('Yêu cầu xác nhận (confirm: true) để reset toàn bộ mời.', ERROR_CODES.VALIDATION_ERROR, 400);
        }
        const USERS_COLL = USERS();
        const snap = await USERS_COLL.select().limit(5000).get();
        const uids = snap.docs.map((d) => d.id);
        let done = 0;
        // Batch write (tối đa 500 lệnh/batch).
        for (let i = 0; i < uids.length; i += 200) {
            const batch = db.batch();
            const chunk = uids.slice(i, i + 200);
            // Sinh mã mới trước (async) rồi mới update.
            const newCodes = await Promise.all(chunk.map(() => generateUniqueInviteCode(CODE_PREFIX.USER)));
            chunk.forEach((uid, idx) => {
                batch.update(USERS_COLL.doc(uid), {
                    inviteUsed: false,
                    invitedBy: null,
                    inviteCount: 0,
                    inviteHistory: [],
                    claimedMilestones: [],
                    usedSystemCodes: [],
                    rewardsHistory: [],
                    inviteRewardsTotal: 0,
                    inviteCode: newCodes[idx]
                });
            });
            await batch.commit();
            done += chunk.length;
        }
        // Reset lượt dùng mã hệ thống (giữ lại mã).
        const sysSnap = await db.collection('system_codes').select().limit(1000).get();
        for (let i = 0; i < sysSnap.docs.length; i += 200) {
            const batch = db.batch();
            sysSnap.docs.slice(i, i + 200).forEach((d) => batch.update(d.ref, { uses: 0 }));
            await batch.commit();
        }
        await logAction(req, 'reset-all-invites', 'ALL', `users=${done}, systemCodes=${sysSnap.docs.length}`);
        return res.ok({ resetUsers: done, resetSystemCodes: sysSnap.docs.length }, 'Đã reset toàn bộ trạng thái mời trên toàn app. Mã mời người dùng đã được tạo mới.');
    } catch (err) { return next(err); }
});
module.exports = router;
