# SosmedSign Player — Catatan Logika (sumber: player Android + backend CMS)

Dokumen ini merangkum logika yang **sudah berjalan** di player Android (`com.solusimediakarya.sosmedsignplayer`)
dan kontrak API di backend Laravel, sebagai acuan port ke Electron (Windows MiniPC).
Simpan di repo `sosmedsign-player-electron/docs/`. Kalau ada perbedaan dengan kode, **kode yang menang**.

> Catatan: `HANDOFF_08` (alur `bootstrap` + `pairing_code` yang ditampilkan player) sudah **usang**.
> Alur yang berlaku sekarang adalah kode aktivasi dari CMS (lihat bagian 3).

---

## 1. Gambaran umum

- Player = kiosk fullscreen yang memutar rotasi konten (video/gambar) sesuai playlist dari CMS, **offline-first**.
- Playlist per device dibuat backend sebagai *snapshot* (`DevicePlaylistSnapshot`) berisi item per slot booking.
- Player sync tiap **3 menit**, mengunduh konten ke cache lokal, lalu memutar dari cache (bukan streaming).
- Player boleh offline berminggu-minggu; itu kondisi normal, bukan error.
- Statistik tayang dicatat lokal, lalu diunggah saat online.

## 2. Kontrak API (semua di bawah `/api`)

| Method | Path | Auth | Fungsi |
|---|---|---|---|
| POST | `/devices/activate` | publik | Tukar kode aktivasi + `device_code` → `api_token` |
| GET | `/devices/{device_code}/registration-status` | publik | Cek status registrasi |
| GET | `/devices/{device_code}/playlist?current_version=<hash>` | Bearer | Ambil playlist (200 / 204 / 404) |
| POST | `/devices/{device_code}/sync-log` | Bearer | Laporan hasil sync |
| POST | `/devices/{device_code}/playback-logs` | Bearer | Unggah statistik tayang (maks 500/request) |
| DELETE | `/devices/{device_code}/release` | Bearer | Lepas device dari venue/akun |

Middleware `device.auth`: `device_code` (route) + Bearer token harus cocok dengan `devices.api_token`
(`hash_equals`), dan `registration_status` harus `registered`. Gagal → `401` (token tidak ada/tidak valid) atau `403` (belum registered).

### 2.1 `POST /devices/activate`
Request: `{ "activation_code": "<maks 8 char>", "device_code": "<uuid, maks 64>" }`
Sukses `200`:
```json
{ "device_code": "...", "name": "...", "venue_id": 1, "slot_capacity": 20,
  "slot_duration_seconds": 15, "registration_status": "registered", "api_token": "..." }
```
Gagal → `422 {"message": "..."}` (kode salah/kedaluwarsa dst). **`api_token` hanya dikirim di response ini.**

### 2.2 `GET /devices/{device_code}/registration-status`
Response: `registration_status` (`pending`|`registered`), `venue_id`, `slot_capacity`, `slot_duration_seconds`.
**Tidak lagi mengembalikan `api_token`** (walau model Kotlin masih punya field nullable-nya).
Artinya: kalau kredensial lokal hilang tapi CMS masih menganggap device `registered`, player tidak bisa mendapat token baru
lewat endpoint ini (lihat catatan auto-recovery di bagian 4.4).

