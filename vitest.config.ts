import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Tes main di src/main, tes logika pemutar di src/renderer (yang butuh DOM memakai
    // `// @vitest-environment jsdom` di baris pertama file-nya).
    include: ['src/**/*.test.ts']
  }
})
