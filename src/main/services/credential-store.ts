import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SLOT_CAPACITY, DEFAULT_SLOT_DURATION_SECONDS } from '../config'

/** Abstraksi enkripsi; di Electron diisi safeStorage (DPAPI di Windows). Diinjeksi agar bisa diuji. */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface RegisteredCredentials {
  apiToken: string
  venueId: number | null
  name: string | null
  slotCapacity: number
  slotDurationSeconds: number
}

const DEVICE_FILE = 'device.json'
const CREDENTIALS_FILE = 'credentials.bin'
const MAX_DEVICE_CODE_LENGTH = 64

/**
 * Menyimpan identitas dan kredensial device.
 *
 *  - device.json (plaintext): hanya `deviceCode` (UUID). Ini BUKAN rahasia, dan sengaja dipisah dari token
 *    supaya identitas tetap utuh kalau kredensial hilang/tidak bisa didekripsi (mis. image Windows
 *    dikloning ke user lain). Dengan begitu admin bisa menerbitkan "kode reissue" dari CMS untuk
 *    device_code yang SAMA (DeviceRegistrationService::regenerateCredentialsCode) tanpa device jadi baru.
 *  - credentials.bin (terenkripsi): api_token dan konfigurasi dari server.
 */
export class CredentialStore {
  private cached: RegisteredCredentials | null | undefined

  constructor(
    private readonly dir: string,
    private readonly cipher: SecretCipher,
    private readonly generateUuid: () => string = randomUUID,
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    mkdirSync(dir, { recursive: true })
  }

  /** UUID permanen perangkat; dibuat sekali lalu disimpan. */
  getOrCreateDeviceCode(): string {
    const existing = this.readDeviceCode()
    if (existing) return existing
    return this.writeNewDeviceCode()
  }

  isRegistered(): boolean {
    return this.load() !== null
  }

  /** Mengembalikan kredensial, atau null kalau belum terdaftar / file rusak / tidak bisa didekripsi. */
  load(): RegisteredCredentials | null {
    if (this.cached !== undefined) return this.cached
    this.cached = this.readCredentials()
    return this.cached
  }

  saveRegistration(credentials: RegisteredCredentials): void {
    if (!this.cipher.isAvailable()) {
      throw new Error('Enkripsi penyimpanan (DPAPI) tidak tersedia; kredensial tidak disimpan.')
    }
    const payload = JSON.stringify(credentials)
    this.atomicWrite(join(this.dir, CREDENTIALS_FILE), this.cipher.encrypt(payload))
    this.cached = credentials
  }

  /** Menghapus kredensial terdaftar tapi MEMPERTAHANKAN device_code (release / token dicabut). */
  clearRegistration(): void {
    this.removeFile(join(this.dir, CREDENTIALS_FILE))
    this.cached = null
  }

  /** Menghapus semuanya termasuk device_code, lalu membuat UUID baru (reset identitas). */
  resetIdentity(): string {
    this.clearRegistration()
    this.removeFile(join(this.dir, DEVICE_FILE))
    return this.writeNewDeviceCode()
  }

  // ---- internal ----

  private readDeviceCode(): string | null {
    const file = join(this.dir, DEVICE_FILE)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { deviceCode?: unknown }
      const code = parsed.deviceCode
      if (typeof code === 'string' && code.length > 0 && code.length <= MAX_DEVICE_CODE_LENGTH) {
        return code
      }
      this.onWarn('device.json tidak valid; membuat device_code baru')
    } catch {
      this.onWarn('device.json rusak; membuat device_code baru')
    }
    return null
  }

  private writeNewDeviceCode(): string {
    const code = this.generateUuid()
    this.atomicWrite(
      join(this.dir, DEVICE_FILE),
      Buffer.from(JSON.stringify({ deviceCode: code }), 'utf8')
    )
    return code
  }

  private readCredentials(): RegisteredCredentials | null {
    const file = join(this.dir, CREDENTIALS_FILE)
    if (!existsSync(file)) return null
    try {
      if (!this.cipher.isAvailable()) {
        this.onWarn('enkripsi tidak tersedia; kredensial tidak dapat dibaca')
        return null
      }
      const parsed = JSON.parse(
        this.cipher.decrypt(readFileSync(file))
      ) as Partial<RegisteredCredentials>
      if (typeof parsed.apiToken !== 'string' || parsed.apiToken.length === 0) {
        this.onWarn('kredensial tersimpan tidak punya api_token; dianggap belum terdaftar')
        return null
      }
      return {
        apiToken: parsed.apiToken,
        venueId: typeof parsed.venueId === 'number' ? parsed.venueId : null,
        name: typeof parsed.name === 'string' ? parsed.name : null,
        slotCapacity:
          typeof parsed.slotCapacity === 'number' ? parsed.slotCapacity : DEFAULT_SLOT_CAPACITY,
        slotDurationSeconds:
          typeof parsed.slotDurationSeconds === 'number'
            ? parsed.slotDurationSeconds
            : DEFAULT_SLOT_DURATION_SECONDS
      }
    } catch {
      this.onWarn('kredensial rusak atau tidak bisa didekripsi; dianggap belum terdaftar')
      return null
    }
  }

  private atomicWrite(target: string, data: Buffer): void {
    const tmp = `${target}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, target)
  }

  private removeFile(file: string): void {
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch (error) {
      this.onWarn(`gagal menghapus ${file}: ${(error as Error).message}`)
    }
  }
}
