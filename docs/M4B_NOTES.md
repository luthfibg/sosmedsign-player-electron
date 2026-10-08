# M4b: menu Pengaturan, folder cache, tindakan manual

Tanggal: 7 Oktober 2026. Verifikasi otomatis: 294 tes, typecheck, ESLint, build.
**Belum diuji di jendela Electron sungguhan** (checklist di bawah).

## Cara membuka

**Ctrl+Shift+S** membuka menu Pengaturan; **Esc** menutup. Panel diagnostik tetap di **Ctrl+Shift+D** (membuka salah satu menutup yang lain).
Menu Pengaturan bisa dibuka juga saat device belum terdaftar (misalnya untuk memilih folder cache sebelum aktivasi).

## Isi menu

- **Perangkat:** status registrasi, nama, venue, ID perangkat (8 karakter pertama), versi aplikasi, alamat server, status sinkronisasi terakhir.
- **Sistem:** memori aplikasi (semua proses Electron) dan memori sistem; toggle **Jaga layar tetap menyala** (disimpan, berlaku langsung).
- **Penyimpanan:** jumlah dan ukuran cache, file tidak terpakai, sisa disk (dengan bilah, merah di atas 90%), item playlist siap/gagal,
  ukuran database, antrean statistik tayang. Diperbarui tiap 5 detik selama menu terbuka.
- **Tindakan:** Sync ulang paksa, Bersihkan cache sekarang, Verifikasi file cache, Lepaskan device (dengan konfirmasi).
- **Folder cache:** ganti folder dengan pratinjau dan pilihan *Pindahkan file lama* atau *Mulai kosong*; tombol *Kembalikan ke folder bawaan*.

## Aturan folder cache (`services/cache-dir.ts`)

Folder yang dipilih ditolak (dengan alasan yang ditampilkan) kalau:

- bukan path absolut, atau path menunjuk ke file;
- folder jaringan (UNC, `\\server\share`): koneksi yang putus akan menghentikan pemutaran;
- root drive, folder home pengguna atau folder induknya, `Windows`, `Program Files`, `Program Files (x86)` beserta isinya;
- folder tidak kosong yang **bukan** folder cache SosmedSign. Folder cache ditandai berkas `.sosmedsign-cache`; hanya file berpola
  `content_{id}_{hash}.{ext}` di dalamnya yang pernah dihapus cache manager.

Saat dipakai, folder dibuat, diuji bisa ditulis, dan diberi penanda. Pemeriksaan ini juga dijalankan **saat startup**: kalau folder khusus
tidak lagi bisa dipakai (drive eksternal dicabut, izin berubah), player memakai folder bawaan untuk sesi itu dan menampilkan peringatan
kuning di menu. Pengaturan pengguna tidak dihapus, jadi folder khusus dipakai lagi begitu tersedia.

## Memindahkan folder (`CacheManager.changeDirectory`)

Berjalan eksklusif terhadap sync (`runExclusive`: menunggu sync yang berjalan selesai, siklus berikutnya ditahan). Semua pemeriksaan (folder
sama, folder bersarang, validasi, bisa ditulis, ruang kosong di drive tujuan) dilakukan **sebelum ada yang berubah**; kalau gagal, folder lama
tetap dipakai utuh.

- **Pindahkan:** `rename`; lintas drive (EXDEV) memakai salin ke `.moving.tmp`, cocokkan ukuran, rename, lalu hapus sumber. File yang gagal
  dipindah dihitung dan sumbernya tetap ada. Ruang kosong di tujuan dicek (dengan cadangan 1 GiB) hanya untuk beda drive.
- **Mulai kosong:** file cache di folder lama dihapus.
- Setelah berganti, `verifyAndRepair({ checksum: false })` memeriksa keberadaan dan ukuran semua item: yang hilang langsung diunduh ulang.
  Pengaturan `cacheDir` disimpan di `settings.json` (null bila kembali ke folder bawaan).
- Playlist di database menyimpan **nama file**, bukan path, jadi tidak ada yang perlu dimigrasi.

## Tindakan manual

- **Bersihkan cache sekarang:** menghapus file cache yang tidak dipakai playlist aktif **tanpa masa tenggang 30 menit**. Berjalan eksklusif
  supaya file unduhan playlist baru yang belum aktif tidak ikut terhapus.
- **Verifikasi file cache:** ukuran + SHA-256 tiap file; yang rusak dihapus, yang hilang atau rusak diunduh ulang.
- **Sync ulang paksa:** sync dengan mengabaikan versi playlist.
- **Lepaskan device:** konfirmasi dulu; data lokal baru dihapus setelah server mengonfirmasi (aturan yang sama dengan sebelumnya).

## Perubahan perilaku yang ikut

- Setiap folder cache sekarang berisi berkas penanda `.sosmedsign-cache` (tes yang mendaftar isi folder perlu mengabaikannya).
- Kegagalan jaringan saat aktivasi kini menyebut penyebab teknisnya, mis. "(ECONNREFUSED: connect ECONNREFUSED 192.168.1.46:80)".
- `CacheManager.cleanupUnused` mengembalikan `{ deleted, freedBytes, deferred }`.
- `vitest.config.ts` ikut menjalankan `*.test.tsx` (tes komponen React memakai jsdom).

## Checklist uji manual

1. Ctrl+Shift+S membuka menu; angka penyimpanan masuk akal dibanding Explorer (folder `content_cache` di data aplikasi).
2. Ganti folder ke folder baru di drive lain (mis. `D:\SosmedSignCache`) dengan *Pindahkan*: pemutaran lanjut, file pindah, folder lama tinggal kosong.
3. Coba folder terlarang (`C:\`, folder home, `C:\Windows`, folder berisi dokumen): ditolak dengan alasan jelas.
4. Setelah folder berganti, restart aplikasi: folder baru tetap dipakai. Ganti nama folder khusus lalu restart: peringatan kuning muncul dan
   pemutaran memakai folder bawaan.
5. *Verifikasi file cache*: rusakkan satu file cache secara manual (ubah isinya), jalankan verifikasi, file diunduh ulang.
6. *Bersihkan cache sekarang* setelah menghapus booking di CMS: file konten itu langsung hilang.
7. Matikan "Jaga layar tetap menyala", biarkan layar redup sesuai pengaturan daya Windows, nyalakan lagi.
8. Lepaskan device dari menu: kembali ke layar aktivasi; kode aktivasi baru membuatnya terdaftar lagi.

## Belum dikerjakan (M5)

Mode kiosk yang dikunci (blokir Alt+F4/DevTools/pintasan), pemulihan otomatis saat crash, auto-start, installer `.exe`, auto-update,
penerbitan versi, dan pelaporan platform/versi ke CMS. Validasi codec H.264 di backend menunggu keputusanmu.