### 2.3 `GET /devices/{device_code}/playlist`
- `404` `{message}` → belum ada snapshot (device valid; normal untuk device yang baru diklaim).
- `204` → `current_version` sama dengan snapshot terbaru; tidak ada yang perlu diunduh.
- `200`:
```json
{
  "device_id": "<device_code>",
  "slot_duration_seconds": 15,
  "playlist": [
    {
      "slot_number": 1,
      "slots_used": [1, 2],
      "content_id": 12,
      "content_label": "Judul konten",
      "content_url": "https://.../storage/contents/{device_id}/abc.mp4",
      "media_type": "video",
      "duration_seconds": 15.0,
      "schedule": {
        "days": "mon,tue", "start": "08:00", "end": "18:00", "timezone": "Asia/Jakarta",
        "daysOfWeek": "mon,tue", "startTime": "08:00", "endTime": "18:00",
        "startDate": "2026-09-01", "endDate": "2026-09-30"
      }
    }
  ],
  "version_hash": "<sha256 dari payload>",
  "generated_at": "2026-09-09T10:00:00+00:00"
}
```
- `schedule` boleh `null` → tayang tanpa batas jam.
- `days` berupa string CSV (`"mon,tue,wed"`), **bukan array** (walau contoh di HANDOFF_08 menulis array).
- `media_type` diturunkan backend dari ekstensi URL: `jpg/jpeg/png/webp` → `image`, selain itu `video`.
  Field bisa tidak ada di playlist lama → perlakukan sebagai `video`.
- `content_url` bisa URL R2/CDN atau URL backend lokal (`/storage/...`). Perlakukan sebagai URL HTTP biasa.
- `version_hash` = sha256 dari `json_encode(payload)`; snapshot baru hanya dibuat kalau hash berubah.
- Backend menunda snapshot baru kalau kuota bandwidth harian sistem habis (kecuali device belum pernah dapat snapshot).
- Backend mem-publish notifikasi MQTT `device/{device_code}/notify` saat ada snapshot baru (opsional; player Android
  tidak memakainya, hanya polling).

### 2.4 `POST /devices/{device_code}/sync-log`
`{ "playlist_version_hash": "...", "status": "success|failed|partial", "bytes_downloaded": 123 }` → `201 {message, id}`.
Backend mencatat `SyncLog`, mengisi `last_sync_at`, dan set `connection_status = online`.

### 2.5 `POST /devices/{device_code}/playback-logs`
```json
{ "logs": [ { "content_id": 12, "content_label": "...", "played_at": "2026-09-30T03:00:00Z",
              "duration_seconds": 15, "was_offline": false } ] }
```
Validasi: `logs` array maks **500**; `played_at` date; `duration_seconds` integer **min 1**; `was_offline` boolean.
Response `{ "inserted": n }`.

### 2.6 `DELETE /devices/{device_code}/release`
`200 {message, registration_status: "pending"}`; `422` kalau device masih punya booking aktif.

## 3. Registrasi (alur yang berlaku)

1. Saat pertama jalan, player membuat `device_code` = UUID acak, disimpan permanen.
2. Layar aktivasi: instalatur mengetik kode aktivasi yang dibuat admin di CMS (di-trim, di-uppercase; Android memvalidasi
   panjang tepat **8** karakter; backend menerima maks 8).
3. `POST /devices/activate` → sukses langsung `registered` dan token disimpan (tidak perlu polling).
4. Tombol Enter/OK di layar aktivasi juga memicu submit.

## 4. Siklus hidup & ketahanan (bagian paling penting untuk dipertahankan)

### 4.1 Startup
- Kalau `registered` + ada `api_token` → mode player, tampil loading, mulai loop sync.
- Kalau belum → layar aktivasi + auto-recovery loop (4.4).
- Auto-start saat boot (Android: `BootCompletedReceiver`). Di Windows: setara auto-login + startup entry.

### 4.2 Loop sync
- `syncPlaylistOnce()` langsung saat start, lalu tiap **3 menit** (`SYNC_INTERVAL_MILLIS = 180000`).
- Ada guard `syncInProgress` supaya tidak tumpang tindih.
- **Jika tidak ada jaringan: sync dilewati, playback lanjut dari cache.** Jangan validasi ke server saat offline.
- Playback log yang antre diunggah **menumpang** di siklus sync yang sama (tidak ada job terpisah).

