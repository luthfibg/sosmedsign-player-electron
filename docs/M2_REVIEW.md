# Review M2 (sync service + cache manager)

Tanggal: 1 Oktober 2026. Baseline: 63 tes lulus, typecheck dan build bersih. Setelah perbaikan: 67 tes lulus.

## Sudah diperbaiki (dengan tes regresi)

1. **Kunci cache tidak lagi memuat `checksum_sha256` dan `file_size`.** Sebelumnya, begitu patch backend checksum aktif
   (kolom itu berubah dari null ke nilai), nama file cache semua item berubah dan setiap player mengunduh ulang seluruh konten,
   termasuk memakan kuota bandwidth harian sistem. Kini kunci = `content_id` + URL; checksum dan ukuran tetap diverifikasi
   saat unduh dan saat cache hit. Konten yang diganti selalu mendapat URL baru (`confirmReplace`), jadi identitas tetap benar.
2. **Release/reset saat sync berjalan tidak lagi menghidupkan kembali data.** Sebelumnya unduhan yang masih berjalan akan
   mengaktifkan playlist dan menulis file cache setelah data dihapus. Kini `clearLocalData()` menaikkan penanda generasi;
   sync yang sedang berjalan membuang hasilnya, membersihkan cache, dan mengembalikan `aborted` tanpa sync-log.
3. **Sisa unduhan `.tmp` dibersihkan saat startup.** Listrik mati saat mengunduh (umum pada signage) meninggalkan file
   `*.tmp` unik yang sebelumnya tidak pernah dihapus (cleanup melewatinya) sampai device dilepas.
4. **Cache hanya menghapus file miliknya** (pola `content_{id}_{hash20}.{ext}`). Sebelumnya `cleanupUnused` dan `clear`
   menghapus semua isi folder, berbahaya begitu direktori cache bisa diatur pengguna (M4).

## Keputusan A, B, C: disetujui dan DITERAPKAN (lihat docs/M3_NOTES.md)

Ringkasan di bawah dipertahankan sebagai riwayat alasan.

A. **Token ditolak (401/403 JSON) langsung melepas device dan menghapus seluruh cache.** Backend punya kode reissue
   untuk menerbitkan ulang token; setelah itu token lama ditolak, player menghapus semua konten, lalu harus mengunduh ulang
   semuanya. Usul: hitung lewat masa tenggang yang sama dengan validasi registrasi, dan pertahankan data untuk alasan
   "kredensial tidak valid" (hanya hapus data untuk release dan pelepasan dari CMS).
B. **Snapshot kosong (`playlist: []`) diabaikan.** Kalau semua booking berakhir atau dihapus, player memutar konten lama
   selamanya dan cache tidak pernah dibersihkan, bertentangan dengan tujuan mirror sync. Usul: terima snapshot kosong yang valid
   dari API kita, dengan masa tenggang sebelum file dihapus.
C. **Validasi yang "tidak tersedia" (server mati/timeout) ikut dihitung menuju 120 kegagalan.** Server atau ISP bermasalah
   sekitar 6 jam, sementara jaringan lokal hidup, akan menghapus semua konten dan mengembalikan layar aktivasi. Usul: hanya
   jawaban pasti "pending" dari server yang dihitung, dan simpan penghitung di database (saat ini di memori, sehingga hilang
   setiap restart; MiniPC yang dimatikan tiap malam tidak pernah mencapai 120).

## Celah yang dikerjakan di M4 (manajemen storage)

- Belum ada pengecekan sisa disk sebelum mengunduh (disk penuh hanya muncul sebagai kegagalan unduh, tiga kali).
- Belum ada validasi direktori cache (tolak root drive, folder home/sistem, folder berisi file lain) dan penanda folder.
- Hapus file yatim masih langsung (tanpa masa tenggang), dan `isValidCache` menghitung hash penuh setiap file pada tiap
  playlist baru (I/O besar untuk video berukuran GB).
- Statistik cache dan disk untuk menu Pengaturan belum ada (`storage-stats.ts` masih kosong).
- Tes sync memakai FakeDatabase yang mencocokkan potongan string SQL, jadi SQL sungguhan di `SyncService` belum teruji.
  Pertimbangkan antarmuka store (seperti `PlaylistStore`) agar logika bisa diuji dengan implementasi di memori.
