import { ACTIVATION_CODE_LENGTH } from '../config'
import { ApiNetworkError, type ApiClient } from './api-client'
import type { CredentialStore } from './credential-store'
import type { Diagnostics } from './diagnostics'

export type ActivationOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid-format' | 'rejected' | 'network' | 'server'; message: string }

/** Hasil validasi registrasi ke server (dipakai loop sync di M2). */
export type RegistrationValidation =
  { kind: 'registered' } | { kind: 'pending' } | { kind: 'unavailable'; reason: string }

export type ReleaseOutcome = { ok: true } | { ok: false; message: string }

type StateListener = (state: DeviceStateDto) => void

/**
 * Mengapa registrasi lokal dihapus (menentukan data lokal mana yang ikut dihapus):
 *  - released: pengguna melepas device dari menu (server sudah konfirmasi)  -> hapus playlist + cache
 *  - identity-reset: pengguna mereset identitas (device_code baru)           -> hapus playlist + cache
 *  - unregistered: server berulang kali menyatakan device tidak terdaftar    -> hapus playlist + cache
 *  - credentials-invalid: token ditolak berulang padahal device masih terdaftar (mis. token diterbitkan ulang)
 *    -> data DIPERTAHANKAN, supaya aktivasi ulang dengan kode reissue tidak mengunduh ulang semuanya
 */
export type RegistrationClearedReason =
  'released' | 'identity-reset' | 'unregistered' | 'credentials-invalid'

type ClearedListener = (reason: RegistrationClearedReason) => void

const NETWORK_MESSAGE = 'Tidak dapat terhubung ke server. Periksa koneksi jaringan lalu coba lagi.'

export function normalizeActivationCode(raw: string): string {
  return raw.trim().toUpperCase()
}

export class DeviceService {
  private readonly listeners = new Set<StateListener>()
  private readonly clearedListeners = new Set<ClearedListener>()

  constructor(
    private readonly api: ApiClient,
    private readonly credentials: CredentialStore,
    private readonly diagnostics: Diagnostics
  ) {}

