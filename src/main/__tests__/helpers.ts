import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach } from 'vitest'
import type { SecretCipher } from '../services/credential-store'

const dirs: string[] = []

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sosmedsign-test-'))
  dirs.push(dir)
  return dir
}

export function registerTempDirCleanup(): void {
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })
}

/** Cipher palsu: membalik string + penanda, cukup untuk membuktikan file tidak plaintext. */
export function fakeCipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`ENC:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decrypt: (data) => {
      const text = data.toString('utf8')
      if (!text.startsWith('ENC:')) throw new Error('bukan data terenkripsi')
      return Buffer.from(text.slice(4), 'base64').toString('utf8')
    }
  }
}
