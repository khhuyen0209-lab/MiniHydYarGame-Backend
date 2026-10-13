/* ============================================================
   src/routes/invite.js — /api/v1/invite
   GET    /my-code     Lấy mã mời của tôi (prefix HY + 6 ký tự)
   POST   /use-code    Nhập mã mời (kiểm tra system_codes TRƯỚC,
                       rồi mới đến users.inviteCode)
   GET    /my-invites  Xem danh sách người tôi đã mời
   GET    /rewards     Xem mốc thưởng & tự động nhận quà mốc đã đạt
   GET    /history     Lịch sử nhận thưởng
   POST   /admin/system-code  (ADMIN) Tạo mã hệ thống (bất kỳ prefix nào)
   ------------------------------------------------------------
   ✅ QUAN TRỌNG: Mã hệ thống (kể cả HY_2306TL) KHÔNG đánh dấu
      inviteUsed → người dùng vẫn nhập tiếp được mã mời của người
      khác sau đó. Chỉ mã người dùng (users.inviteCode) mới khóa.
   ============================================================ */
'use strict';
const express = require('express');
const { db, FieldValue, Timestamp } = require('../config/firebase');
const { verifyToken, optionalAuth, requireAdmin } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/limiter');
const {
    ERROR_CODES,
    CODE_PREFIX,
    SYSTEM_PREFIXES,
    generateUniqueInviteCode,
    REFERRAL_REWARDS,
    INVITE_MILESTONES,
    sanitizeUser
} = require('../utils/helpers');

const router = express.Router();
const USERS = () => db.collection('users');
const SYSTEM_CODES = () => db.collection('system_codes');

/* requireAdmin dùng chung từ middleware/auth.js (chống giả mạo: token + email whitelist + DB role). */

