import { safeStorage } from 'electron'
import type { SecretCipher } from './credential-store'

/** Implementasi SecretCipher berbasis Electron safeStorage (DPAPI di Windows). Hanya valid setelah app ready. */
export function createSafeStorageCipher(): SecretCipher {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data)
  }
}
