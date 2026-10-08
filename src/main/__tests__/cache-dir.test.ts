import { mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  CACHE_FILE_PATTERN,
  CACHE_MARKER_FILE,
  type CacheDirEnvironment,
  chooseCacheDir,
  prepareCacheDir,
  validateCacheDir
} from '../services/cache-dir'
import { makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

const windows = {
  platform: 'win32' as const,
  home: 'C:\\Users\\luthfi',
  env: {
    windir: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)'
  } as NodeJS.ProcessEnv
}
const linux = { platform: 'linux' as const, home: '/home/luthfi', env: {} as NodeJS.ProcessEnv }

const reason = (dir: string, options: CacheDirEnvironment = windows): string => {
  const check = validateCacheDir(dir, options)
  if (check.ok) throw new Error(`diharapkan ditolak: ${dir}`)
  return check.reason
}

describe('validateCacheDir (aturan Windows)', () => {
  it('accepts a fresh folder on another drive, with or without a trailing slash', () => {
    expect(validateCacheDir('D:\\SosmedSignCache', windows)).toEqual({
      ok: true,
      isNew: true,
      existingCacheFiles: 0
    })
    expect(validateCacheDir('D:\\SosmedSignCache\\', windows).ok).toBe(true)
    expect(validateCacheDir('C:\\Users\\luthfi\\Videos\\cache', windows).ok).toBe(true)
  })

  it('rejects blank and relative paths', () => {
    expect(reason('')).toMatch(/belum diisi/)
    expect(reason('   ')).toMatch(/belum diisi/)
    expect(reason('cache\\konten')).toMatch(/absolut/)
    expect(reason('.\\cache')).toMatch(/absolut/)
  })

  it('rejects network (UNC) folders', () => {
    expect(reason('\\\\server\\share\\cache')).toMatch(/UNC/)
    expect(reason('//server/share/cache')).toMatch(/UNC/)
  })

  it('rejects drive roots in any letter case', () => {
    expect(reason('C:\\')).toMatch(/root drive/)
    expect(reason('d:\\')).toMatch(/root drive/)
    expect(reason('D:')).toMatch(/absolut/) // "D:" berarti folder kerja di drive D, bukan akar drive
  })

  it('rejects the user home folder and its parents, but not folders inside it', () => {
    expect(reason('C:\\Users\\luthfi')).toMatch(/home/)
    expect(reason('c:\\users\\LUTHFI')).toMatch(/home/)
    expect(reason('C:\\Users')).toMatch(/home/)
    expect(validateCacheDir('C:\\Users\\luthfi\\SosmedSign', windows).ok).toBe(true)
  })

  it('rejects the Windows folder and Program Files (case-insensitive, including subfolders)', () => {
    expect(reason('C:\\Windows')).toMatch(/sistem/)
    expect(reason('c:\\windows\\system32\\cache')).toMatch(/sistem/)
    expect(reason('C:\\Program Files\\SosmedSign\\cache')).toMatch(/sistem/)
    expect(reason('C:\\Program Files (x86)\\X')).toMatch(/sistem/)
    expect(validateCacheDir('C:\\Program Files Data\\cache', windows).ok).toBe(true) // bukan subfolder
  })
})

describe('validateCacheDir (aturan POSIX untuk pengembangan)', () => {
  it('rejects root, home, and system folders, and accepts a normal folder', () => {
    expect(reason('/', linux)).toMatch(/root/)
    expect(reason('/home/luthfi', linux)).toMatch(/home/)
    expect(reason('/home', linux)).toMatch(/home/)
    expect(reason('/etc/sosmedsign', linux)).toMatch(/sistem/)
    expect(validateCacheDir('/mnt/media/cache', linux).ok).toBe(true)
  })
})