/* ------------------------------------------------------------
   GET /my-code
------------------------------------------------------------ */
router.get('/my-code', verifyToken, async (req, res, next) => {
    try {
        const userRef = USERS().doc(req.user.uid);
        const snap = await userRef.get();
        if (!snap.exists) {
            return res.fail('Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        }
        let inviteCode = snap.data().inviteCode;
        if (!inviteCode) {
            inviteCode = await generateUniqueInviteCode(CODE_PREFIX.USER);
            await userRef.update({ inviteCode });
        }
        return res.ok({ inviteCode, inviteCount: Number(snap.data().inviteCount) || 0 }, 'Lấy mã mời thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   POST /use-code — Logic ưu tiên:
   1. Tra cứu system_codes TRƯỚC (mã hệ thống: thưởng, KHÔNG khóa).
   2. Không có → tra cứu users.inviteCode (mã người dùng: khóa inviteUsed).
   3. Không có cả hai → CODE_NOT_FOUND.
------------------------------------------------------------ */
router.post('/use-code', verifyToken, strictLimiter, async (req, res, next) => {
    try {
        const rawCode = (req.body && req.body.code) ? String(req.body.code) : '';
        // Cho phép chữ, số, gạch dưới (vd HY_2306TL). Không phân biệt hoa thường.
        const code = rawCode.trim().toUpperCase();
        if (!code || !/^[A-Z0-9_]{4,20}$/.test(code)) {
            return res.fail('Mã mời không hợp lệ (4–20 ký tự chữ/số/dấu gạch dưới).', ERROR_CODES.VALIDATION_ERROR, 400);
        }

        // 1. Kiểm tra system_codes TRƯỚC.
        const sysSnap = await SYSTEM_CODES().doc(code).get();
        if (sysSnap.exists) {
            return await _useSystemCode(req, res, code);
        }
        // 2. Kiểm tra users.inviteCode (mã người dùng).
        return await _useUserCode(req, res, code);
    } catch (err) { return next(err); }
});

/* ---------- Mã người dùng (HY... trong users) — KHÓA inviteUsed ---------- */
async function _useUserCode(req, res, code) {
    const found = await USERS().where('inviteCode', '==', code).limit(1).get();
    if (found.empty) {
        return res.fail('Mã mời không tồn tại.', ERROR_CODES.CODE_NOT_FOUND, 404);
    }
    const inviterRef = found.docs[0].ref;
    const inviterUid = found.docs[0].id;
    if (inviterUid === req.user.uid) {
        return res.fail('Bạn không thể nhập mã mời của chính mình.', ERROR_CODES.CODE_OWN, 400);
    }
    const inviteeRef = USERS().doc(req.user.uid);
    const now = Timestamp.now();

    const result = await db.runTransaction(async (tx) => {
        const [inviteeSnap, inviterSnap] = await Promise.all([tx.get(inviteeRef), tx.get(inviterRef)]);
        if (!inviteeSnap.exists) {
            const e = new Error('USER_NOT_INITIALIZED'); e.code = ERROR_CODES.USER_NOT_INITIALIZED; e.status = 404; throw e;
        }
        if (!inviterSnap.exists || inviterSnap.data().inviteCode !== code) {
            const e = new Error('CODE_NOT_FOUND'); e.code = ERROR_CODES.CODE_NOT_FOUND; e.status = 404; throw e;
        }
        const inviteeData = inviteeSnap.data();
        const inviterData = inviterSnap.data();
        // Admin (inviteBypass) KHÔNG bị giới hạn lượt nhập mã mời — phục vụ test.
        const inviteeBypass = !!inviteeData.inviteBypass || inviteeData.role === 'admin';
        if (!inviteeBypass && inviteeData.inviteUsed) {
            const e = new Error('CODE_USED'); e.code = ERROR_CODES.CODE_USED; e.status = 400; throw e;
        }

        // Cấp 2 (đệ quy): nếu người mời (A) cũng từng nhập mã của C → C nhận thưởng nhỏ.
        let grandUid = null, grandCoinsAfter = null;
        const grandUidCandidate = inviterData.invitedBy || null;
        if (grandUidCandidate && grandUidCandidate !== req.user.uid && grandUidCandidate !== inviterUid) {
            const grandRef = USERS().doc(grandUidCandidate);
            const grandSnap = await tx.get(grandRef);
            if (grandSnap.exists) {
                grandUid = grandUidCandidate;
                grandCoinsAfter = (Number(grandSnap.data().coins) || 0) + REFERRAL_REWARDS.SECOND_LEVEL;
                tx.update(grandRef, {
                    coins: FieldValue.increment(REFERRAL_REWARDS.SECOND_LEVEL),
                    inviteRewardsTotal: FieldValue.increment(REFERRAL_REWARDS.SECOND_LEVEL),
                    rewardsHistory: FieldValue.arrayUnion({
                        type: 'invite_second_level', fromUid: req.user.uid, viaUid: inviterUid,
                        code, coins: REFERRAL_REWARDS.SECOND_LEVEL, at: now
                    })
                });
            }
        }

        // Người được mời (B): quà chào mừng. Admin (bypass) KHÔNG bị đánh dấu khóa → nhập lại được.
        tx.update(inviteeRef, Object.assign({
            invitedBy: inviterUid,
            coins: FieldValue.increment(REFERRAL_REWARDS.WELCOME),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'invite_welcome', inviterUid, code, coins: REFERRAL_REWARDS.WELCOME, at: now
            }),
            lastLoginAt: now
        }, inviteeBypass ? {} : { inviteUsed: true }));
        // Người mời trực tiếp (A, cấp 1).
        tx.update(inviterRef, {
            inviteCount: FieldValue.increment(1),
            coins: FieldValue.increment(REFERRAL_REWARDS.DIRECT),
            inviteRewardsTotal: FieldValue.increment(REFERRAL_REWARDS.DIRECT),
            inviteHistory: FieldValue.arrayUnion({ uid: req.user.uid, at: now }),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'invite_direct', inviteeUid: req.user.uid, code, coins: REFERRAL_REWARDS.DIRECT, at: now
            })
        });

        return {
            inviterDisplayName: inviterData.displayName || 'Người chơi',
            inviteeCoinsAfter: (Number(inviteeData.coins) || 0) + REFERRAL_REWARDS.WELCOME,
            inviterCoinsAfter: (Number(inviterData.coins) || 0) + REFERRAL_REWARDS.DIRECT,
            grandUid, grandCoinsAfter,
            inviteeBypass
        };
    });

    const locked = !result.inviteeBypass;
    return res.ok({
        codeUsed: code, codeType: 'user',
        inviter: { uid: inviterUid, displayName: result.inviterDisplayName },
        reward: {
            youReceived: REFERRAL_REWARDS.WELCOME,
            inviterReceived: REFERRAL_REWARDS.DIRECT,
            secondLevelReceived: result.grandUid ? REFERRAL_REWARDS.SECOND_LEVEL : 0,
            secondLevelEligible: !!result.grandUid
        },
        yourCoins: result.inviteeCoinsAfter,
        inviteLocked: locked
    }, locked
        ? 'Nhập mã mời thành công. Bạn không thể nhập mã mời của người khác nữa.'
        : 'Nhập mã mời thành công (tài khoản quản trị — vẫn nhập lại được).');
}

/* ---------- Mã hệ thống (system_codes) — KHÔNG khóa inviteUsed ---------- */
async function _useSystemCode(req, res, code) {
    const codeRef = SYSTEM_CODES().doc(code);
    const userRef = USERS().doc(req.user.uid);
    const now = Timestamp.now();

    const result = await db.runTransaction(async (tx) => {
        const [codeSnap, userSnap] = await Promise.all([tx.get(codeRef), tx.get(userRef)]);
        if (!userSnap.exists) {
            const e = new Error('USER_NOT_INITIALIZED'); e.code = ERROR_CODES.USER_NOT_INITIALIZED; e.status = 404; throw e;
        }
        const cd = codeSnap.data();
        if (cd.active === false) {
            const e = new Error('CODE_EXPIRED'); e.code = ERROR_CODES.CODE_EXPIRED; e.status = 400; throw e;
        }
        const uses = Number(cd.uses) || 0;
        const maxUses = Number(cd.maxUses) || 1;
        if (uses >= maxUses) {
            const e = new Error('CODE_MAX_USES'); e.code = ERROR_CODES.CODE_MAX_USES; e.status = 400; throw e;
        }
        const used = Array.isArray(userSnap.data().usedSystemCodes) ? userSnap.data().usedSystemCodes : [];
        if (used.includes(code)) {
            const e = new Error('CODE_ALREADY_USED'); e.code = ERROR_CODES.CODE_ALREADY_USED; e.status = 400; throw e;
        }
        const rewardCoins = Number(cd.rewardCoins) || 0;
        tx.update(codeRef, { uses: FieldValue.increment(1), lastUsedAt: now });
        // ✅ KHÔNG đặt inviteUsed — người dùng vẫn nhập tiếp được mã người dùng sau.
        tx.update(userRef, {
            coins: FieldValue.increment(rewardCoins),
            usedSystemCodes: FieldValue.arrayUnion(code),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'system_code', code, prefix: cd.prefix || '', coins: rewardCoins, at: now
            }),
            lastLoginAt: now
        });
        return { rewardCoins, coinsAfter: (Number(userSnap.data().coins) || 0) + rewardCoins, note: cd.note || '' };
    });

    return res.ok({
        codeUsed: code, codeType: 'system',
        reward: { youReceived: result.rewardCoins },
        yourCoins: result.coinsAfter,
        note: result.note,
        inviteLocked: false
    }, 'Nhập mã hệ thống thành công. Bạn vẫn có thể nhập mã mời của người khác sau.');
}

