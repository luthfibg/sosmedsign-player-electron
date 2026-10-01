/**
 * Konfigurasi player. Nilai runtime dibaca dari env build-time electron-vite
 * (file .env.development / .env.production, variabel berawalan MAIN_VITE_).
 *
 * Konstanta perilaku di bawah disalin dari player Android (lihat docs/ANDROID_PLAYER_LOGIC.md)
 * supaya perilakunya tetap sama.
 */

export interface AppConfig {
  /** Base URL backend, selalu diakhiri "/" dan TANPA "/api". */
  baseUrl: string
  /** Header Host khusus dev. Kosong di produksi. */
  hostHeader: string | null
  connectTimeoutMs: number
  requestTimeoutMs: number
}

export const SYNC_INTERVAL_MS = 3 * 60 * 1000
/** 120 kegagalan validasi beruntun x 3 menit = ~6 jam sebelum device dianggap dilepas. */
export const OFFLINE_GRACE_VALIDATION_FAILURES = 120
export const ACTIVATION_CODE_LENGTH = 8
/** Charset kode aktivasi di backend: tanpa 0, O, 1, I, L (karakter ambigu). */
export const ACTIVATION_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const DIAGNOSTICS_MAX_ENTRIES = 120
export const DEFAULT_SLOT_CAPACITY = 20
export const DEFAULT_SLOT_DURATION_SECONDS = 15

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return `${trimmed}/`
}

export function createConfig(env: { baseUrl?: string; hostHeader?: string }): AppConfig {
  const baseUrl = env.baseUrl?.trim()
  if (!baseUrl) {
    throw new Error(
      'MAIN_VITE_BACKEND_BASE_URL belum diisi. Buat .env.development / .env.production di root proyek.'
    )
  }
  const hostHeader = env.hostHeader?.trim() || null
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    hostHeader,
    connectTimeoutMs: 20_000,
    requestTimeoutMs: 30_000
  }
}

export function loadConfig(): AppConfig {
  return createConfig({
    baseUrl: import.meta.env.MAIN_VITE_BACKEND_BASE_URL,
    hostHeader: import.meta.env.MAIN_VITE_BACKEND_HOST_HEADER
  })
}