### 4.3 Validasi registrasi & masa tenggang (dibuat setelah insiden)
Sebelum sync, player memanggil `registration-status` (publik) untuk memvalidasi bahwa device masih terdaftar:
- `registered` → reset counter gagal.
- `pending` (404 dengan body JSON API kita) atau `Unavailable` (401/403, atau 404 yang body-nya bukan JSON API,
  error jaringan) → counter gagal +1.
- Baru setelah **120 kegagalan beruntun** (≈ 6 jam pada interval 3 menit; `OFFLINE_GRACE_VALIDATION_FAILURES`)
  player menganggap device dilepas dan kembali ke layar aktivasi.
- Alasan: pernah terjadi device ter-reset paksa hanya karena koneksi putus / captive portal / proxy yang membalas 401/403/404
  dengan HTML. **Respons HTTP error hanya dipercaya kalau body-nya JSON `{message}` milik API kita.**

### 4.4 Auto-recovery (di layar aktivasi)
Loop tiap **2 menit** memanggil `registration-status`; kalau `registered`, player mencoba pulih tanpa kode baru.
Catatan port: karena `registration-status` sekarang **tidak mengirim token**, jalur ini di Android praktis hanya berhasil kalau
response memuat `api_token` (di kode saat ini `checkRegistrationStatus` menganggap `registered` tanpa token sebagai error).
Verifikasi perilaku aktualnya sebelum meniru.

### 4.5 Device dilepas / token dicabut
- Sync menerima `401/403` dari `/playlist`, `/sync-log`, atau download konten → `DeviceReleased`.
- Respons: batalkan loop sync, hentikan pemutaran, **hapus seluruh cache konten + data playlist**, hapus kredensial registrasi
  **tapi pertahankan `device_code`**, tampilkan layar aktivasi, jalankan auto-recovery.
- Release manual dari menu Pengaturan: panggil `DELETE /release`; `401/403/404` dianggap **sukses** (idempoten);
  data lokal baru dihapus **setelah** server konfirmasi; jika gagal, kredensial tidak disentuh dan sync dilanjutkan.
- Reset identitas (dari layar diagnostik saat pairing macet): hapus semua termasuk `device_code` → UUID baru.

## 5. Sync playlist (`PlaylistRepository.sync`)

1. `current_version` = `version_hash` playlist aktif lokal (kosong kalau `forceRefresh`).
2. Hasil: `204` → `NotModified`; `404` → `NoPlaylistYet`; `200` → `applyNewPlaylist`; `401/403` → `DeviceReleased`;
   lainnya/exception → `Error` (**tidak boleh menghentikan playback dari cache**).
3. `applyNewPlaylist`:
   - Unduh **semua** item terlebih dulu; playlist baru **tidak** diaktifkan sebelum selesai (offline-first).
   - Item gagal unduh disimpan dengan status `FAILED` (tanpa path lokal), item sukses `READY`.
   - Kalau **semua** item gagal → playlist lama dipertahankan, kirim sync-log `failed`.
   - Aktivasi playlist baru **atomik dalam satu transaksi** (`activatePlaylist`): hanya satu playlist `isActive`.
   - Setelah aktivasi: `cleanupUnused(pathYangDipakaiPlaylistBaru)` menghapus file cache yang tidak dipakai lagi
     (kecuali `*.tmp`).
   - Sync-log: `success` atau `partial` (kalau ada yang gagal), `bytes_downloaded` = total byte **yang benar-benar diunduh**
     (cache hit **tidak** dihitung, supaya grafik bandwidth CMS akurat).
4. `NotModified` → `retryFailedItems`: coba unduh ulang item `FAILED` dari playlist aktif; kalau ada yang pulih, muat ulang playlist.
5. Sync-log yang gagal terkirim tidak boleh mengganggu playback.

## 6. Cache & unduhan (`ContentDownloader`)

- Direktori: `filesDir/content_cache`. Nama file lokal Android: `content_{url.hashCode()}.{ext}` (hash 32-bit dari URL —
  **jangan ditiru**, rawan tabrakan; di Electron pakai `content_id` + identitas versi).
