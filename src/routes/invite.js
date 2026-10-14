/* ============================================================
   src/routes/invite.js — /api/v1/invite
   GET    /my-code     Lấy mã mời của tôi (prefix AC-XXXXXX)
   POST   /use-code    Nhập mã (tự phân loại MÃ CODE vs MÃ MỜI)
   GET    /my-invites  Danh sách người tôi đã mời
   GET    /rewards     Mốc thưởng & tự nhận quà
   GET    /history     Lịch sử nhận thưởng
   POST   /admin/system-code  (ADMIN) Tạo mã (HY-/PXE-/GNTU-/ADM-)
   ------------------------------------------------------------
   PHÂN LOẠI MÃ (theo yêu cầu):
     MÃ CODE (quà tặng, KHÔNG khóa):
       HY-XXXXXX   → hệ thống, thưởng cơ bản 250 coin.
       PXE-/GNTU-  → sự kiện đặc biệt, thưởng tối thiểu 1000 coin.
       → Mỗi mã chỉ dùng 1 lần/user, nhưng nhập được nhiều mã khác nhau.
     MÃ MỜI (nhập 1 lần → KHÓA inviteUsed):
       ADM-XXXXXX  → mã của Admin, thưởng tối thiểu 900 coin (vd "thanh
                     linh" = 950, cao nhất). Lưu trong system_codes.
       AC-XXXXXX   → mã người dùng thường, người được mời nhận ≥100 coin.
                     Lưu trong users.inviteCode.
   ✅ Chấp nhận chỉnh sửa trực tiếp trên Firestore: khi admin sửa doc
      system_codes trực tiếp (Console / SDK), server đọc nguyên giá trị
      rewardCoins/active/maxUses trong doc — KHÔNG ép lại ngưỡng tối thiểu
      lúc nhập mã. Ngưỡng tối thiểu chỉ áp dụng khi tạo mã qua API admin.
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
    GIFT_PREFIXES,
    GIFT_CODE_DEFAULT_REWARD,
    GIFT_CODE_MIN_REWARD,
    ADMIN_CODE_MIN_REWARD,
    adminCodeRewardFor,
    generateUniqueInviteCode,
    classifyCode,
    codeVariants,
    REFERRAL_REWARDS,
    INVITE_MILESTONES,
    CODE_REGEX,
    sanitizeUser
} = require('../utils/helpers');
const router = express.Router();
const USERS = () => db.collection('users');
const SYSTEM_CODES = () => db.collection('system_codes');
/* Tìm doc system_codes tồn tại ĐẦU TIÊN trong các biến thể mã (chống nhầm
   dấu gạch ngang / gạch dưới khi admin tạo / sửa trực tiếp trên Firestore). */
async function resolveSystemCode(code) {
    const variants = codeVariants(code);
    for (const v of variants) {
        const snap = await SYSTEM_CODES().doc(v).get();
        if (snap.exists) return { code: v, data: snap.data() };
    }
    return null;
}
/* Bắt lỗi nghiệp vụ throw từ trong transaction → trả ĐÚNG mã lỗi + status,
   KHÔNG để rơi vào global handler (luôn trả 500 "Lỗi máy chủ nội bộ"). */
function handleCodeError(err, req, res, next) {
    if (err && err.code && err.status) {
        return res.fail(err.message || 'Có lỗi xảy ra.', err.code, err.status);
    }
    return next(err);
}
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
   POST /use-code — Tự phân loại:
   1. classifyCode → MÃ CODE (gift) hay MÃ MỜI (invite: admin/user).
   2. Gift (HY/PXE/GNTU) & Admin (ADM): tra cứu system_codes.
   3. User (AC): tra cứu users.inviteCode.
   ✅ Nếu admin sửa trực tiếp trên Firestore → giá trị trong doc được
      đọc nguyên vẹn (rewardCoins, active, maxUses) — server chấp nhận.
------------------------------------------------------------ */
router.post('/use-code', verifyToken, strictLimiter, async (req, res, next) => {
    try {
        const rawCode = (req.body && req.body.code) ? String(req.body.code) : '';
        const code = rawCode.trim().toUpperCase();
        if (!code || !CODE_REGEX.test(code)) {
            return res.fail('Mã không hợp lệ (3–24 ký tự chữ/số, có thể có dấu gạch ngang). Hợp lệ: HY / AC / PXE / GNTU / ADM + phần ngẫu nhiên.', ERROR_CODES.VALIDATION_ERROR, 400);
        }
        const kind = classifyCode(code);
        if (!kind) {
            return res.fail('Mã không tồn tại. Mã hợp lệ bắt đầu bằng HY-, PXE-, GNTU-, ADM- hoặc AC-.', ERROR_CODES.CODE_NOT_FOUND, 404);
        }
        if (kind.category === 'gift') {
            return await _useGiftCode(req, res, code, kind, next);
        }
        if (kind.type === 'admin') {
            return await _useAdminCode(req, res, code, kind, next);
        }
        // kind.type === 'user' → mã mời người dùng (AC-)
        return await _useUserCode(req, res, code, kind, next);
    } catch (err) { return next(err); }
});
/* ---------- MÃ CODE (HY-/PXE-/GNTU-) — KHÔNG khóa inviteUsed ----------
   Mỗi mã chỉ dùng 1 lần/user (usedSystemCodes). Nhập được nhiều mã khác
   nhau. Thưởng = rewardCoins trong doc (admin sửa trực tiếp trên Firestore
   thì server chấp nhận nguyên giá trị đó). */
