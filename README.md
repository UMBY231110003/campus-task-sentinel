# Campus Task Sentinel

Automated Node.js monitor for campus assignments — runs **without human interaction**: portal login (Playwright + Gmail magic link), e-learning scrape, local assignment parsing, Google Sheets deduplication, and Telegram alerts.

## Alur Kerja

1. Login `PORTAL_URL` dengan username/password
2. Jika muncul verifikasi email → ambil magic link dari Gmail → buka link
3. Buka halaman E-Learning → ambil daftar course, kalender, dan aktivitas
4. Parse lokal untuk mengekstrak tugas/kuis
5. Bandingkan `id` dengan Google Sheets → hanya tugas baru
6. Kirim ke Telegram → simpan `id` ke Sheets

## Struktur Proyek

```
campus-task-sentinel/
├── index.js                 # Entry point alur utama
├── package.json
├── .env.example
├── scripts/
│   └── authorize-gmail.js   # One-time OAuth Gmail
├── src/
│   ├── portal.js            # Playwright login + scrape
│   ├── gmail.js             # Ambil magic link dari Gmail
│   ├── analyzer.js          # Parse tugas dari hasil scrape
│   ├── sheets.js            # Memori deduplikasi
│   ├── telegram.js          # Notifikasi Telegram
│   └── googleAuth.js        # Auth Google
├── credentials/             # Jangan di-commit!
│   ├── google-credentials.json
│   └── gmail-token.json
└── .github/workflows/
    └── campus-task-sentinel.yml
```

## Setup Lokal (langkah demi langkah)

### 1. Clone & install

```bash
cd campus-task-sentinel
cp .env.example .env
npm install
npm run setup:browser
```

Isi `.env` sesuai portal/Telegram Anda. Sesuaikan selector CSS (`PORTAL_SELECTOR_*`, `ELEARNING_*`) dengan HTML portal kampus (Inspect Element).

### 2. Telegram Bot

