import { describe, expect, it } from 'vitest'
import { createConfig, normalizeBaseUrl } from '../config'

describe('config', () => {
  it('menormalkan base URL dengan tepat satu slash di akhir', () => {
    expect(normalizeBaseUrl('http://192.168.1.3')).toBe('http://192.168.1.3/')
    expect(normalizeBaseUrl('http://192.168.1.3///')).toBe('http://192.168.1.3/')
    expect(normalizeBaseUrl('  https://cms.example.com/  ')).toBe('https://cms.example.com/')
  })

  it('menolak konfigurasi tanpa base URL', () => {
    expect(() => createConfig({})).toThrow(/MAIN_VITE_BACKEND_BASE_URL/)
    expect(() => createConfig({ baseUrl: '   ' })).toThrow()
  })

  it('host header kosong menjadi null', () => {
    expect(createConfig({ baseUrl: 'http://x', hostHeader: '  ' }).hostHeader).toBeNull()
    expect(createConfig({ baseUrl: 'http://x', hostHeader: 'sosmedsign.test' }).hostHeader).toBe(
      'sosmedsign.test'
    )
  })
})
