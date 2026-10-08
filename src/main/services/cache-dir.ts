import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

/** Hanya file dengan nama ini yang dibuat dan boleh dihapus cache manager; file lain di folder tidak disentuh. */
export const CACHE_FILE_PATTERN = /^content_\d+_[0-9a-f]{20}\.[a-z0-9]{1,8}$/

/** Penanda bahwa folder ini dimiliki cache SosmedSign (boleh dibersihkan otomatis). */
export const CACHE_MARKER_FILE = '.sosmedsign-cache'

export type CacheDirCheck =
  { ok: true; isNew: boolean; existingCacheFiles: number } | { ok: false; reason: string }

export interface CacheDirEnvironment {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

const POSIX_SYSTEM_DIRS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/proc',
  '/sbin',
  '/sys',
  '/usr'
]

/**
 * Memeriksa apakah sebuah folder aman dipakai sebagai folder cache. Pengguna boleh memilih folder bebas, tetapi
 * folder yang salah tidak boleh menjadi tempat pembersihan otomatis: root drive, folder home (atau induknya), folder
 * sistem, folder jaringan (UNC), atau folder berisi file lain yang bukan cache SosmedSign. Hanya file berpola cache
 * yang pernah dihapus cache manager, tetapi aturan ini menjaga agar kesalahan pilih folder tidak berakibat apa pun.
 */
export function validateCacheDir(dir: string, options: CacheDirEnvironment = {}): CacheDirCheck {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const isWindows = platform === 'win32'
  const p = isWindows ? path.win32 : path.posix
  const norm = (value: string): string => (isWindows ? value.toLowerCase() : value)

  if (typeof dir !== 'string' || dir.trim().length === 0) {
    return { ok: false, reason: 'Path folder belum diisi.' }
  }
  if (isWindows && /^[\\/]{2}/.test(dir.trim())) {
    return {
      ok: false,
      reason:
        'Folder jaringan (UNC) tidak didukung: koneksi yang putus akan menghentikan pemutaran.'
    }
  }
  if (!p.isAbsolute(dir)) {
    return { ok: false, reason: 'Path harus absolut (contoh: D:\\SosmedSignCache).' }
  }

  const resolved = p.resolve(dir)
  const target = norm(resolved)

  if (norm(p.parse(resolved).root) === target) {
    return { ok: false, reason: 'Tidak boleh memakai root drive sebagai folder cache.' }
  }

  const home = norm(p.resolve(options.home ?? homedir()))
  if (target === home || home.startsWith(target + p.sep)) {
    return { ok: false, reason: 'Tidak boleh memakai folder home pengguna atau folder induknya.' }
  }

  const protectedDirs = isWindows
    ? [env.windir, env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)']]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => norm(p.resolve(value)))
    : POSIX_SYSTEM_DIRS
  if (protectedDirs.some((dirPath) => target === dirPath || target.startsWith(dirPath + p.sep))) {
    return { ok: false, reason: 'Tidak boleh memakai folder sistem atau Program Files.' }
  }

  if (!existsSync(resolved)) return { ok: true, isNew: true, existingCacheFiles: 0 }

  try {
    if (!statSync(resolved).isDirectory()) {
      return { ok: false, reason: 'Path menunjuk ke sebuah file, bukan folder.' }
    }
    const entries = readdirSync(resolved)
    const hasMarker = entries.includes(CACHE_MARKER_FILE)
    if (entries.length > 0 && !hasMarker) {
      return {
        ok: false,
        reason:
          'Folder tidak kosong dan bukan folder cache SosmedSign. Pilih folder kosong atau buat folder baru.'
      }
    }
    return {
      ok: true,
      isNew: entries.length === 0,
      existingCacheFiles: entries.filter((name) => CACHE_FILE_PATTERN.test(name)).length
    }
  } catch (error) {
    return { ok: false, reason: `Folder tidak bisa dibaca: ${(error as Error).message}` }
  }
}

/** Membuat folder (kalau perlu), memastikan bisa ditulis, dan menulis penanda. Melempar Error berpesan jelas. */
export function prepareCacheDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${process.pid}.tmp`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    const marker = path.join(dir, CACHE_MARKER_FILE)
    if (!existsSync(marker)) writeFileSync(marker, 'SosmedSign Player content cache\n', 'utf8')
  } catch (error) {
    throw new Error(
      `Folder tidak bisa dipakai (pastikan drive ada dan bisa ditulis): ${(error as Error).message}`
    )
  }
}

export interface ChosenCacheDir {
  dir: string
  /** Alasan folder khusus tidak dipakai (null = dipakai sesuai pengaturan). */
  fallbackReason: string | null
}

/**
 * Menentukan folder cache saat startup. Folder khusus yang tidak lagi valid atau tidak bisa ditulis (mis. drive
 * eksternal dicabut) tidak boleh membuat aplikasi gagal start: player memakai folder bawaan untuk sesi ini dan
 * pengaturan pengguna dibiarkan, supaya folder khusus dipakai lagi begitu tersedia.
 */
export function chooseCacheDir(
  custom: string | null,
  defaultDir: string,
  options: CacheDirEnvironment = {}
): ChosenCacheDir {
  if (!custom) return { dir: defaultDir, fallbackReason: null }
  const check = validateCacheDir(custom, options)
  if (!check.ok) return { dir: defaultDir, fallbackReason: check.reason }
  try {
    prepareCacheDir(custom)
  } catch (error) {
    return { dir: defaultDir, fallbackReason: (error as Error).message }
  }
  return { dir: custom, fallbackReason: null }
}