async function _useGiftCode(req, res, code, kind, next) {
    const resolved = await resolveSystemCode(code);
    if (!resolved) {
        return res.fail('Mã không tồn tại. Mã hợp lệ bắt đầu bằng HY-, PXE- hoặc GNTU-.', ERROR_CODES.CODE_NOT_FOUND, 404);
    }
    const canonical = resolved.code;
    const codeRef = SYSTEM_CODES().doc(canonical);
    const userRef = USERS().doc(req.user.uid);
    const now = Timestamp.now();
    let result;
    try {
        result = await db.runTransaction(async (tx) => {
        const [codeSnap, userSnap] = await Promise.all([tx.get(codeRef), tx.get(userRef)]);
        if (!codeSnap.exists) {
            const e = new Error('CODE_NOT_FOUND'); e.code = ERROR_CODES.CODE_NOT_FOUND; e.status = 404; throw e;
        }
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
        if (used.includes(canonical)) {
            const e = new Error('CODE_ALREADY_USED'); e.code = ERROR_CODES.CODE_ALREADY_USED; e.status = 400; throw e;
        }
        // ✅ Chấp nhận chỉnh sửa trực tiếp trên Firestore: đọc nguyên rewardCoins.
        const rewardCoins = Number(cd.rewardCoins) || 0;
        tx.update(codeRef, { uses: FieldValue.increment(1), lastUsedAt: now });
        tx.update(userRef, {
            coins: FieldValue.increment(rewardCoins),
            usedSystemCodes: FieldValue.arrayUnion(canonical),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'gift_code', code: canonical, prefix: kind.prefix, coins: rewardCoins, at: now
            }),
            lastLoginAt: now
        });
        return { rewardCoins, coinsAfter: (Number(userSnap.data().coins) || 0) + rewardCoins, note: cd.note || '' };
        });
    } catch (err) { return handleCodeError(err, req, res, next); }
    return res.ok({
        codeUsed: code, codeCategory: 'gift', codeType: kind.type,
        reward: { youReceived: result.rewardCoins },
        yourCoins: result.coinsAfter,
        note: result.note,
        inviteLocked: false
    }, `Nhập mã ${kind.subtype} (${kind.prefix}-) thành công. Bạn vẫn nhập tiếp được các mã khác.`);
}
/* ---------- MÃ MỜI ADMIN (ADM-) — nhập 1 lần → KHÓA inviteUsed ----------
   Thưởng tối thiểu 900 coin (mỗi admin khác nhau; "thanh linh" = 950 cao
   nhất). Lưu trong system_codes. Admin sửa trực tiếp Firestore → chấp nhận. */