- Cache hit = file ada dan ukuran > 0 (tidak ada verifikasi ukuran/hash terhadap server).
- Unduh: file `.tmp` → cek HTTP sukses & ukuran > 0 → `rename` ke nama final. Tidak pernah menimpa file aktif langsung.
  Retry: 2 kali (total 3 percobaan). Timeout: connect 20 dtk, read 60 dtk. `.tmp` selalu dihapus di `finally`.
- Respons `401/403` saat unduh → `DeviceReleased`.
- Mode dev: URL host `localhost`/`127.0.0.1`/host header dev ditulis ulang ke `BASE_URL` dev, dan header `Host` di-set
  (Herd melayani beberapa site via virtual host). Config dev Android: `-PbackendBaseUrl` & `-PbackendHostHeader`.
- Rilis device: hapus **semua** file cache.

## 7. Jadwal tayang (`ScheduleChecker.isPlayableNow`)

- `schedule == null` (atau ada field yang null) → selalu boleh tayang.
- Cek hari (`mon..sun`, CSV, case-insensitive) di timezone milik jadwal (`ZoneId`), lalu jam `start..end`
  (inklusif; format `HH:mm` atau `HH:mm:ss`).
- Rentang lintas tengah malam didukung (`start > end`, mis. 22:00–02:00 → `now >= start || now <= end`).
- Format jadwal tak terduga → **default boleh tayang** (jangan hilang diam-diam dari rotasi).
- Item di luar jadwal **dilewati dari rotasi, bukan dihapus dari playlist/cache**.
- **Belum dipakai di Android:** `startDate`/`endDate` ada di payload tapi tidak dibaca. Lihat bagian 11.

## 8. Pemutaran

- Rotasi berurutan berdasarkan `slot_number` (urutan dari server), wrap-around. Index direset ke 0 setiap playlist dimuat ulang.
- Untuk tiap item: cari item berikutnya yang `playable now` **dan** punya `localFilePath`; kalau tidak ada satu pun, berhenti
  (layar hitam/idle, dan di Android **tidak ada timer** untuk mengecek ulang jadwal — lihat bagian 11).
- Video: putar file lokal; selesai → catat statistik → item berikutnya. Mode tampil **FIT** (letterbox/pillarbox, tidak di-crop).
- Gambar: tampil sepanjang `duration_seconds` dari server (minimum 1 detik, jangan hardcode 15). Decode di luar UI thread dan
  di-downscale sesuai resolusi layar. Ada *generation token* supaya hasil decode/timer usang dibuang kalau item sudah berpindah.
- Error putar / decode gagal → **lewati ke item berikutnya**, jangan dicatat sebagai tayang, jangan berhenti total.
- Layar loading tampil sampai item pertama mulai tampil.

## 9. Statistik tayang (`PlaybackReporter`)

- Dicatat **hanya untuk tayang yang selesai wajar** (video ended / timer gambar habis).
- Baris: `content_id`, `content_label` (fallback nama file dari URL), `played_at` (UTC ISO-8601 saat **mulai**),
  `duration_seconds` (dibulatkan, minimum 1; di bawah 1 tidak dicatat), `was_offline` (status jaringan saat selesai).
- Disimpan di tabel antrean lokal `pending_playback_logs` (bukan bagian cache; **tidak boleh hilang** karena migrasi).
- Unggah batch maks 500 per request, urut `id ASC`; baris dihapus **hanya setelah server sukses**; berhenti di kegagalan pertama
  (coba lagi siklus berikutnya). Tidak pernah kirim ganda.

## 10. Pengaturan / diagnostik (dibuka lewat INFO/MENU di remote Android)

- Terdaftar → menu Pengaturan; belum terdaftar → langsung layar log diagnostik (agar reset identitas bisa diakses tanpa CMS).
- Isi menu: kartu memori (RAM aplikasi & device), kartu storage (terpakai/total, ukuran cache konten, ukuran database,
  jumlah item total/siap/gagal), **Log diagnostik**, **Sync ulang paksa** (`forceRefresh`), toggle **Keep screen on**,
  **Lepaskan device**, dan (di layar diagnostik) **Reset identitas device**.