describe('validateCacheDir (isi folder)', () => {
  const real: CacheDirEnvironment =
    process.platform === 'win32' ? windows : { ...linux, home: '/nonexistent-home' }

  it('accepts an existing empty folder', () => {
    expect(validateCacheDir(makeTempDir(), real)).toEqual({
      ok: true,
      isNew: true,
      existingCacheFiles: 0
    })
  })

  it('rejects a non-empty folder that is not a SosmedSign cache', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'dokumen.docx'), 'x')
    expect(reason(dir, real)).toMatch(/bukan folder cache SosmedSign/)
  })

  it('accepts a marked cache folder and counts the cache files already in it', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, CACHE_MARKER_FILE), '')
    writeFileSync(join(dir, `content_1_${'a'.repeat(20)}.mp4`), 'x')
    writeFileSync(join(dir, `content_2_${'b'.repeat(20)}.png`), 'x')
    writeFileSync(join(dir, 'catatan.txt'), 'x')
    expect(validateCacheDir(dir, real)).toEqual({ ok: true, isNew: false, existingCacheFiles: 2 })
  })

  it('rejects a path that is a file', () => {
    const file = join(makeTempDir(), 'berkas.txt')
    writeFileSync(file, 'x')
    expect(reason(file, real)).toMatch(/file, bukan folder/)
  })
})

describe('prepareCacheDir', () => {
  it('creates the folder with the marker and leaves no probe file behind', () => {
    const dir = join(makeTempDir(), 'a', 'b', 'cache')
    prepareCacheDir(dir)
    expect(readdirSync(dir)).toEqual([CACHE_MARKER_FILE])
  })

  it('is idempotent and keeps existing files', () => {
    const dir = makeTempDir()
    const file = `content_1_${'a'.repeat(20)}.mp4`
    writeFileSync(join(dir, file), 'data')
    prepareCacheDir(dir)
    prepareCacheDir(dir)
    expect(readdirSync(dir).sort()).toEqual([CACHE_MARKER_FILE, file].sort())
  })

  it('throws a clear error when the folder cannot be created', () => {
    const blocker = join(makeTempDir(), 'berkas')
    writeFileSync(blocker, 'x')
    expect(() => prepareCacheDir(join(blocker, 'cache'))).toThrow(/tidak bisa dipakai/)
  })
})

describe('chooseCacheDir (startup)', () => {
  const real: CacheDirEnvironment =
    process.platform === 'win32' ? windows : { ...linux, home: '/nonexistent-home' }
  const fallback = join(makeTempDir(), 'bawaan')

  it('uses the default folder when no custom folder is configured', () => {
    expect(chooseCacheDir(null, fallback, real)).toEqual({ dir: fallback, fallbackReason: null })
  })

  it('uses a valid custom folder and prepares it', () => {
    const custom = join(makeTempDir(), 'cache')
    expect(chooseCacheDir(custom, fallback, real)).toEqual({ dir: custom, fallbackReason: null })
    expect(readdirSync(custom)).toEqual([CACHE_MARKER_FILE])
  })

  it('falls back to the default folder (never crashes) when the custom folder became invalid', () => {
    const foreign = makeTempDir()
    writeFileSync(join(foreign, 'dokumen.docx'), 'x')
    const result = chooseCacheDir(foreign, fallback, real)
    expect(result.dir).toBe(fallback)
    expect(result.fallbackReason).toMatch(/bukan folder cache/)
  })

  it('falls back when the custom folder cannot be created (e.g. a removed drive)', () => {
    const blocker = join(makeTempDir(), 'berkas')
    writeFileSync(blocker, 'x')
    const result = chooseCacheDir(join(blocker, 'cache'), fallback, real)
    expect(result.dir).toBe(fallback)
    expect(result.fallbackReason).toMatch(/tidak bisa dipakai/)
  })
})

describe('CACHE_FILE_PATTERN', () => {
  it('matches only names the cache manager creates', () => {
    expect(CACHE_FILE_PATTERN.test(`content_12_${'0'.repeat(20)}.mp4`)).toBe(true)
    for (const bad of [
      'content_12_abc.mp4',
      'notes.txt',
      `content_x_${'a'.repeat(20)}.mp4`,
      '.sosmedsign-cache'
    ]) {
      expect(CACHE_FILE_PATTERN.test(bad)).toBe(false)
    }
    mkdirSync(makeTempDir(), { recursive: true })
  })
})