async function _useAdminCode(req, res, code, kind, next) {
    const resolved = await resolveSystemCode(code);
    if (!resolved) {
        return res.fail('Mã quản trị viên không tồn tại. Mã hợp lệ bắt đầu bằng ADM-.', ERROR_CODES.CODE_NOT_FOUND, 404);
    }
    const canonical = resolved.code;
    const codeRef = SYSTEM_CODES().doc(canonical);
    const userRef = USERS().doc(req.user.uid);
    const now = Timestamp.now();
    let result;
    try {
        result = await db.runTransaction(async (tx) => {
        const [codeSnap, userSnap] = await Promise.all([tx.get(codeRef), tx.get(userRef)]);
        if (!codeSnap.exists) {
            const e = new Error('CODE_NOT_FOUND'); e.code = ERROR_CODES.CODE_NOT_FOUND; e.status = 404; throw e;
        }
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
        const userData = userSnap.data();
        const bypass = !!userData.inviteBypass || userData.role === 'admin';
        const used = Array.isArray(userData.usedSystemCodes) ? userData.usedSystemCodes : [];
        if (used.includes(canonical)) {
            const e = new Error('CODE_ALREADY_USED'); e.code = ERROR_CODES.CODE_ALREADY_USED; e.status = 400; throw e;
        }
        if (!bypass && userData.inviteUsed) {
            const e = new Error('CODE_USED'); e.code = ERROR_CODES.CODE_USED; e.status = 400; throw e;
        }
        // ✅ Chấp nhận chỉnh sửa trực tiếp trên Firestore: đọc nguyên rewardCoins.
        const rewardCoins = Number(cd.rewardCoins) || 0;
        const adminName = cd.adminName || cd.ownerName || 'Quản trị viên';
        tx.update(codeRef, { uses: FieldValue.increment(1), lastUsedAt: now });
        tx.update(userRef, Object.assign({
            coins: FieldValue.increment(rewardCoins),
            usedSystemCodes: FieldValue.arrayUnion(canonical),
            invitedByAdmin: canonical,
            rewardsHistory: FieldValue.arrayUnion({
                type: 'admin_code', code: canonical, prefix: kind.prefix, adminName, coins: rewardCoins, at: now
            }),
            lastLoginAt: now
        }, bypass ? {} : { inviteUsed: true }));
        return {
            rewardCoins,
            coinsAfter: (Number(userData.coins) || 0) + rewardCoins,
            adminName,
            note: cd.note || '',
            bypass
        };
        });
    } catch (err) { return handleCodeError(err, req, res, next); }
    const locked = !result.bypass;
    return res.ok({
        codeUsed: code, codeCategory: 'invite', codeType: 'admin',
        adminName: result.adminName,
        reward: { youReceived: result.rewardCoins },
        yourCoins: result.coinsAfter,
        note: result.note,
        inviteLocked: locked
    }, locked
        ? 'Nhập mã quản trị viên thành công. Bạn không thể nhập mã mời của người khác nữa.'
        : 'Nhập mã quản trị viên thành công (tài khoản quản trị — vẫn nhập lại được).');
}
/* ---------- MÃ MỜI NGƯỜI DÙNG (AC-) — KHÓA inviteUsed ---------- */
async function _useUserCode(req, res, code, kind, next) {
    // Chấp nhận cả có / không dấu gạch ngang (vd AC-XXXXXX ↔ ACXXXXXX).
    const variants = codeVariants(code).slice(0, 10);
    const found = await USERS().where('inviteCode', 'in', variants).limit(1).get();
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
    let result;
    try {
        result = await db.runTransaction(async (tx) => {
        const [inviteeSnap, inviterSnap] = await Promise.all([tx.get(inviteeRef), tx.get(inviterRef)]);
        if (!inviteeSnap.exists) {
            const e = new Error('USER_NOT_INITIALIZED'); e.code = ERROR_CODES.USER_NOT_INITIALIZED; e.status = 404; throw e;
        }
        if (!inviterSnap.exists || !variants.includes(inviterSnap.data().inviteCode)) {
            const e = new Error('CODE_NOT_FOUND'); e.code = ERROR_CODES.CODE_NOT_FOUND; e.status = 404; throw e;
        }
        const inviteeData = inviteeSnap.data();
        const inviterData = inviterSnap.data();
        const canonical = inviterData.inviteCode || code;
        const inviteeBypass = !!inviteeData.inviteBypass || inviteeData.role === 'admin';
        if (!inviteeBypass && inviteeData.inviteUsed) {
            const e = new Error('CODE_USED'); e.code = ERROR_CODES.CODE_USED; e.status = 400; throw e;
        }
        let grandUid = null;
        const grandUidCandidate = inviterData.invitedBy || null;
        if (grandUidCandidate && grandUidCandidate !== req.user.uid && grandUidCandidate !== inviterUid) {
            const grandRef = USERS().doc(grandUidCandidate);
            const grandSnap = await tx.get(grandRef);
            if (grandSnap.exists) {
                grandUid = grandUidCandidate;
                tx.update(grandRef, {
                    coins: FieldValue.increment(REFERRAL_REWARDS.SECOND_LEVEL),
                    inviteRewardsTotal: FieldValue.increment(REFERRAL_REWARDS.SECOND_LEVEL),
                    rewardsHistory: FieldValue.arrayUnion({
                        type: 'invite_second_level', fromUid: req.user.uid, viaUid: inviterUid,
                        code: canonical, coins: REFERRAL_REWARDS.SECOND_LEVEL, at: now
                    })
                });
            }
        }
        tx.update(inviteeRef, Object.assign({
            invitedBy: inviterUid,
            coins: FieldValue.increment(REFERRAL_REWARDS.WELCOME),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'invite_welcome', inviterUid, code: canonical, coins: REFERRAL_REWARDS.WELCOME, at: now
            }),
            lastLoginAt: now
        }, inviteeBypass ? {} : { inviteUsed: true }));
        tx.update(inviterRef, {
            inviteCount: FieldValue.increment(1),
            coins: FieldValue.increment(REFERRAL_REWARDS.DIRECT),
            inviteRewardsTotal: FieldValue.increment(REFERRAL_REWARDS.DIRECT),
            inviteHistory: FieldValue.arrayUnion({ uid: req.user.uid, at: now }),
            rewardsHistory: FieldValue.arrayUnion({
                type: 'invite_direct', inviteeUid: req.user.uid, code: canonical, coins: REFERRAL_REWARDS.DIRECT, at: now
            })
        });
        return {
            inviterDisplayName: inviterData.displayName || 'Người chơi',
            inviteeCoinsAfter: (Number(inviteeData.coins) || 0) + REFERRAL_REWARDS.WELCOME,
            grandUid,
            inviteeBypass
        };
        });
    } catch (err) { return handleCodeError(err, req, res, next); }
    const locked = !result.inviteeBypass;
    return res.ok({
        codeUsed: code, codeCategory: 'invite', codeType: 'user',
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
/* ------------------------------------------------------------
   GET /my-invites
------------------------------------------------------------ */
router.get('/my-invites', verifyToken, async (req, res, next) => {
    try {
        let limit = parseInt(req.query.limit, 10) || 50;
        limit = Math.min(Math.max(limit, 1), 100);
        const snap = await USERS().where('invitedBy', '==', req.user.uid).limit(limit).get();
        const invites = snap.docs.map((d) => {
            const data = d.data();
            return { uid: d.id, displayName: data.displayName || 'Người chơi', avatar: data.avatar || '', createdAt: data.createdAt || null };
        });
        invites.sort((a, b) => {
            const ta = a.createdAt && a.createdAt._seconds ? a.createdAt._seconds : 0;
            const tb = b.createdAt && b.createdAt._seconds ? b.createdAt._seconds : 0;
            return tb - ta;
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
   POST /admin/system-code — (ADMIN) Tạo mã.
   Body: { code?, prefix?, rewardCoins?, maxUses?, note?, active?, adminName? }
   - prefix HY  → thưởng mặc định 250 (tối thiểu 250).
   - prefix PXE/GNTU → thưởng mặc định 1000 (tối thiểu 1000).
   - prefix ADM → thưởng mặc định theo admin (vd thanh linh = 950), tối thiểu 900.
   - Ngưỡng tối thiểu chỉ áp dụng ở đây; admin sửa trực tiếp Firestore thì
     server chấp nhận nguyên giá trị (xem _useGiftCode / _useAdminCode).
------------------------------------------------------------ */
router.post('/admin/system-code', optionalAuth, requireAdmin, async (req, res, next) => {
    try {
        const body = req.body || {};
        let code = body.code ? String(body.code).trim().toUpperCase() : null;
        if (code && !CODE_REGEX.test(code)) {
            return res.fail('Code không hợp lệ (4–24 ký tự chữ/số/dấu gạch ngang).', ERROR_CODES.VALIDATION_ERROR, 400);
        }
        const prefix = SYSTEM_PREFIXES.includes(body.prefix) ? body.prefix : CODE_PREFIX.SYSTEM_HY;
        const isAdminCode = prefix === CODE_PREFIX.ADMIN;
        // Mức thưởng đề xuất theo loại mã.
        let defaultReward = GIFT_CODE_DEFAULT_REWARD[prefix] || 250;
        let minReward = GIFT_CODE_MIN_REWARD[prefix] || 0;
        if (isAdminCode) {
            defaultReward = adminCodeRewardFor(body.adminName || (req.user && req.user.email) || '');
            minReward = ADMIN_CODE_MIN_REWARD;
        }
        let rewardCoins = Number(body.rewardCoins);
        if (!Number.isFinite(rewardCoins) || rewardCoins <= 0) rewardCoins = defaultReward;
        rewardCoins = Math.max(minReward, Math.min(100000, rewardCoins));
        const maxUses = Math.max(1, Math.min(1000000, Number(body.maxUses) || 1));
        const note = String(body.note || '').slice(0, 200);
        const adminName = String(body.adminName || (req.user && req.user.displayName) || '').slice(0, 60);
        const active = body.active === false ? false : true;
        if (!code) {
            code = await generateUniqueInviteCode(prefix);
        } else {
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
        const doc = {
            code, prefix,
            kind: isAdminCode ? 'admin' : 'gift',
            rewardCoins, maxUses, uses: 0,
            active, note,
            createdBy: (req.user && req.user.uid) || 'unknown',
            createdByEmail: (req.user && req.user.email) || '',
            createdAt: now
        };
        if (isAdminCode) {
            doc.adminName = adminName || (req.user && req.user.email) || 'Quản trị viên';
            doc.ownerUid = (req.user && req.user.uid) || null;
        }
        await SYSTEM_CODES().doc(code).set(doc);
        return res.ok({ code, prefix, kind: doc.kind, rewardCoins, maxUses, active, adminName: doc.adminName || null }, `Đã tạo mã ${prefix}- thành công.`);
    } catch (err) { return next(err); }
});
module.exports = router;
