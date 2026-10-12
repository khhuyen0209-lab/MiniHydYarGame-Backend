/* ============================================================
   src/routes/invite.js — /api/v1/invite
   GET    /my-code     Lấy mã mời của tôi
   POST   /use-code    Nhập & sử dụng mã mời của người khác
   GET    /my-invites  Xem danh sách người tôi đã mời
   GET    /rewards     Xem phần thưởng & tự động nhận quà mốc
   ============================================================ */
'use strict';

const express = require('express');
const { db, FieldValue, Timestamp } = require('../config/firebase');
const { verifyToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/limiter');
const {
    ERROR_CODES,
    generateUniqueInviteCode,
    INVITE_MILESTONES,
    sanitizeUser
} = require('../utils/helpers');

const router = express.Router();

// ✅ Mọi route trong này đều phải qua verifyToken.
router.use(verifyToken);

const USERS = () => db.collection('users');

const REWARD_COINS = Number(process.env.INVITE_REWARD_COINS) || 100;
const WELCOME_COINS = Number(process.env.INVITE_WELCOME_COINS) || 50;

/* ------------------------------------------------------------
   GET /my-code — Trả mã mời của user. Nếu tài khoản cũ chưa có
   (tạo trước khi có hệ thống mã mời) → sinh và lưu ngay.
------------------------------------------------------------ */
router.get('/my-code', async (req, res, next) => {
    try {
        const userRef = USERS().doc(req.user.uid);
        const snap = await userRef.get();
        if (!snap.exists) {
            return res.fail(
                'Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.',
                ERROR_CODES.USER_NOT_INITIALIZED,
                404
            );
        }

        let inviteCode = snap.data().inviteCode;
        if (!inviteCode) {
            inviteCode = await generateUniqueInviteCode(6);
            await userRef.update({ inviteCode });
        }

        return res.ok(
            { inviteCode, inviteCount: Number(snap.data().inviteCount) || 0 },
            'Lấy mã mời thành công.'
        );
    } catch (err) {
        return next(err);
    }
});

/* ------------------------------------------------------------
   POST /use-code — Nhập mã mời của người khác.
   Body: { code: "ABC123" }
   Quy tắc (transaction để đảm bảo nguyên tử):
   - Mã phải tồn tại.
   - Không được nhập mã của chính mình.
   - Mỗi user chỉ được nhập 1 lần (inviteUsed).
   - Cộng coin cho cả người mời và người được mời.
------------------------------------------------------------ */
router.post('/use-code', strictLimiter, async (req, res, next) => {
    try {
        const rawCode = (req.body && req.body.code) ? String(req.body.code) : '';
        const code = rawCode.trim().toUpperCase();

        if (!code || !/^[A-Z0-9]{4,12}$/.test(code)) {
            return res.fail(
                'Mã mời không hợp lệ (4–12 ký tự chữ/số).',
                ERROR_CODES.VALIDATION_ERROR,
                400
            );
        }

        // Tìm chủ mã mời (query NGOÀI transaction, sẽ kiểm tra lại BÊN TRONG transaction).
        const found = await USERS().where('inviteCode', '==', code).limit(1).get();
        if (found.empty) {
            return res.fail(
                'Mã mời không tồn tại.',
                ERROR_CODES.CODE_NOT_FOUND,
                404
            );
        }
        const inviterRef = found.docs[0].ref;
        const inviterUid = found.docs[0].id;

        // ❌ Không thể nhập mã của chính mình.
        if (inviterUid === req.user.uid) {
            return res.fail(
                'Bạn không thể nhập mã mời của chính mình.',
                ERROR_CODES.CODE_OWN,
                400
            );
        }

        const inviteeRef = USERS().doc(req.user.uid);
        const now = Timestamp.now();

        // ✅ Dùng Transaction cho mọi thao tác cộng/trừ coin/điểm.
        const result = await db.runTransaction(async (tx) => {
            const [inviteeSnap, inviterSnap] = await Promise.all([
                tx.get(inviteeRef),
                tx.get(inviterRef)
            ]);

            if (!inviteeSnap.exists) {
                const e = new Error('USER_NOT_INITIALIZED');
                e.code = ERROR_CODES.USER_NOT_INITIALIZED;
                e.status = 404;
                throw e;
            }
            if (!inviterSnap.exists || inviterSnap.data().inviteCode !== code) {
                const e = new Error('CODE_NOT_FOUND');
                e.code = ERROR_CODES.CODE_NOT_FOUND;
                e.status = 404;
                throw e;
            }

            // ❌ Mã mời chỉ được nhập 1 lần duy nhất.
            if (inviteeSnap.data().inviteUsed) {
                const e = new Error('CODE_USED');
                e.code = ERROR_CODES.CODE_USED;
                e.status = 400;
                throw e;
            }

            // Cập nhật người được mời (invitee).
            tx.update(inviteeRef, {
                invitedBy: inviterUid,
                inviteUsed: true,
                coins: FieldValue.increment(WELCOME_COINS),
                lastLoginAt: now
            });

            // Cập nhật người mời (inviter): cộng lượt mời + coin + lịch sử.
            tx.update(inviterRef, {
                inviteCount: FieldValue.increment(1),
                coins: FieldValue.increment(REWARD_COINS),
                inviteRewardsTotal: FieldValue.increment(REWARD_COINS),
                inviteHistory: FieldValue.arrayUnion({
                    uid: req.user.uid,
                    at: now
                })
            });

            return {
                inviterDisplayName: inviterSnap.data().displayName || 'Người chơi',
                inviteeCoinsAfter: (Number(inviteeSnap.data().coins) || 0) + WELCOME_COINS,
                inviterCoinsAfter: (Number(inviterSnap.data().coins) || 0) + REWARD_COINS
            };
        });

        return res.ok({
            codeUsed: code,
            inviter: {
                uid: inviterUid,
                displayName: result.inviterDisplayName
            },
            reward: {
                youReceived: WELCOME_COINS,
                inviterReceived: REWARD_COINS
            },
            yourCoins: result.inviteeCoinsAfter
        }, 'Nhập mã mời thành công.');
    } catch (err) {
        // Lỗi nghiệp vụ throw trong transaction → trả về định dạng thống nhất.
        if (err && err.code && Object.values(ERROR_CODES).includes(err.code)) {
            const messages = {
                [ERROR_CODES.USER_NOT_INITIALIZED]: 'Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.',
                [ERROR_CODES.CODE_NOT_FOUND]: 'Mã mời không tồn tại.',
                [ERROR_CODES.CODE_USED]: 'Bạn đã nhập mã mời rồi (chỉ được nhập 1 lần).'
            };
            return res.fail(
                messages[err.code] || 'Có lỗi xảy ra.',
                err.code,
                err.status || 400
            );
        }
        return next(err);
    }
});

/* ------------------------------------------------------------
   GET /my-invites — Danh sách người đã nhập mã của tôi.
   Query: ?limit=50 (tối đa 100)
------------------------------------------------------------ */
router.get('/my-invites', async (req, res, next) => {
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

        return res.ok(
            { invites, total: invites.length },
            'Lấy danh sách mời thành công.'
        );
    } catch (err) {
        return next(err);
    }
});