- Log diagnostik: ring buffer **120** entri berformat `HH:mm:ss  pesan`; dibersihkan saat release/reset.
- Kredensial tidak pernah ditulis ke log.

## 11. Kredensial (`CredentialStore`)

Field: `device_code` (UUID, permanen), `api_token`, `pairing_token`/`pairing_expires_at` (sisa alur lama), `venue_id`,
`slot_capacity` (default 20), `slot_duration_seconds` (default 15), `registration_status`, preferensi `keep_screen_on` (default true).
Android memakai `EncryptedSharedPreferences` (AES-256). Di Electron: `safeStorage` (DPAPI di Windows) atau setara.

## 12. Temuan & rekomendasi untuk port Electron

**Backend (perlu diputuskan):**
1. **Penggantian konten mempertahankan `content_id`.** `ContentController::confirmReplace` meng-update baris `Content` yang sama
   dengan `file_url` baru (path baru: `contents/{device}/pending/{uuid}-...`), lalu menghapus file lama. Jadi ID yang sama bisa
   menunjuk file yang berbeda. Kunci cache sebaiknya `content_id` **+** identitas versi (`content_url`, atau lebih baik
   `checksum`/`updated_at`), bukan `content_id` saja.
2. Payload playlist **belum memuat `file_size` dan checksum**, padahal kolom `contents.file_size` sudah ada. Usul: tambahkan
   `file_size` (dan idealnya `checksum_sha256`) per item agar player bisa memverifikasi unduhan dan mendeteksi file rusak.
   Menambah field mengubah `version_hash`, itu wajar.

**Perilaku yang sebaiknya diperbaiki saat port:**
3. Hormati `startDate`/`endDate` di jadwal (Android mengabaikannya). Konfirmasi dulu apakah backend sudah menonaktifkan booking
   yang kedaluwarsa, agar tidak menampilkan konten kadaluwarsa.
4. Tambahkan timer re-evaluasi jadwal (mis. tiap 30–60 detik) supaya player tidak diam selamanya ketika semua item sedang di luar jadwal.
5. `401/403` dari `/playlist` langsung memicu wipe di Android. Sebaiknya pakai aturan yang sama dengan 4.3: hanya percaya kalau
   body JSON API kita, dan lewatkan masa tenggang sebelum menghapus cache.
6. Di Windows, file yang sedang diputar tidak bisa dihapus. Penghapusan harus ditunda dan diulang.
7. Jangan menghapus cache berdasarkan playlist yang tidak valid/kosong akibat error. Hapus hanya dari playlist lengkap dan berhasil
   diambil, sesuai rancangan mirror-sync.

## 13. Pemetaan komponen Android → Electron

| Android | Electron (usulan) |
|---|---|
| `CredentialStore` | `safeStorage` + file JSON di `userData` |
| Room (`playlists`, `playlist_items`, `pending_playback_logs`) | SQLite (`better-sqlite3`) di main process |
| `ContentDownloader` | Cache manager (Node `fs`, temp→rename, diff mirror) |
| `PlaylistRepository` | Sync service (main process) |
| `DeviceRepository` | Device service (activate / validate / release) |
| `PlaybackReporter` | Reporter (antrean SQLite + unggah batch) |
| `ScheduleChecker` | Modul murni + unit test (timezone, lintas tengah malam) |
| ExoPlayer + ImageView | Renderer: `<video>` ganda (gapless) + `<img>` |
| Settings overlay (INFO/MENU) | Overlay di renderer, dibuka lewat pintasan keyboard |
| `BootCompletedReceiver` | Auto-login Windows + startup entry |
| `PlayerDiagnostics` | Ring buffer 120 entri + file log rotasi |
