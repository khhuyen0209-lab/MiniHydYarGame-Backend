# MiniGame HY — Backend API

Backend cho hệ thống **User & Mã mời** của MiniGame HY, xây dựng bằng **Node.js + Express + Firebase Admin SDK**. Client KHÔNG gọi trực tiếp Firestore — mọi request đều đi qua server này.

---

## 🚀 Cài đặt & Chạy

```bash
# 1. Cài dependencies
npm install

# 2. Tạo file .env từ mẫu
cp .env.example .env
# → Điền các biến FIREBASE_* (toàn bộ trường của file serviceAccountKey.json)

# 3. Chạy (dev)
npm run dev

# 4. Chạy (production)
npm start
```

Server mặc định chạy tại `http://localhost:8080`, prefix `/api/v1`.

### Lấy Firebase Service Account
Firebase Console → **Project Settings → Service accounts → Generate new private key** → tải file JSON về.

**Cách 1 (khuyến nghị cho Render):** đặt TỪNG TRƯỜNG của file JSON thành biến môi trường (tiền tố `FIREBASE_`). `private_key` dán THẲNG luôn (kể cả chứa `\n` — code tự chuyển thành xuống dòng thật):

| Biến môi trường | Trường trong file JSON |
|---|---|
| `FIREBASE_TYPE` | `type` |
| `FIREBASE_PROJECT_ID` | `project_id` |
| `FIREBASE_PRIVATE_KEY_ID` | `private_key_id` |
| `FIREBASE_PRIVATE_KEY` | `private_key` (dán nguyên chuỗi, có `\n`) |
| `FIREBASE_CLIENT_EMAIL` | `client_email` |
| `FIREBASE_CLIENT_ID` | `client_id` |
| `FIREBASE_AUTH_URI` | `auth_uri` |
| `FIREBASE_TOKEN_URI` | `token_uri` |
| `FIREBASE_AUTH_PROVIDER_X509_CERT_URL` | `auth_provider_x509_cert_url` |
| `FIREBASE_CLIENT_X509_CERT_URL` | `client_x509_cert_url` |
| `FIREBASE_UNIVERSE_DOMAIN` | `universe_domain` |

**Cách 2 (nhanh, 1 biến duy nhất):** đặt `FIREBASE_SERVICE_ACCOUNT` = toàn bộ nội dung file JSON (hoặc base64 của cả file — code tự nhận diện). Nếu dùng biến này thì KHÔNG cần các biến `FIREBASE_*` ở trên.

---

## 📁 Cấu trúc thư mục

```
minigame-hy-backend/
├── package.json
├── .env.example
├── .gitignore
├── README.md
└── src/
    ├── index.js              # Khởi động server + error handler tập trung
    ├── config/
    │   └── firebase.js       # Kết nối Firebase Admin (singleton)
    ├── middleware/
    │   ├── auth.js           # verifyToken / optionalAuth (lấy uid từ token)
    │   └── limiter.js        # Chống spam (apiLimiter + strictLimiter)
    ├── routes/
    │   ├── user.js           # /api/v1/user/*
    │   └── invite.js         # /api/v1/invite/*
    └── utils/
        └── helpers.js        # Response thống nhất, sinh mã mời, mốc thưởng…
```

---

## 🔄 Quy ước API

- **Base URL**: `${APP_HOST}/api/v1` — mặc định `https://minihydyargame-backend.onrender.com/api/v1`. Đổi host chỉ cần set biến môi trường `APP_HOST` (không cần sửa code).
- **Xác thực**: Header `Authorization: Bearer <idToken>`
  - Client lấy token từ Firebase Auth: `const idToken = await firebase.auth().currentUser.getIdToken()`
- **Response thống nhất mọi API**:
  ```json
  {
    "success": true,
    "message": "Thông báo rõ ràng",
    "data": { },
    "error": null
  }
  ```

### Mã lỗi (`error` field)
| Code | Ý nghĩa | HTTP |
|---|---|---|
| `AUTH_REQUIRED` | Thiếu header Authorization | 401 |
| `AUTH_INVALID` | Token sai/hết hạn/bị thu hồi → cần đăng nhập lại | 401 |
| `VALIDATION_ERROR` | Body/param không hợp lệ | 400 |
| `USER_NOT_INITIALIZED` | Chưa gọi `POST /user/init` | 404 |
| `CODE_NOT_FOUND` | Mã mời không tồn tại | 404 |
| `CODE_OWN` | Nhập mã của chính mình | 400 |
| `CODE_USED` | Đã nhập mã mời rồi (chỉ 1 lần) | 400 |
| `RATE_LIMITED` | Quá nhiều yêu cầu | 429 |
| `SERVER_ERROR` | Lỗi máy chủ | 500 |

---

## 📋 Danh sách API

