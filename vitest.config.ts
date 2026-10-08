import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Tes main di src/main, tes logika pemutar di src/renderer (yang butuh DOM memakai
    // `// @vitest-environment jsdom` di baris pertama file-nya).
    include: ['src/**/*.test.{ts,tsx}'],
    // Batasi jumlah worker paralel. Vitest membatalkan jalannya tes kalau satu worker butuh lebih dari 60 detik untuk
    // menyala (batas itu tetap, tidak bisa diatur). Di Windows dengan antivirus aktif, membuka belasan proses Node
    // sekaligus (lebih-lebih yang memuat jsdom) bisa melewati batas itu.
    maxWorkers: 4
  }
})
