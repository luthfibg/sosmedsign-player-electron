# M4a: statistik tayang, lampu Playback, proteksi disk, verifikasi cache

Tanggal: 3 Oktober 2026. Verifikasi otomatis: 213 tes, typecheck, ESLint, build.
**Belum diuji di jendela Electron sungguhan** (checklist di bawah). M4b (menu Pengaturan, ganti folder cache, tombol manual) menyusul.

## Statistik tayang (`playback-reporter.ts`, `db/playback-log-store.ts`)

- Renderer melaporkan tayang yang **selesai wajar** (video ended / timer gambar habis) lewat IPC `player:item-completed`; main memvalidasi
  bentuk datanya (`ipc/validators.ts`) lalu mengantrekan ke tabel `pending_playback_logs`.
- Baris: `content_id`, `content_label` (dipotong 255), `played_at` (UTC, waktu **mulai**), `duration_seconds` (dibulatkan, minimum 1,
  maksimum 24 jam), `was_offline` (status jaringan saat selesai). Di bawah 1 detik tidak dicatat.
- Unggah **menumpang di siklus sync**: setelah registrasi terkonfirmasi dan sebelum permintaan playlist. Batch maksimum 500 baris, urut
  tertua dulu, maksimum 20 batch (10.000 baris) per siklus. Baris dihapus **hanya setelah server menjawab sukses**; berhenti di kegagalan
  pertama; tidak pernah mengirim ganda.
- Respons server:
  - 2xx: batch dihapus.
  - 401/403 berbentuk JSON API: dihitung ke penghitung masa tenggang token (keputusan A), siklus berhenti, antrean utuh.
  - 4xx lain berbentuk JSON API (mis. 422 validasi): **batch dibuang** dan dicatat di log, supaya satu batch yang selalu ditolak tidak
    menyumbat antrean selamanya.
  - 408/429, 5xx, HTML, atau gagal jaringan: antrean dipertahankan, dicoba lagi siklus berikutnya.
- Antrean dibatasi 500.000 baris (baris tertua dibuang). Antrean **tidak** dihapus saat release/reset device.

## Lampu Playback (`playback-status.ts`)

Renderer melaporkan status mesin pemutar (`waiting`/`playing`/`idle` + judul konten) lewat `player:status`. Lampu: `unknown` (menunggu
playlist / belum ada laporan), `active` ("Memutar: <judul>"), `warning` (idle, atau "playing" tanpa aktivitas lebih dari 10 menit),
direset saat registrasi dihapus.

## Proteksi disk (`cache-manager.ts`, `sync-service.ts`)

- Cadangan ruang disk default **1 GiB** (`DEFAULT_MIN_FREE_BYTES`). Sebelum menulis unduhan, `file_size` (atau `Content-Length`) dicek terhadap
  ruang kosong; kalau tidak muat, unduhan **tidak dimulai dan tidak diulang** (hasil `diskFull`). `ENOSPC` saat menulis juga diperlakukan sama.
- Sebelum mengunduh playlist baru, kebutuhan ruang diperkirakan dari `file_size` item yang belum ada di cache. Kalau kurang, file yatim
  dihapus **sekarang** (tanpa menunggu masa tenggang 30 menit). File playlist yang sedang aktif dan file playlist baru tidak pernah disentuh.
- Lampu Sync menjadi `error` "Ruang disk tidak cukup untuk mengunduh konten" selama unduhan terakhir gagal karena disk.

## Verifikasi dan perbaikan cache (`SyncService.verifyAndRepair`)

Memeriksa semua file playlist aktif terhadap ukuran dan SHA-256 dari server (hash dibaca bertahap). File hilang atau rusak ditandai
`FAILED` (yang rusak dihapus) lalu langsung diunduh ulang lewat jalur retry. Berjalan eksklusif terhadap sync (`runExclusive`). Belum
dipanggil dari UI; tombolnya hadir di M4b.

## Statistik penyimpanan (`storage-stats.ts`)

`StorageStats.collect()`: ukuran dan jumlah file cache, file yatim, sisa/total disk, ukuran database (+WAL/SHM), jumlah item playlist
(total/siap/gagal), dan antrean statistik tayang. Belum dipanggil dari UI (M4b).

## Perbaikan tes

`resolveCachedFile` dibandingkan dengan `join()`, bukan string ber-`/` (gagal di Windows karena pemisah `\`).

## Checklist uji manual

1. Putar playlist beberapa menit, lalu buka log (Ctrl+Shift+D): ada "Statistik tayang terkirim: N baris" pada siklus sync berikutnya, dan
   di CMS jumlah tayang konten bertambah.
2. Putuskan jaringan, biarkan 2-3 konten tayang, sambungkan lagi: baris terkirim dengan `was_offline` benar di database CMS.
3. Lampu Playback hijau saat memutar dan kuning saat semua konten di luar jadwal.
4. Hentikan backend di tengah unggahan: tidak ada baris hilang atau terkirim dua kali setelah backend hidup lagi.
5. (Opsional) kecilkan ruang disk (mis. drive kecil/quota) lalu tambah konten besar di CMS: log berisi "ruang disk tidak cukup", lampu Sync merah,
   playlist lama tetap diputar.

## Belum dikerjakan (M4b)

Menu Pengaturan (kartu RAM/storage/diagnostik), ganti direktori cache dengan validasi folder (tolak root drive, home, folder sistem, folder
berisi file lain), tombol manual (Bersihkan cache, Verifikasi file, Sync ulang paksa, Lepaskan device), toggle Keep screen on, dan
`settings.json`.