### 👤 User — `/api/v1/user`

| Method | Endpoint | Mô tả | Body / Query |
|---|---|---|---|
| `POST` | `/init` | Tạo tài khoản lần đầu (idempotent) | `{ displayName? }` |
| `GET` | `/profile` | Lấy hồ sơ cá nhân | — |
| `PATCH` | `/profile` | Cập nhật thông tin cơ bản | `{ displayName?, avatar?, bio? }` |
| `GET` | `/stats` | Số liệu: tổng game, điểm cao, số mời, coin | — |

### 🎁 Invite — `/api/v1/invite`

| Method | Endpoint | Mô tả | Body / Query |
|---|---|---|---|
| `GET` | `/my-code` | Lấy mã mời của tôi | — |
| `POST` | `/use-code` | Nhập & sử dụng mã mời người khác | `{ code }` |
| `GET` | `/my-invites` | Danh sách người tôi đã mời | `?limit=50` |
| `GET` | `/rewards` | Xem mốc thưởng & tự động nhận quà | — |

---

## 🔐 Quy tắc an toàn (đã triển khai)

- ✅ **Client không gọi trực tiếp Firestore** — mọi thao tác qua API này.
- ✅ Mọi route `/user` và `/invite` đều qua middleware `verifyToken`.
- ✅ Server **luôn lấy `uid` từ token**, bỏ qua hoàn toàn `uid` client gửi.
- ✅ Dùng **Firestore Transaction** cho `POST /use-code` và `GET /rewards` (cộng coin).
- ✅ Mã mời chỉ nhập **1 lần duy nhất** (`inviteUsed`).
- ✅ **Không thể nhập mã của chính mình**.
- ✅ `PATCH /profile` chỉ cho phép field trắng danh (không sửa được coin/invite).
- ✅ Rate-limit: 200 req/15p chung, 10 req/giờ cho `/init` & `/use-code`.
- ✅ Body giới hạn 1MB, helmet, CORS cấu hình theo env.

---

## 📝 Dữ liệu trong Firestore — `users/{uid}`

```json
{
  "uid": "abc123",
  "email": "user@email.com",
  "displayName": "Tên người chơi",
  "avatar": "",
  "bio": "",
  "createdAt": "Timestamp",
  "lastLoginAt": "Timestamp",

  "inviteCode": "ABC123",
  "invitedBy": "uid_nguoi_moi",
  "inviteUsed": false,
  "inviteCount": 0,
  "inviteRewardsTotal": 0,
  "inviteHistory": [{ "uid": "...", "at": "Timestamp" }],
  "claimedMilestones": ["m3", "m5"],

  "coins": 0,
  "settings": {},
  "library": [],
  "highScores": { "block-puzzle": 1250 }
}
```

> `claimedMilestones` là field bổ sung để theo dõi mốc thưởng đã nhận (tránh cộng trùng).

### Mốc thưởng (có thể chỉnh trong `src/utils/helpers.js → INVITE_MILESTONES`)
| Mốc | Số lượt mời | Coin thưởng |
|---|---|---|
| m3 | 3 | 200 |
| m5 | 5 | 300 |
| m10 | 10 | 500 |
| m25 | 25 | 1500 |
| m50 | 50 | 4000 |

---

## 🔧 Ví dụ gọi API (client)

```js
const idToken = await firebase.auth().currentUser.getIdToken();

// 1. Khởi tạo tài khoản sau khi đăng nhập
await fetch('https://minihydyargame-backend.onrender.com/api/v1/user/init', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
  body: JSON.stringify({ displayName: 'Player One' })
});

// 2. Nhập mã mời
const res = await fetch('https://minihydyargame-backend.onrender.com/api/v1/invite/use-code', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
  body: JSON.stringify({ code: 'ABC123' })
});
const { success, message, data, error } = await res.json();
```

---

## ☁️ Deploy gợi ý

- **Google Cloud Run** / **Render** / **Railway** / **VPS** (bất kỳ nơi nào chạy Node ≥ 18).
- Set các biến môi trường trong `.env.example` lên platform deploy.
- **`APP_HOST`** = domain công khai của backend (vd `https://minihydyargame-backend.onrender.com`). Sau này đổi host chỉ cần sửa biến này, KHÔNG cần đụng code.
- Cập nhật `CORS_ORIGIN` thành domain frontend của bạn (vd `https://minigame-hy.web.app`). Lưu ý: `CORS_ORIGIN` là domain FRONTEND, khác với `APP_HOST` (domain của backend).
- **Quan trọng**: khi chuyển sang kiến trúc backend này, hãy khóa Firestore Rules về chỉ cho admin (từ chối client đọc/ghi trực tiếp) để đảm bảo đúng nguyên tắc "client không gọi Firestore".
