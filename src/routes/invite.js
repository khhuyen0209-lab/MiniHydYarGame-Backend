/* ============================================================
   src/routes/invite.js — /api/v1/invite
   GET    /my-code     Lấy mã mời của tôi (prefix HY + 6 ký tự)
   POST   /use-code    Nhập mã mời (hỗ trợ mã người dùng HY... lẫn mã hệ thống PXE.../GNTU...)
   GET    /my-invites  Xem danh sách người tôi đã mời
   GET    /rewards     Xem mốc thưởng & tự động nhận quà mốc đã đạt
   GET    /history     Lịch sử nhận thưởng (mời, hệ thống, mốc)
   POST   /admin/system-code  (ADMIN) Tạo mã hệ thống (PXE/GNTU)
   ============================================================ */
'use strict';
const express = require('express');
const { db, FieldValue, Timestamp } = require('../config/firebase');
const { verifyToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/limiter');
const {
    ERROR_CODES,
    CODE_PREFIX,
    generateUniqueInviteCode,
    classifyCode,
    REFERRAL_REWARDS,
    INVITE_MILESTONES,
    sanitizeUser
} = require('../utils/helpers');

const router = express.Router();
const USERS = () => db.collection('users');
const SYSTEM_CODES = () => db.collection('system_codes');

/* ---------- Middleware admin (tạo mã hệ thống) ---------- */
function requireAdmin(req, res, next) {
    const secret = process.env.ADMIN_SECRET || '';
    if (!secret) {
        return res.fail(
            'Server chưa cấu hình ADMIN_SECRET — không thể dùng tính năng admin.',
            ERROR_CODES.ADMIN_REQUIRED, 503
        );
    }
    const provided = req.headers['x-admin-secret'] || (req.body && req.body.adminSecret) || '';
    if (provided !== secret) {
        return res.fail('Không có quyền admin.', ERROR_CODES.ADMIN_REQUIRED, 403);
    }
    return next();
}

/* ------------------------------------------------------------
   GET /my-code — Trả mã mời của user (prefix HY).
   Tài khoản cũ chưa có → sinh & lưu ngay.
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
        return res.ok(
            { inviteCode, inviteCount: Number(snap.data().inviteCount) || 0 },
            'Lấy mã mời thành công.'
        );
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   POST /use-code — Nhập mã mời.
   Phân loại:
   • Mã người dùng (HY...): referral 2 cấp (đệ quy) trong Transaction.
   • Mã hệ thống (PXE.../GNTU...): quà tặng/promo, dùng được nhiều lần
     (maxUses), mỗi người chỉ dùng 1 lần/mã.
------------------------------------------------------------ */
router.post('/use-code', verifyToken, strictLimiter, async (req, res, next) => {
    try {
        const rawCode = (req.body && req.body.code) ? String(req.body.code) : '';
        const code = rawCode.trim().toUpperCase();
        const kind = classifyCode(code);
        if (!kind) {
            return res.fail(
                `Mã mời không hợp lệ. Mã người dùng bắt đầu bằng HY, mã hệ thống bắt đầu bằng PXE hoặc GNTU, kèm ${6} ký tự.`,
                ERROR_CODES.VALIDATION_ERROR, 400
            );
        }

        if (kind.type === 'system') {
            return await _useSystemCode(req, res, code);
        }
        return await _useUserCode(req, res, code);
    } catch (err) { return next(err); }
});

/* ---------- Nhập mã người dùng (HY...) — referral 2 cấp ---------- */
async function _useUserCode(req, res, code) {
    // Tìm chủ mã (ngoài transaction, kiểm tra lại bên trong).
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
        if (inviteeSnap.data().inviteUsed) {
            const e = new Error('CODE_USED'); e.code = ERROR_CODES.CODE_USED; e.status = 400; throw e;
        }

        const inviteeData = inviteeSnap.data();
        const inviterData = inviterSnap.data();

        // --- Cấp 2 (đệ quy): nếu người mời (A) cũng từng nhập mã của C → C nhận thưởng nhỏ ---
        let grandRef = null, grandUid = null, grandCoinsAfter = null;
        const grandUidCandidate = inviterData.invitedBy || null;
        if (grandUidCandidate && grandUidCandidate !== req.user.uid && grandUidCandidate !== inviterUid) {
            grandRef = USERS().doc(grandUidCandidate);
            const grandSnap = await tx.get(grandRef);
            if (grandSnap.exists) {
                grandUid = grandUidCandidate;
                grandCoinsAfter = (Number(grandSnap.data().coins) || 0) + REFERRAL_REWARDS.SECOND_LEVEL;
                tx.update(grandRef, {
                    coins: FieldValue.increment(REFERRAL_REWARDS.SECOND_LEVEL),
                    inviteRewardsTotal: FieldValue.increment(REFERRAL_REWARDS.SECOND_LEVEL),
                    rewardsHistory: FieldValue.arrayUnion({
                        type: 'invite_second_level',
                        fromUid: req.user.uid,
                        viaUid: inviterUid,
                        code,
                        coins: REFERRAL_REWARDS.SECOND_LEVEL,
                        at: now
                    })
                });
            }
        }

        // --- Người được mời (B): quà chào mừng ---
        tx.update(inviteeRef, {
            invitedBy: inviterUid,
            inviteUsed: true,
            coins: FieldValue.increment(REFERRAL_REWARDS.WELCOME),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'invite_welcome',
                inviterUid,
                code,
                coins: REFERRAL_REWARDS.WELCOME,
                at: now
            }),
            lastLoginAt: now
        });

        // --- Người mời trực tiếp (A, cấp 1) ---
        tx.update(inviterRef, {
            inviteCount: FieldValue.increment(1),
            coins: FieldValue.increment(REFERRAL_REWARDS.DIRECT),
            inviteRewardsTotal: FieldValue.increment(REFERRAL_REWARDS.DIRECT),
            inviteHistory: FieldValue.arrayUnion({ uid: req.user.uid, at: now }),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'invite_direct',
                inviteeUid: req.user.uid,
                code,
                coins: REFERRAL_REWARDS.DIRECT,
                at: now
            })
        });

        return {
            inviterDisplayName: inviterData.displayName || 'Người chơi',
            inviteeCoinsAfter: (Number(inviteeData.coins) || 0) + REFERRAL_REWARDS.WELCOME,
            inviterCoinsAfter: (Number(inviterData.coins) || 0) + REFERRAL_REWARDS.DIRECT,
            grandUid, grandCoinsAfter
        };
    });

    return res.ok({
        codeUsed: code,
        codeType: 'user',
        inviter: { uid: inviterUid, displayName: result.inviterDisplayName },
        reward: {
            youReceived: REFERRAL_REWARDS.WELCOME,
            inviterReceived: REFERRAL_REWARDS.DIRECT,
            secondLevelReceived: result.grandUid ? REFERRAL_REWARDS.SECOND_LEVEL : 0,
            secondLevelEligible: !!result.grandUid
        },
        yourCoins: result.inviteeCoinsAfter
    }, 'Nhập mã mời thành công.');
}