/* ------------------------------------------------------------
   GET /rewards — Xem các mốc thưởng & TỰ ĐỘNG NHẬN quà cho những
   mốc đã đạt nhưng chưa nhận (idempotent, dùng transaction).
   claimedMilestones lưu id mốc đã nhận để tránh cộng trùng.
------------------------------------------------------------ */
router.get('/rewards', async (req, res, next) => {
    try {
        const userRef = USERS().doc(req.user.uid);

        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(userRef);
            if (!snap.exists) {
                const e = new Error('USER_NOT_INITIALIZED');
                e.code = ERROR_CODES.USER_NOT_INITIALIZED;
                e.status = 404;
                throw e;
            }

            const data = snap.data();
            const inviteCount = Number(data.inviteCount) || 0;
            const claimed = Array.isArray(data.claimedMilestones) ? data.claimedMilestones : [];

            // Các mốc đủ điều kiện & chưa nhận → tự động cộng coin.
            const toClaim = INVITE_MILESTONES.filter(
                (m) => inviteCount >= m.required && !claimed.includes(m.id)
            );

            let bonusTotal = 0;
            if (toClaim.length > 0) {
                bonusTotal = toClaim.reduce((sum, m) => sum + m.coins, 0);
                tx.update(userRef, {
                    coins: FieldValue.increment(bonusTotal),
                    inviteRewardsTotal: FieldValue.increment(bonusTotal),
                    claimedMilestones: FieldValue.arrayUnion(...toClaim.map((m) => m.id))
                });
            }

            const rewards = INVITE_MILESTONES.map((m) => {
                const isClaimed = claimed.includes(m.id) ||
                    toClaim.some((c) => c.id === m.id);
                return {
                    id: m.id,
                    label: m.label,
                    requiredInvites: m.required,
                    coins: m.coins,
                    achieved: inviteCount >= m.required,
                    claimed: isClaimed
                };
            });

            return {
                rewards,
                inviteCount,
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
            return res.fail(
                'Tài khoản chưa được khởi tạo. Gọi POST /user/init trước.',
                err.code,
                404
            );
        }
        return next(err);
    }
});

module.exports = router;
