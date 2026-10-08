import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, isAbsolute } from 'path'

export interface PlayerSettings {
  /** Folder cache khusus; null = folder bawaan di data aplikasi. */
  cacheDir: string | null
  /** Cegah layar mati/redup saat menayangkan konten (setara Keep screen on di Android). */
  keepScreenOn: boolean
}

export const DEFAULT_SETTINGS: PlayerSettings = { cacheDir: null, keepScreenOn: true }

/**
 * Pengaturan pengguna yang bukan rahasia (settings.json di data aplikasi). Pembacaan tidak pernah melempar:
 * file hilang, rusak, atau berisi nilai aneh jatuh ke nilai bawaan per bidang, supaya player tetap bisa start.
 */
export class SettingsStore {
  private cached: PlayerSettings | null = null

  constructor(
    private readonly file: string,
    private readonly onWarn: (message: string) => void = () => {}
  ) {}

  get(): PlayerSettings {
    if (!this.cached) this.cached = this.read()
    return { ...this.cached }
  }

  update(patch: Partial<PlayerSettings>): PlayerSettings {
    const next = sanitize({ ...this.get(), ...patch })
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, this.file)
    this.cached = next
    return { ...next }
  }

  private read(): PlayerSettings {
    if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS }
    try {
      return sanitize(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      this.onWarn('settings.json rusak; memakai pengaturan bawaan')
      return { ...DEFAULT_SETTINGS }
    }
  }
}

function sanitize(value: unknown): PlayerSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<PlayerSettings>
  return {
    cacheDir:
      typeof raw.cacheDir === 'string' && raw.cacheDir.trim().length > 0 && isAbsolute(raw.cacheDir)
        ? raw.cacheDir
        : null,
    keepScreenOn:
      typeof raw.keepScreenOn === 'boolean' ? raw.keepScreenOn : DEFAULT_SETTINGS.keepScreenOn
  }
}
