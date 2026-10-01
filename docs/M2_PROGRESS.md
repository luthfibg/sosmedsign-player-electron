# M2 Progress - Sync Service dan Cache Manager

Tanggal: 1 Oktober 2026

Dokumen ini merangkum pekerjaan M2 pada repo Electron agar bisa diteruskan sebagai konteks ke Claude. Acuan perilaku player adalah `docs/ANDROID_PLAYER_LOGIC.md`.

## Yang sudah dikerjakan

### Cache dan unduhan konten

- Mengimplementasikan `src/main/services/cache-manager.ts` sebagai pengelola cache konten lokal.
- Kunci file cache membedakan versi konten dengan identitas `content_id`, `content_url`, `checksum_sha256`, dan `file_size`; tidak memakai hash URL 32-bit Android.
- Unduhan ditulis ke file `.tmp` unik, hanya dipindahkan ke nama final setelah respons HTTP sukses dan file lolos pemeriksaan ukuran/checksum yang tersedia.
- SHA-256 dan ukuran file diverifikasi bila backend mengirim field tersebut. Field checksum tetap opsional agar cocok dengan playlist backend sebelum patch checksum diterapkan.
- Cache hit tidak dihitung sebagai byte unduhan. Byte dari unduhan baru, termasuk percobaan yang gagal setelah menerima data, masuk ke hitungan `bytes_downloaded`.
- Ada tiga percobaan unduh, file sementara dibersihkan, file kosong ditolak, dan URL konten dibatasi ke HTTP/HTTPS.
- Respons download 401/403 hanya dianggap penolakan device bila body-nya JSON API dengan field `message`; respons HTML dari proxy tidak melepas device.
- URL media `localhost`/`127.0.0.1` ditulis ulang ke `BASE_URL` dev. Header `Host` khusus hanya diterapkan pada URL hasil rewrite, tidak dikirim ke CDN.
- Cleanup menjaga file yang dipakai playlist baru dan file `.tmp`. Penghapusan yang tertahan karena file sedang dipakai Windows dicoba ulang pada sync berikutnya dan dengan timer 5 detik.

### Sinkronisasi playlist

- Mengimplementasikan `src/main/services/sync-service.ts` untuk polling langsung saat mulai dan setiap 3 menit, dengan guard agar sync tidak tumpang tindih.
- Saat offline, sync dan validasi registrasi dilewati; playback/cache lokal tidak disentuh.
- Validasi registrasi mengikuti masa tenggang 120 kegagalan beruntun. Respons unavailable tidak langsung menghapus playlist.
- Menangani respons playlist `204` (retry item gagal), `404` API (belum ada snapshot, data lama dipertahankan), `200`, error, serta 401/403 API yang valid.
- Payload harus valid dan snapshot kosong diabaikan agar respons salah/kosong tidak menghapus data offline.
- Semua item snapshot baru diunduh sebelum playlist diaktifkan. Item disimpan sebagai `READY` atau `FAILED`.
- Jika semua item gagal diunduh, playlist aktif dan cache lama dipertahankan serta sync-log `failed` dikirim.
- Jika unduhan berhasil sebagian, snapshot baru diaktifkan dengan item gagal tetap berstatus `FAILED`, lalu sync-log `partial` dikirim.
- Aktivasi playlist, item-itemnya, dan penggantian playlist aktif dilakukan dalam satu transaksi DB. Playlist lama baru dibersihkan setelah snapshot baru berhasil diaktifkan.
- Sync-log membawa status dan byte yang benar-benar diunduh; kegagalan mengirim log tidak menghentikan sync/playback.
- Pada pelepasan/reset device, data playlist dan cache lokal dibersihkan; antrean `pending_playback_logs` tidak dihapus. `device_code` tetap dikelola `CredentialStore` yang sudah ada.

### Integrasi aplikasi dan pengujian

- `src/main/index.ts` membuat cache/sync service, memulai sync untuk device terdaftar, menghubungkan perubahan status registrasi, dan mengirim status jaringan Electron.
- Menambahkan `src/main/__tests__/cache-manager.test.ts` dan `src/main/__tests__/sync-service.test.ts` untuk integritas unduhan, retry, cache hit/versioning, cleanup, API-vs-HTML 403, URL dev, mirror sync parsial, kegagalan total, 404, dan offline.

## Patch backend checksum

- Arsip `backend-checksum-patch.zip` sudah diperiksa, tetapi **belum diterapkan** karena repo Laravel tidak ada di workspace ini. Arsip sengaja dibiarkan utuh.
- Patch tersebut menambahkan kolom checksum, menghitung SHA-256 saat upload/replacement, mengirim `file_size` dan `checksum_sha256` di snapshot playlist, menyediakan command backfill, dan membawa feature test backend.
- Langkah backend yang masih diperlukan: terapkan patch di repo Laravel, jalankan migration dan test, lalu jalankan backfill checksum untuk konten lama. Sebelum itu, player tetap kompatibel tetapi hanya memverifikasi ukuran/checksum yang tersedia.

## Verifikasi

- `npm test`: 63 test lulus.
- `npm run typecheck`: main dan renderer lulus.
- `npm run build`: production build Electron lulus.
- Prettier check pada file yang berubah lulus.
- ESLint pada file yang berubah tidak menemukan error. Lint repo penuh masih menampilkan warning CRLF dari salinan lama di `.kilo/worktrees`, di luar file M2.

## Batas tahap

M2 pada Electron selesai untuk sync dan cache. Renderer pemutar, rotasi video/gambar, jadwal, dan transisi playback masih pekerjaan M3. Playback reporter, pengaturan, dan diagnostik UI tetap pekerjaan M4.
