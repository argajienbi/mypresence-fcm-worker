# Deploy MyPresence FCM Worker ke Cloudflare

Worker ini menggantikan Cloud Functions `processNotificationQueue` (butuh Blaze plan).
Berjalan gratis di Cloudflare Workers (100rb request/hari).

## Prasyarat

1. **Service Account Key** dari Firebase Console:
   - Buka https://console.firebase.google.com/project/mypresence-prod/settings/serviceaccounts/adminsdk
   - Klik "Generate New Private Key" → download JSON
   - **JANGAN commit file ini ke repo!** Simpan aman.

2. **Wrangler CLI** terinstal:
   ```bash
   npm install -g wrangler
   wrangler login
   ```

## Deploy

```bash
cd ~/workspace/mypresence-fcm-worker

# 1. Set secrets (dari service account JSON)
wrangler secret put FIREBASE_PROJECT_ID
# → ketik: mypresence-prod

wrangler secret put FIREBASE_DATABASE_URL
# → ketik: https://mypresence-prod-default-rtdb.asia-southeast1.firebasedatabase.app

wrangler secret put FIREBASE_CLIENT_EMAIL
# → ketik: (client_email dari JSON)

wrangler secret put FIREBASE_PRIVATE_KEY
# → ketik: (private_key dari JSON, termasuk -----BEGIN PRIVATE KEY-----)

# 2. Deploy
wrangler deploy
```

## Test

Setelah deploy, buka URL worker + `?test=1` untuk proses manual satu kali:
```
https://mypresence-fcm-worker.<akun>.workers.dev/?test=1
```

Response JSON: `{ checked, sent, failed, skipped }`

## Cara Kerja

1. **MyAdmin** tulis ke `companies/{companyId}/notification_queue/{queueId}`:
   ```js
   {
     company_id: "-P3G8w4qKKzvGB3kKvEL",
     uid: "f0MSPOC8wqUElxldUMc6uYeDU0d2",
     title: "Judul Notifikasi",
     body: "Isi pesan",
     type: "info",
     status: "pending",  // ← Worker hanya proses yang pending
     ...
   }
   ```

2. **Worker** (cron tiap menit):
   - Baca semua item `status: "pending"`
   - Ambil token aktif dari `companies/{companyId}/users/{uid}/fcm_tokens`
   - Kirim via FCM HTTP v1 API
   - Update `status` → `"sent"` / `"failed"`
   - Token invalid (UNREGISTERED) otomatis dinonaktifkan

3. **Aplikasi Flutter** terima push seperti biasa (kode client sudah ada).

## Retry

- Gagal kirim → `retry_count` +1, tetap `pending`
- Setelah 3x gagal → `status: "failed"`

## Catatan Keamanan

- Service account key = kunci kerajaan. Jangan share, jangan commit.
- Worker secrets terenkripsi di Cloudflare, tidak terlihat di dashboard.
- RTDB rules harus izinkan baca/tulis service account (default: service account bypass rules).
