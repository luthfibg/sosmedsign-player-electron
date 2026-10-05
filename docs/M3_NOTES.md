# M3: Pemutar (renderer) + penerapan keputusan A/B/C dari review M2

Tanggal: 1 Oktober 2026. Kode: `src/renderer/src/player/*`, `src/main/services/{media-protocol,playlist-presenter,playlist-mapper}.ts`,
`src/main/db/{playlist-store,sqlite-playlist-store}.ts`. Verifikasi otomatis: 149 tes, typecheck, ESLint, build.
**Belum diuji di jendela Electron sungguhan** (lihat checklist di bawah).

## Keputusan A/B/C (diterapkan)

- **A. Token ditolak (401/403 JSON)** dihitung lewat penghitung `auth_failures` (tersimpan di database, batas 120). Data TIDAK dihapus;
  setelah batas terlampaui registrasi dihapus dengan alasan `credentials-invalid` (playlist dan cache dipertahankan, layar aktivasi muncul).
  Respons 401/403 berbentuk HTML (proxy/captive portal) diabaikan. Penghitung direset oleh respons autentikasi yang sukses (200/204/404 JSON).
  401/403 JSON saat unduh konten dan saat sync-log juga masuk penghitung ini, tidak lagi melepas device seketika.
- **B. Snapshot kosong valid (`playlist: []`)** diterima: playlist aktif menjadi kosong (player idle/hitam). Snapshot yang berisi item
  tapi semuanya rusak ditolak (`error`) dan data lama dipertahankan. Item rusak tunggal dilewati satu per satu, tidak menggagalkan sync.
- **C. Validasi registrasi**: hanya jawaban pasti `pending` yang dihitung (`validation_failures`, tersimpan di database, batas 120 = sekitar 6 jam).
  Jawaban `unavailable` (server mati, timeout, HTML) tidak dihitung. Setelah batas, registrasi dihapus dengan alasan `unregistered`
  (playlist dan cache dihapus).

Alasan penghapusan registrasi (`RegistrationClearedReason`): `released`, `identity-reset`, `unregistered` menghapus playlist + cache;
`credentials-invalid` mempertahankannya. Antrean `pending_playback_logs` tidak pernah dihapus.

## Cache

- **Masa tenggang file yatim 30 menit.** Waktu dihitung dari mtime ("terakhir direferensikan"): `touch()` dipanggil pada tiap siklus sync
  (juga siklus 204) dan pada file playlist lama tepat sebelum diganti. Sweep berjalan di setiap siklus, bukan hanya saat playlist berubah.
  `cleanupUnused(paths, { ignoreGrace: true })` menghapus langsung (dipakai M4: disk hampir penuh / pembersihan manual).
- Playlist di database menyimpan **nama file cache**, bukan path penuh (aman kalau direktori cache dipindah di M4).
  `CacheManager.resolveCachedFile(name)` hanya menerima nama berpola `content_{id}_{hash20}.{ext}` yang ada di folder cache.

## Pemutar

- Dua elemen `<video>` bergantian (A/B) + satu `<img>`: saat item sekarang tayang, item video berikutnya dimuat di elemen cadangan;
  pada `ended` elemen cadangan langsung diputar dan baru ditampilkan saat event `playing` (tanpa layar hitam di antara video).
  Elemen lama dilepas decoder-nya (`removeAttribute('src')` + `load()`).
- File diputar lewat protokol `sosmedsign-media://media/<nama-file>` (Range ditangani manual: 200/206/416/HEAD).
  CSP: `media-src sosmedsign-media:` dan `img-src ... sosmedsign-media:`.
- Rotasi berurutan menurut `slot_number`; item di luar jadwal dilewati (tetap di playlist dan cache); satu-satunya item yang boleh tayang diulang.
- Gambar tampil `duration_seconds` (minimum 1 detik). Video: watchdog = durasi sebenarnya (setelah `loadedmetadata`) + 10 dtk;
  video yang tidak mulai tampil dalam 20 dtk dilewati. Error putar/decode melompat ke item berikutnya dan tidak dicatat sebagai tayang.
  Kalau semua item yang boleh tayang gagal berturut-turut, pemutar menunggu 5 dtk sebelum mengulang (tidak berputar cepat).
- Playlist baru saat memutar: item yang sedang tayang diselesaikan dulu, lalu rotasi mulai dari awal playlist baru.
- Tidak ada yang boleh tayang: layar hitam, jadwal dicek ulang tiap 30 dtk (item yang jendelanya baru dibuka mulai tayang sendiri).
- Layar "Menunggu konten dari server…" hanya tampil sampai server pernah mengirim playlist; setelah itu layar hitam saat idle.
- `powerSaveBlocker('prevent-display-sleep')` aktif (setara Keep screen on; tombol pengaturannya di M4), `backgroundThrottling: false`.

## Jadwal: perbedaan dari Android

1. `startDate`/`endDate` dihormati (Android mengabaikannya).
2. Jendela lintas tengah malam (`start > end`, mis. 22:00-02:00) milik **hari dimulainya**: dini hari Selasa untuk jadwal "mon 22:00-02:00"
   dicek terhadap hari Senin dan tanggal sebelumnya. Android memeriksa hari kalender saat ini, sehingga bagian setelah tengah malam salah.
3. Dievaluasi ulang berkala saat idle (Android tidak punya timer).
Format tak terduga (zona waktu, jam, hari, tanggal) = boleh tayang. Batas jam inklusif sampai detik.

## Checklist uji manual (jalankan `npm run dev`, aktifkan device, siapkan konten di CMS)

1. Dua video H.264 + satu gambar dalam satu playlist: berputar berurutan, **tanpa layar hitam** antar video, gambar tampil sesuai durasi.
2. Satu video saja: berulang tanpa jeda panjang.
3. Ctrl+Shift+D membuka log: tidak ada baris "Lewati ..." untuk konten normal.
4. Matikan jaringan (atau hentikan backend): pemutaran lanjut dari cache; log "Tidak ada jaringan"/validasi tidak tersedia, penghitung tidak naik.
5. Ganti konten di CMS ("Perbarui konten") dan hapus satu booking: playlist berganti setelah sync berikutnya (maks 3 menit);
   file yang tidak dipakai terhapus setelah 30 menit.
6. Jadwal: atur satu konten ke jam yang belum tiba; konten itu dilewati, dan mulai tayang sendiri saat jamnya tiba.
7. Cabut kabel jaringan/matikan paksa aplikasi saat unduhan berjalan, nyalakan lagi: tidak ada file `.tmp` tersisa di folder cache.
8. Video HEVC/H.265 mungkin tidak bisa diputar di semua MiniPC (bergantung dukungan hardware); backend sebaiknya mentranskode ke H.264.

## Belum dikerjakan (M4)

Pelapor statistik tayang (`onItemCompleted` sudah tersedia sebagai callback engine), pengaturan direktori cache + validasi folder,
pemantauan ukuran cache dan sisa disk, pembersihan manual/otomatis (`ignoreGrace`), menu Pengaturan lengkap, release dari menu,
file kosong `playback-reporter.ts` dan `storage-stats.ts`. `src/main/services/schedule.ts` (kosong) tidak dipakai: logika jadwal ada di renderer
(`src/renderer/src/player/schedule.ts`); file kosong itu boleh dihapus.
