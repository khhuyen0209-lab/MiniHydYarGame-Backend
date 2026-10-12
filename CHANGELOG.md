# CHANGELOG — MiniGame HY Backend (đã sửa đổi)

## Thay đổi chính

### 1. Mọi thay đổi Firestore đều qua API (client bị khóa hoàn toàn)
- Thêm `GET /user/sync` và `POST /user/sync` — client kéo/đẩy dữ liệu đồng bộ
  (profile, settings, library, progress) QUA API, KHÔNG còn ghi trực tiếp Firestore.
- Thêm route `POST /feedback` — thay thế cho việc client ghi trực tiếp collection `feedback`.
- `firestore.rules` (ở frontend) đã khóa hoàn toàn: `allow read, write: if false` cho mọi tài liệu.
  Backend dùng Firebase Admin SDK → bypass rules, đọc/ghi bình thường.

### 2. Hệ thống mã mời đầy đủ
- **Định dạng mã**:
  - Mã người dùng: prefix `HY` + 6 ký tự ngẫu nhiên (vd `HY7K2M9P`).
  - Mã hệ thống (promo/quà tặng): prefix `PXE` hoặc `GNTU` + 6 ký tự ngẫu nhiên
    (vd `PXEQ7W2K4`, `GNTU5M8X1`).
  - Bảng chữ cái loại ký tự dễ nhầm (0/O, 1/I/L). Kiểm tra trùng trong cả `users` lẫn `system_codes`.
- **Khi tạo tài khoản** (`POST /user/init`): tự động sinh mã mời `HY...` + các field mặc định
  (`usedSystemCodes: []`, `rewardsHistory: []`, `progress: {}`).
- **Nhập mã** (`POST /invite/use-code`): server tự phân loại mã.
  - Mã người dùng: kiểm tra đã nhập chưa (chỉ 1 lần), không tự nhập mã mình,
    **thưởng đệ quy 2 cấp** trong Firestore Transaction:
    - Người được mời: +`INVITE_WELCOME_COINS` (mặc định 50).
    - Người mời trực tiếp (cấp 1): +`INVITE_REWARD_COINS` (mặc định 100).
    - Người mời của người mời (cấp 2, nếu có): +`REFERRAL_SECOND_LEVEL_COINS` (mặc định 20).
  - Mã hệ thống: kiểm tra tồn tại, còn kích hoạt, chưa hết lượt dùng (`maxUses`),
    người dùng chưa từng dùng mã này (`usedSystemCodes`). Cộng coin cho người nhập.
- **Lịch sử**: mọi giao dịch thưởng được ghi vào `rewardsHistory` (mỗi user).
  Xem qua `GET /invite/history`.
- **Mốc thưởng**: giữ nguyên 5 mốc (3/5/10/25/50 lượt mời), tự động nhận khi gọi `GET /invite/rewards`,
  có `claimedMilestones` chống cộng trùng.
- **Admin tạo mã hệ thống**: `POST /invite/admin/system-code`
  (header `x-admin-secret: <ADMIN_SECRET>`). Body: `{ prefix?, rewardCoins?, maxUses?, note? }`.
  Mã lưu ở collection `system_codes`.

### 3. Endpoint mới
| Method | Endpoint | Mô tả |
|---|---|---|
| GET | `/user/sync` | Kéo dữ liệu đồng bộ (thay thế đọc Firestore trực tiếp) |
| POST | `/user/sync` | Đẩy dữ liệu đồng bộ (merge sâu, validate kích thước) |
| POST | `/feedback` | Gửi phản hồi (thay thế ghi Firestore trực tiếp) |
| GET | `/invite/history` | Lịch sử nhận thưởng |
| POST | `/invite/admin/system-code` | (Admin) Tạo mã hệ thống PXE/GNTU |

### 4. Biến môi trường mới (`.env.example`)
- `REFERRAL_SECOND_LEVEL_COINS=20` — thưởng đệ quy cấp 2.
- `ADMIN_SECRET=` — bí mật admin (tạo mã hệ thống). Bỏ trống → vô hiệu hóa.

### 5. Bảo mật
- Mọi route `/user`, `/invite` (trừ admin) đều qua `verifyToken` — uid lấy từ token.
- `POST /user/sync` validate chặt: profile chỉ 3 field, settings ≤20KB, library ≤200 id,
  progress ≤100 key (phải bắt đầu `mghy-`). Tự đồng bộ `highScores` từ progress điểm cao.
- Rate-limit giữ nguyên (200 req/15p chung, 10 req/giờ cho init/use-code/feedback).