1. Chat [@BotFather](https://t.me/BotFather) → `/newbot` → salin token ke `TELEGRAM_BOT_TOKEN`
2. Chat bot Anda sekali, lalu buka `https://api.telegram.org/bot<TOKEN>/getUpdates` untuk mendapat `TELEGRAM_CHAT_ID` (atau gunakan ID grup)

### 3. Google Cloud — Gmail API + Sheets API

#### 4a. Buat project & aktifkan API

1. Buka [Google Cloud Console](https://console.cloud.google.com/)
2. Buat project baru (mis. `campus-task-sentinel`)
3. **APIs & Services → Library** → aktifkan:
   - **Gmail API**
   - **Google Sheets API**
4. **APIs & Services → OAuth consent screen**
   - User type: **External** (atau Internal jika Workspace)
   - Isi app name, email support
   - Scopes: `gmail.readonly`, `spreadsheets`
   - Tambahkan email Gmail Anda sebagai **Test user** (mode Testing)

#### 4b. Buat OAuth Client (untuk Gmail + Sheets via akun user)

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Desktop app**
3. Download JSON → simpan sebagai `credentials/google-credentials.json`

#### 4c. Authorize sekali (hasilkan token)

```bash
node scripts/authorize-gmail.js
```

- Buka URL yang dicetak di browser
- Login dengan akun Gmail yang menerima OTP kampus
- Izinkan akses → salin kode → tempel di terminal
- File `credentials/gmail-token.json` akan dibuat

> **Catatan:** Gmail API **tidak bisa** membaca inbox pribadi dengan Service Account tanpa Domain-Wide Delegation (Google Workspace). Untuk mahasiswa biasa, pakai OAuth2 seperti di atas.

#### 4d. Google Sheet sebagai memori

1. Buat spreadsheet baru di [Google Sheets](https://sheets.google.com)
2. Baris 1 (header opsional): `id | matkul | judul_tugas | deadline | sent_at`
3. Salin Spreadsheet ID dari URL:
   `https://docs.google.com/spreadsheets/d/<<<GOOGLE_SHEET_ID>>>/edit`
4. **Share** spreadsheet ke email Google yang sama dengan yang diotorisasi OAuth (Editor)

### 5. Sesuaikan selector portal

Portal tiap kampus berbeda. Contoh di `.env`:

```env
PORTAL_SELECTOR_USERNAME=#username
PORTAL_SELECTOR_PASSWORD=#password
PORTAL_SELECTOR_SUBMIT=button[type="submit"]
PORTAL_SELECTOR_OTP_INPUT=input[name="otp"]
PORTAL_SELECTOR_OTP_SUBMIT=button[type="submit"]
ELEARNING_URL=https://elearning.kampus.ac.id/my/
ELEARNING_SELECTOR=.assignment-overview, #region-main
GMAIL_OTP_FROM=noreply@kampus.ac.id
GMAIL_OTP_SUBJECT=OTP
```

Untuk debug lokal, set `PLAYWRIGHT_HEADLESS=false`.

### 6. Jalankan

```bash
npm start
```

## Online gratis (tanpa laptop) — GitHub Actions

Ini opsi gratis terbaik untuk bot ini: GitHub menjalankan workflow di cloud tiap 2 jam (bisa diubah).

### Kenapa GitHub Actions?
- **Gratis** (repo public sangat longgar; private punya kuota menit bulanan)
- Sudah ada file `.github/workflows/campus-task-sentinel.yml`
- Sesi login di-cache agar tidak selalu butuh magic link

### Langkah setup

**1. Buat repo GitHub** (public lebih hemat kuota), lalu di folder proyek:

```bash
cd campus-task-sentinel
git init
git add .
git commit -m "Initial Campus Task Sentinel"
git branch -M main
git remote add origin https://github.com/USERNAME/campus-task-sentinel.git
git push -u origin main
```

Jangan commit `.env` / `credentials/*.json` (sudah di `.gitignore`).

**2. Isi Secrets** — repo → **Settings → Secrets and variables → Actions**

| Secret | Isi (dari `.env` / file lokal) |
|--------|--------------------------------|
| `PORTAL_URL` | `https://sso.mercubuana-yogya.ac.id` |
| `PORTAL_USERNAME` | NIM |
| `PORTAL_PASSWORD` | password |
| `PORTAL_SELECTOR_USERNAME` | `input[name="username"]` |
| `PORTAL_SELECTOR_PASSWORD` | `input[name="password"]` |
| `PORTAL_SELECTOR_SUBMIT` | `#login-btn` |
| `ELEARNING_URL` | URL redirect e-learning |
| `GMAIL_OTP_FROM` | `noreply@umby.ac.id` |
| `GMAIL_OTP_SUBJECT` | `Two Step Verification` |
| `GOOGLE_CREDENTIALS_JSON` | seluruh isi `credentials/google-credentials.json` |
| `GMAIL_TOKEN_JSON` | seluruh isi `credentials/gmail-token.json` |
| `GOOGLE_SHEET_ID` | ID spreadsheet |
| `GOOGLE_SHEET_TAB` | `Sheet1` |
| `TELEGRAM_BOT_TOKEN` | token bot |
| `TELEGRAM_CHAT_ID` | chat id |

**3. Jalankan uji** — tab **Actions → Campus Task Sentinel → Run workflow**

**4. Jadwal** — default cron: setiap **2 jam** (`0 */2 * * *` UTC).

| Jadwal | Cron |
|--------|------|
| Tiap 2 jam | `0 */2 * * *` |
| Tiap 3 jam | `0 */3 * * *` |
| Jam 07 & 19 WIB | `0 0,12 * * *` |

> Catatan: schedule GitHub bisa delay beberapa menit. Laptop boleh dimatikan.

### Alternatif gratis lain
- **Oracle Cloud Always Free** (VPS) — lebih “selalu nyala”, setup lebih ribet
- Render / Railway free — sering sleep, kurang cocok untuk cron andal

Untuk bot ini, **GitHub Actions sudah cukup**.

## Format pesan Telegram

Satu pesan = satu mata kuliah:

```
📚 Teknik Klasifikasi dan Pengenalan Pola (22D)

📂 Minggu 01 : Jumat, 18 Sept 2026 : 20.00 WIB : Video Conference
🔗 Link Vicon Minggu 1
  Perkuliahan TKPP yang perdana akan diselenggarakan...
📄 Kontrak Belajar
Pengumuman Kuliah Perdana
```

Jika ada 3 matkul yang update, bot mengirim 3 pesan terpisah.

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Magic link timeout | Periksa `GMAIL_OTP_FROM` / `GMAIL_OTP_SUBJECT`; pastikan email masuk inbox Gmail yang diotorisasi |
| `invalid_grant` token | Jalankan ulang `node scripts/authorize-gmail.js` |
| Sheets 403 | Share spreadsheet ke akun OAuth; pastikan Sheets API aktif |
| Login Playwright gagal | Set `PLAYWRIGHT_HEADLESS=false`, sesuaikan selector |
| Cron tidak jalan | Workflow schedule bisa delay; pastikan repo tidak inactive terlalu lama; pakai `workflow_dispatch` untuk uji |

## Lisensi

MIT