/* ---------- Nhập mã hệ thống (PXE.../GNTU...) — quà tặng ---------- */
async function _useSystemCode(req, res, code) {
    const codeRef = SYSTEM_CODES().doc(code);
    const userRef = USERS().doc(req.user.uid);
    const now = Timestamp.now();

    const result = await db.runTransaction(async (tx) => {
        const [codeSnap, userSnap] = await Promise.all([tx.get(codeRef), tx.get(userRef)]);
        if (!userSnap.exists) {
            const e = new Error('USER_NOT_INITIALIZED'); e.code = ERROR_CODES.USER_NOT_INITIALIZED; e.status = 404; throw e;
        }
        if (!codeSnap.exists) {
            const e = new Error('CODE_NOT_FOUND'); e.code = ERROR_CODES.CODE_NOT_FOUND; e.status = 404; throw e;
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
        tx.update(userRef, {
            coins: FieldValue.increment(rewardCoins),
            usedSystemCodes: FieldValue.arrayUnion(code),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'system_code',
                code,
                prefix: cd.prefix || '',
                coins: rewardCoins,
                at: now
            }),
            lastLoginAt: now
        });
        return {
            rewardCoins,
            coinsAfter: (Number(userSnap.data().coins) || 0) + rewardCoins,
            note: cd.note || ''
        };
    });

    return res.ok({
        codeUsed: code,
        codeType: 'system',
        reward: { youReceived: result.rewardCoins },
        yourCoins: result.coinsAfter,
        note: result.note
    }, 'Nhập mã hệ thống thành công, phần thưởng đã được cộng.');
}