/* ------------------------------------------------------------
   GET /my-invites
------------------------------------------------------------ */
router.get('/my-invites', verifyToken, async (req, res, next) => {
    try {
        let limit = parseInt(req.query.limit, 10) || 50;
        limit = Math.min(Math.max(limit, 1), 100);
        const snap = await USERS().where('invitedBy', '==', req.user.uid).orderBy('createdAt', 'desc').limit(limit).get();
        const invites = snap.docs.map((d) => {
            const data = d.data();
            return { uid: d.id, displayName: data.displayName || 'Người chơi', avatar: data.avatar || '', createdAt: data.createdAt || null };
        });
        return res.ok({ invites, total: invites.length }, 'Lấy danh sách mời thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   GET /rewards
------------------------------------------------------------ */
router.get('/rewards', verifyToken, async (req, res, next) => {
    try {
        const userRef = USERS().doc(req.user.uid);
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(userRef);
            if (!snap.exists) {
                const e = new Error('USER_NOT_INITIALIZED'); e.code = ERROR_CODES.USER_NOT_INITIALIZED; e.status = 404; throw e;
            }
            const data = snap.data();
            const inviteCount = Number(data.inviteCount) || 0;
            const claimed = Array.isArray(data.claimedMilestones) ? data.claimedMilestones : [];
            const toClaim = INVITE_MILESTONES.filter((m) => inviteCount >= m.required && !claimed.includes(m.id));
            let bonusTotal = 0;
            if (toClaim.length > 0) {
                bonusTotal = toClaim.reduce((sum, m) => sum + m.coins, 0);
                const now = Timestamp.now();
                tx.update(userRef, {
                    coins: FieldValue.increment(bonusTotal),
                    inviteRewardsTotal: FieldValue.increment(bonusTotal),
                    claimedMilestones: FieldValue.arrayUnion(...toClaim.map((m) => m.id)),
                    rewardsHistory: FieldValue.arrayUnion(...toClaim.map((m) => ({
                        type: 'milestone', milestoneId: m.id, label: m.label, coins: m.coins, at: now
                    })))
                });
            }
            const rewards = INVITE_MILESTONES.map((m) => {
                const isClaimed = claimed.includes(m.id) || toClaim.some((c) => c.id === m.id);
                return { id: m.id, label: m.label, requiredInvites: m.required, coins: m.coins, achieved: inviteCount >= m.required, claimed: isClaimed };
            });
            return { rewards, inviteCount, coinsAfter: (Number(data.coins) || 0) + bonusTotal, claimedNow: toClaim.map((m) => ({ id: m.id, coins: m.coins })), bonusTotal };
        });
        const msg = result.claimedNow.length ? `Đã nhận ${result.bonusTotal} coin từ ${result.claimedNow.length} mốc thưởng.` : 'Lấy danh sách phần thưởng thành công.';
        return res.ok(result, msg);
    } catch (err) {
        if (err && err.code === ERROR_CODES.USER_NOT_INITIALIZED) {
            return res.fail('Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.', err.code, 404);
        }
        return next(err);
    }
});

/* ------------------------------------------------------------
   GET /history
------------------------------------------------------------ */
router.get('/history', verifyToken, async (req, res, next) => {
    try {
        const snap = await USERS().doc(req.user.uid).get();
        if (!snap.exists) return res.fail('Tài khoản chưa được khởi tạo.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        const history = Array.isArray(snap.data().rewardsHistory) ? snap.data().rewardsHistory : [];
        return res.ok({ history: history.slice(-50).reverse(), total: history.length }, 'Lấy lịch sử thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   POST /admin/system-code — (ADMIN) Tạo mã hệ thống.
   Body: { code?, prefix?, rewardCoins?, maxUses?, note? }
   - Nếu truyền code cụ thể (vd HY_2306TL) → dùng đúng code đó.
   - Nếu không → sinh ngẫu nhiên với prefix PXE/GNTU.
------------------------------------------------------------ */
router.post('/admin/system-code', optionalAuth, requireAdmin, async (req, res, next) => {
    try {
        const body = req.body || {};
        let code = body.code ? String(body.code).trim().toUpperCase() : null;
        if (code && !/^[A-Z0-9_]{4,20}$/.test(code)) {
            return res.fail('Code không hợp lệ (4–20 ký tự chữ/số/dấu gạch dưới).', ERROR_CODES.VALIDATION_ERROR, 400);
        }
        const rewardCoins = Math.max(0, Math.min(100000, Number(body.rewardCoins) || 100));
        const maxUses = Math.max(1, Math.min(1000000, Number(body.maxUses) || 1));
        const note = String(body.note || '').slice(0, 200);
        const prefix = SYSTEM_PREFIXES.includes(body.prefix) ? body.prefix : CODE_PREFIX.SYSTEM_HY;

        if (!code) {
            code = await generateUniqueInviteCode(prefix);
        } else {
            // Kiểm tra trùng với user code.
            const userSnap = await USERS().where('inviteCode', '==', code).limit(1).get();
            if (!userSnap.empty) {
                return res.fail('Code này trùng với mã mời của người dùng.', ERROR_CODES.VALIDATION_ERROR, 400);
            }
            const existing = await SYSTEM_CODES().doc(code).get();
            if (existing.exists) {
                return res.fail('Code này đã tồn tại.', ERROR_CODES.VALIDATION_ERROR, 400);
            }
        }
        const now = Timestamp.now();
        await SYSTEM_CODES().doc(code).set({
            code, prefix: SYSTEM_PREFIXES.find((p) => code.startsWith(p)) || prefix,
            rewardCoins, maxUses, uses: 0, active: true,
            note, createdAt: now, createdBy: 'admin'
        });
        return res.ok({ code, rewardCoins, maxUses, note }, 'Tạo mã hệ thống thành công.', 201);
    } catch (err) { return next(err); }
});

module.exports = router;
