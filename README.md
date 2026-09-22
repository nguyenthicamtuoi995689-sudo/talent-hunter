# Talent Hunter — Exa + Gemini (free)

Web app tự động **tìm profile ứng viên thật** trên nhiều nền tảng (LinkedIn/web professional profiles qua Exa People Search, GitHub, TopDev, Vieclam24h, Ybox, portfolio…) rồi **chấm điểm độ phù hợp theo Job Description** bằng Gemini (free tier của Google). Deploy **miễn phí** trên Vercel.

## Cách hoạt động

```
Trình duyệt (public/index.html)
        │  POST /api/hunt  { jd, position, skills, location, ... }
        ▼
Vercel Serverless (api/hunt.js)
        │  1) Gọi Exa API  → tìm profile thật trên nhiều nền tảng (song song)
        │  2) Gọi Gemini API (free) → trích xuất tên/contact/skills + chấm điểm theo JD
        ▼
Trả JSON danh sách ứng viên đã xếp hạng → hiển thị trên web
```

API key **không nằm trong code**, chỉ đặt trong Environment Variables của Vercel → an toàn.

---

## Chuẩn bị (5 phút)

### 1. Lấy Exa API key
- Vào https://dashboard.exa.ai/api-keys → tạo key (có free credit để test).

### 2. Lấy Gemini (Google) API key — MIỄN PHÍ, không cần thẻ
- Vào https://aistudio.google.com/app/apikey → đăng nhập Google.
- Bấm **Create API key** (chọn/ tạo một Google Cloud project khi được hỏi).
- Copy key (dạng `AIza...`). Free tier ~1.500 lượt/ngày với Flash — quá đủ để hunt.

---

## Deploy lên Vercel — Cách A: qua GitHub (khuyên dùng)

1. Tạo repo mới trên GitHub, upload toàn bộ thư mục này lên (giữ nguyên cấu trúc).
2. Vào https://vercel.com → **Add New… → Project** → chọn repo vừa tạo → **Import**.
3. Ở bước cấu hình, mở **Environment Variables**, thêm 2 biến:
   - `EXA_API_KEY` = key Exa của bạn
   - `GEMINI_API_KEY` = key Gemini của bạn
   - (tùy chọn) `GEMINI_MODEL` = `gemini-2.5-flash`
4. Bấm **Deploy**. Xong sẽ có link dạng `https://your-app.vercel.app`.

> Nếu quên thêm env var trước khi deploy: vào **Project → Settings → Environment Variables**, thêm rồi **Redeploy**.

## Deploy lên Vercel — Cách B: qua CLI (không cần GitHub)

```bash
npm i -g vercel          # cài Vercel CLI (một lần)
cd recruiting-hunter     # vào thư mục dự án
vercel                   # làm theo hướng dẫn, đăng nhập
# thêm biến môi trường:
vercel env add EXA_API_KEY
vercel env add GEMINI_API_KEY
vercel --prod            # deploy production
```

## Chạy thử ở máy (local)

```bash
npm i -g vercel
cp .env.example .env.local   # điền 2 key vào .env.local
vercel dev                   # mở http://localhost:3000
```

---

## Cấu trúc dự án

```
recruiting-hunter/
├── api/
│   └── hunt.js          # Serverless: Exa + Gemini
├── public/
│   └── index.html       # Giao diện
├── package.json
├── vercel.json          # timeout 60s cho function
├── .env.example
└── README.md
```

## Tinh chỉnh

- **Đổi model:** đặt env `GEMINI_MODEL`. `gemini-2.5-flash` (mặc định, cân bằng) hoặc `gemini-2.5-flash-lite` (quota free cao hơn, nhanh hơn). Cả hai đều thuộc free tier.
- **Thêm/bớt nền tảng:** sửa mảng `includeDomains` trong `api/hunt.js` (hàm `huntProfiles`). Ví dụ thêm `itviec.com`, `careerviet.vn`…
- **Số kết quả mỗi nền tảng:** đổi `perPlatform` (gửi từ frontend) hoặc chặn cứng trong handler.
- **Trọng số chấm điểm:** sửa công thức trong `system` prompt ở `scoreWithGemini` (mặc định 40% skills / 30% kinh nghiệm / 15% tình trạng / 15% vị trí).

## Lưu ý pháp lý & thực tế

- Công cụ chỉ truy xuất **thông tin công khai** do Exa index. Email/SĐT chỉ hiện khi ứng viên tự công khai.
- Hãy dùng dữ liệu ứng viên đúng quy định (PDPD Việt Nam / GDPR nếu áp dụng) và chỉ cho mục đích tuyển dụng hợp pháp.
- LinkedIn và nhiều trang có điều khoản riêng về việc liên hệ; tôn trọng lựa chọn nhận liên hệ của ứng viên.

## Sự cố thường gặp

| Lỗi | Nguyên nhân / cách xử lý |
|-----|--------------------------|
| `Thiếu API key…` | Chưa set env var trên Vercel, hoặc set xong chưa Redeploy. |
| `Exa API error (401)` | Sai `EXA_API_KEY`. |
| `Gemini API error (401/403)` | Sai `GEMINI_API_KEY`. |
| `Gemini API error (429)` | Chạm rate limit free tier — chờ vài giây rồi thử lại, hoặc đổi sang `gemini-2.5-flash-lite`. |
| Function timeout | Giảm `perPlatform`, hoặc giữ `maxDuration` 60 trong `vercel.json` (Hobby cho tối đa 60s). |
| Ít/không có kết quả | Nới lỏng vị trí/kỹ năng, bỏ trống nơi làm việc, hoặc tăng `perPlatform`. |