/* ------------------------------------------------------------
   GET /my-invites — Danh sách người đã nhập mã của tôi.
------------------------------------------------------------ */
router.get('/my-invites', verifyToken, async (req, res, next) => {
    try {
        let limit = parseInt(req.query.limit, 10) || 50;
        limit = Math.min(Math.max(limit, 1), 100);
        const snap = await USERS()
            .where('invitedBy', '==', req.user.uid)
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();
        const invites = snap.docs.map((d) => {
            const data = d.data();
            return {
                uid: d.id,
                displayName: data.displayName || 'Người chơi',
                avatar: data.avatar || '',
                createdAt: data.createdAt || null
            };
        });
        return res.ok({ invites, total: invites.length }, 'Lấy danh sách mời thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   GET /rewards — Xem mốc thưởng & tự động nhận (idempotent).
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
            return {
                rewards, inviteCount,
                coinsAfter: (Number(data.coins) || 0) + bonusTotal,
                claimedNow: toClaim.map((m) => ({ id: m.id, coins: m.coins })),
                bonusTotal
            };
        });
        const msg = result.claimedNow.length
            ? `Đã nhận ${result.bonusTotal} coin từ ${result.claimedNow.length} mốc thưởng.`
            : 'Lấy danh sách phần thưởng thành công.';
        return res.ok(result, msg);
    } catch (err) {
        if (err && err.code === ERROR_CODES.USER_NOT_INITIALIZED) {
            return res.fail('Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.', err.code, 404);
        }
        return next(err);
    }
});

/* ------------------------------------------------------------
   GET /history — Lịch sử nhận thưởng (50 mục gần nhất).
------------------------------------------------------------ */
router.get('/history', verifyToken, async (req, res, next) => {
    try {
        const snap = await USERS().doc(req.user.uid).get();
        if (!snap.exists) {
            return res.fail('Tài khoản chưa được khởi tạo.', ERROR_CODES.USER_NOT_INITIALIZED, 404);
        }
        const history = Array.isArray(snap.data().rewardsHistory) ? snap.data().rewardsHistory : [];
        return res.ok({ history: history.slice(-50).reverse(), total: history.length }, 'Lấy lịch sử thành công.');
    } catch (err) { return next(err); }
});

/* ------------------------------------------------------------
   POST /admin/system-code — (ADMIN) Tạo mã hệ thống.
   Body: { prefix?: 'PXE'|'GNTU', rewardCoins?: number, maxUses?: number, note?: string }
   Header: x-admin-secret: <ADMIN_SECRET>
------------------------------------------------------------ */
router.post('/admin/system-code', requireAdmin, async (req, res, next) => {
    try {
        const body = req.body || {};
        const prefix = [CODE_PREFIX.SYSTEM_PXE, CODE_PREFIX.SYSTEM_GNTU].includes(body.prefix)
            ? body.prefix
            : (Math.random() < 0.5 ? CODE_PREFIX.SYSTEM_PXE : CODE_PREFIX.SYSTEM_GNTU);
        const rewardCoins = Math.max(0, Math.min(100000, Number(body.rewardCoins) || 100));
        const maxUses = Math.max(1, Math.min(100000, Number(body.maxUses) || 1));
        const note = String(body.note || '').slice(0, 200);
        const code = await generateUniqueInviteCode(prefix);
        const now = Timestamp.now();
        await SYSTEM_CODES().doc(code).set({
            code, prefix, rewardCoins, maxUses, uses: 0, active: true,
            note, createdAt: now, createdBy: 'admin'
        });
        return res.ok({ code, prefix, rewardCoins, maxUses, note }, 'Tạo mã hệ thống thành công.', 201);
    } catch (err) { return next(err); }
});

module.exports = router;