  getState(): DeviceStateDto {
    const creds = this.credentials.load()
    return {
      registered: creds !== null,
      deviceCode: this.credentials.getOrCreateDeviceCode(),
      venueId: creds?.venueId ?? null,
      deviceName: creds?.name ?? null
    }
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Dipanggil setiap registrasi lokal dihapus; sync service memakainya untuk berhenti dan membersihkan data. */
  onRegistrationCleared(listener: ClearedListener): () => void {
    this.clearedListeners.add(listener)
    return () => {
      this.clearedListeners.delete(listener)
    }
  }

  /** Menukar kode aktivasi dari CMS dengan api_token (POST /api/devices/activate). */
  async activate(rawCode: string): Promise<ActivationOutcome> {
    const code = normalizeActivationCode(rawCode)
    if (!new RegExp(`^[A-Z0-9]{${ACTIVATION_CODE_LENGTH}}$`).test(code)) {
      return {
        ok: false,
        reason: 'invalid-format',
        message: `Kode aktivasi harus ${ACTIVATION_CODE_LENGTH} karakter huruf/angka.`
      }
    }

    const deviceCode = this.credentials.getOrCreateDeviceCode()
    this.diagnostics.log(`Aktivasi: mengirim kode (${code.length} karakter)`)

    let result
    try {
      result = await this.api.activate(code, deviceCode)
    } catch (error) {
      const detail = (error as Error).message
      this.diagnostics.log(`Aktivasi gagal (jaringan): ${detail}`)
      // Sebutkan penyebab teknisnya (mis. ECONNREFUSED 192.168.1.46:80) supaya pemasang tidak perlu membuka log.
      return {
        ok: false,
        reason: 'network',
        message: `${NETWORK_MESSAGE} (${detail.slice(0, 160)})`
      }
    }

    if (result.status === 200) {
      const body = result.json
      if (!body || typeof body.api_token !== 'string' || body.api_token.length === 0) {
        this.diagnostics.log('Aktivasi: respons 200 tanpa api_token')
        return {
          ok: false,
          reason: 'server',
          message: 'Respons server tidak valid. Hubungi admin.'
        }
      }
      this.credentials.saveRegistration({
        apiToken: body.api_token,
        venueId: typeof body.venue_id === 'number' ? body.venue_id : null,
        name: typeof body.name === 'string' ? body.name : null,
        slotCapacity: body.slot_capacity,
        slotDurationSeconds: body.slot_duration_seconds
      })
      this.diagnostics.log(`Aktivasi berhasil (venue ${body.venue_id ?? '-'})`)
      this.emit()
      return { ok: true }
    }

    if (result.status === 422 && result.isApiMessage && result.message) {
      this.diagnostics.log(`Aktivasi ditolak: ${result.message}`)
      return { ok: false, reason: 'rejected', message: result.message }
    }
    if (result.status === 429) {
      this.diagnostics.log('Aktivasi: terlalu banyak percobaan (429)')
      return {
        ok: false,
        reason: 'server',
        message: 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.'
      }
    }
    this.diagnostics.log(`Aktivasi: server membalas status ${result.status}`)
    return {
      ok: false,
      reason: 'server',
      message: `Server membalas status ${result.status}. Coba lagi nanti.`
    }
  }

  /**
   * Validasi ke server bahwa device masih terdaftar (endpoint publik registration-status).
   * Hanya status HTTP + body JSON API kita yang dipercaya; selain itu dianggap "unavailable",
   * bukan "dilepas" (lihat masa tenggang 120 kegagalan di docs bagian 4.3).
   */
  async validateRegistration(): Promise<RegistrationValidation> {
    const deviceCode = this.credentials.getOrCreateDeviceCode()
    try {
      const result = await this.api.registrationStatus(deviceCode)
      if (result.status === 200 && result.json) {
        if (result.json.registration_status === 'registered') return { kind: 'registered' }
        if (result.json.registration_status === 'pending') return { kind: 'pending' }
        return { kind: 'unavailable', reason: 'status registrasi tidak dikenal' }
      }
      if (result.status === 404 && result.isApiMessage) return { kind: 'pending' }
      return { kind: 'unavailable', reason: `HTTP ${result.status}` }
    } catch (error) {
      return { kind: 'unavailable', reason: (error as Error).message }
    }
  }

  /**
   * Melepas device dari venue/akun (DELETE /release). 401/403/404 dianggap sukses (idempoten).
   * Kredensial lokal baru dihapus SETELAH server konfirmasi. Penghapusan cache/playlist dipasang di M2.
   */
  async release(): Promise<ReleaseOutcome> {
    const creds = this.credentials.load()
    if (!creds) return { ok: true }
    const deviceCode = this.credentials.getOrCreateDeviceCode()

    let result
    try {
      result = await this.api.release(deviceCode, creds.apiToken)
    } catch (error) {
      if (error instanceof ApiNetworkError) {
        this.diagnostics.log(`Release gagal (jaringan): ${error.message}`)
        return { ok: false, message: NETWORK_MESSAGE }
      }
      throw error
    }

    const idempotent = [200, 401, 403, 404].includes(result.status)
    if (idempotent) {
      this.forgetRegistration('released', `release (HTTP ${result.status})`)
      return { ok: true }
    }
    if (result.status === 422 && result.isApiMessage && result.message) {
      return { ok: false, message: result.message }
    }
    this.diagnostics.log(`Release: server membalas status ${result.status}`)
    return { ok: false, message: `Server membalas status ${result.status}. Coba lagi nanti.` }
  }

  /** Hapus kredensial terdaftar tapi pertahankan device_code. Pendengar menentukan data lokal mana yang ikut dihapus. */
  forgetRegistration(reason: RegistrationClearedReason, detail: string): void {
    this.credentials.clearRegistration()
    this.diagnostics.log(`Registrasi dihapus (${reason}): ${detail}`)
    this.emitCleared(reason)
    this.emit()
  }

  /** Reset identitas: hapus semuanya termasuk device_code (UUID baru) dan bersihkan log diagnostik. */
  resetIdentity(): void {
    this.credentials.resetIdentity()
    this.diagnostics.clear()
    this.diagnostics.log('Identitas device direset (device_code baru)')
    this.emitCleared('identity-reset')
    this.emit()
  }

  private emitCleared(reason: RegistrationClearedReason): void {
    for (const listener of this.clearedListeners) listener(reason)
  }

  private emit(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}
