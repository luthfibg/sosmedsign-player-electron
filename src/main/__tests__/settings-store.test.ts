import { existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../services/settings-store'
import { makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

const fileIn = (dir: string): string => join(dir, 'settings.json')
const absolute = process.platform === 'win32' ? 'D:\\SosmedSignCache' : '/mnt/media/cache'

describe('SettingsStore', () => {
  it('returns the defaults when no settings file exists', () => {
    expect(new SettingsStore(fileIn(makeTempDir())).get()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toEqual({ cacheDir: null, keepScreenOn: true })
  })

  it('persists updates across restarts and keeps untouched fields', () => {
    const dir = makeTempDir()
    const first = new SettingsStore(fileIn(dir))
    first.update({ keepScreenOn: false })
    first.update({ cacheDir: absolute })

    const reopened = new SettingsStore(fileIn(dir))
    expect(reopened.get()).toEqual({ cacheDir: absolute, keepScreenOn: false })
  })

  it('writes atomically (no temp file left behind)', () => {
    const dir = makeTempDir()
    new SettingsStore(fileIn(dir)).update({ keepScreenOn: false })
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('falls back to defaults for a corrupt file and reports it', () => {
    const dir = makeTempDir()
    writeFileSync(fileIn(dir), '{bukan json')
    const warnings: string[] = []
    const store = new SettingsStore(fileIn(dir), (m) => warnings.push(m))
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(warnings).toHaveLength(1)
  })

  it('sanitizes each field independently', () => {
    const dir = makeTempDir()
    writeFileSync(
      fileIn(dir),
      JSON.stringify({ cacheDir: 'relatif/folder', keepScreenOn: 'ya', lainnya: 1 })
    )
    expect(new SettingsStore(fileIn(dir)).get()).toEqual(DEFAULT_SETTINGS)

    writeFileSync(fileIn(dir), JSON.stringify({ cacheDir: absolute, keepScreenOn: 'ya' }))
    expect(new SettingsStore(fileIn(dir)).get()).toEqual({ cacheDir: absolute, keepScreenOn: true })
  })

  it('rejects invalid values given to update() instead of storing them', () => {
    const store = new SettingsStore(fileIn(makeTempDir()))
    store.update({ cacheDir: '  ' })
    expect(store.get().cacheDir).toBeNull()
    store.update({ cacheDir: absolute })
    store.update({ cacheDir: null })
    expect(store.get().cacheDir).toBeNull()
  })

  it('does not create the file until something is saved, and get() returns copies', () => {
    const dir = makeTempDir()
    const store = new SettingsStore(fileIn(dir))
    store.get().keepScreenOn = false
    expect(store.get().keepScreenOn).toBe(true)
    expect(existsSync(fileIn(dir))).toBe(false)
  })
})
