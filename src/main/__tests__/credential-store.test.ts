import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { CredentialStore, type RegisteredCredentials } from '../services/credential-store'
import { fakeCipher, makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

const creds: RegisteredCredentials = {
  apiToken: 'token-rahasia-123',
  venueId: 7,
  name: 'Lobby',
  slotCapacity: 20,
  slotDurationSeconds: 15
}

function uuids(...values: string[]): () => string {
  let i = 0
  return () => values[i++] ?? `uuid-${i}`
}

describe('CredentialStore', () => {
  it('device_code dibuat sekali lalu permanen', () => {
    const dir = makeTempDir()
    const a = new CredentialStore(dir, fakeCipher(), uuids('uuid-A', 'uuid-B'))
    expect(a.getOrCreateDeviceCode()).toBe('uuid-A')
    expect(a.getOrCreateDeviceCode()).toBe('uuid-A')
    // instance baru (simulasi restart aplikasi) membaca dari disk
    const b = new CredentialStore(dir, fakeCipher(), uuids('uuid-B'))
    expect(b.getOrCreateDeviceCode()).toBe('uuid-A')
  })

  it('token tidak pernah tertulis plaintext di disk', () => {
    const dir = makeTempDir()
    const store = new CredentialStore(dir, fakeCipher())
    store.getOrCreateDeviceCode()
    store.saveRegistration(creds)
    const raw = readFileSync(join(dir, 'credentials.bin'), 'utf8')
    expect(raw).not.toContain('token-rahasia-123')
    expect(readFileSync(join(dir, 'device.json'), 'utf8')).not.toContain('token-rahasia-123')
  })

  it('kredensial bertahan setelah restart', () => {
    const dir = makeTempDir()
    new CredentialStore(dir, fakeCipher()).saveRegistration(creds)
    const reopened = new CredentialStore(dir, fakeCipher())
    expect(reopened.isRegistered()).toBe(true)
    expect(reopened.load()).toEqual(creds)
  })

  it('clearRegistration menghapus kredensial tapi mempertahankan device_code', () => {
    const dir = makeTempDir()
    const store = new CredentialStore(dir, fakeCipher(), uuids('uuid-A'))
    const code = store.getOrCreateDeviceCode()
    store.saveRegistration(creds)
    store.clearRegistration()
    expect(store.isRegistered()).toBe(false)
    expect(new CredentialStore(dir, fakeCipher()).isRegistered()).toBe(false)
    expect(store.getOrCreateDeviceCode()).toBe(code)
  })

  it('resetIdentity membuat device_code baru dan menghapus kredensial', () => {
    const dir = makeTempDir()
    const store = new CredentialStore(dir, fakeCipher(), uuids('uuid-A', 'uuid-B'))
    store.getOrCreateDeviceCode()
    store.saveRegistration(creds)
    expect(store.resetIdentity()).toBe('uuid-B')
    expect(store.isRegistered()).toBe(false)
    expect(store.getOrCreateDeviceCode()).toBe('uuid-B')
  })

  it('kredensial tidak bisa didekripsi: dianggap belum terdaftar, device_code utuh (jalur reissue)', () => {
    const dir = makeTempDir()
    const warnings: string[] = []
    const first = new CredentialStore(dir, fakeCipher(), uuids('uuid-A'))
    first.getOrCreateDeviceCode()
    first.saveRegistration(creds)
    writeFileSync(join(dir, 'credentials.bin'), Buffer.from('sampah-acak'))

    const reopened = new CredentialStore(dir, fakeCipher(), uuids('JANGAN-DIPAKAI'), (m) =>
      warnings.push(m)
    )
    expect(reopened.isRegistered()).toBe(false)
    expect(reopened.getOrCreateDeviceCode()).toBe('uuid-A')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('device.json rusak: membuat device_code baru', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'device.json'), '{bukan json')
    const store = new CredentialStore(dir, fakeCipher(), uuids('uuid-baru'))
    expect(store.getOrCreateDeviceCode()).toBe('uuid-baru')
  })

  it('menolak menyimpan kalau enkripsi tidak tersedia (tidak jatuh ke plaintext)', () => {
    const dir = makeTempDir()
    const store = new CredentialStore(dir, fakeCipher(false))
    expect(() => store.saveRegistration(creds)).toThrow(/DPAPI/)
    expect(store.isRegistered()).toBe(false)
  })
})
