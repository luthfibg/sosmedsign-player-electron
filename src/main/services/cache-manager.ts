import { createHash, randomUUID } from 'crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync
} from 'fs'
import { copyFile, statfs } from 'fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { Agent, request } from 'undici'
import { Transform, type Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { AppConfig } from '../config'
import type { PlaylistItemDto } from './api-types'
import { CACHE_FILE_PATTERN, prepareCacheDir, validateCacheDir } from './cache-dir'

const DEFAULT_ORPHAN_GRACE_MS = 30 * 60 * 1000
/** Ruang disk yang selalu disisakan: Windows dan log butuh ruang kerja, dan disk penuh membuat MiniPC tidak stabil. */
export const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024

const MAX_ATTEMPTS = 3
const DOWNLOAD_BODY_TIMEOUT_MS = 60_000
const DELETE_RETRY_INTERVAL_MS = 5_000

export interface DownloadResult {
  ok: boolean
  path: string | null
  bytesDownloaded: number
  released: boolean
  error: string | null
  /** true kalau gagal karena ruang disk tidak cukup (tidak diulang; bukan kesalahan jaringan). */
  diskFull?: boolean
}

export interface DiskSpace {
  free: number
  total: number
}

export type FileVerdict = 'ok' | 'missing' | 'corrupt'

/** move = pindahkan file cache lama ke folder baru; fresh = mulai kosong (file lama dihapus, konten diunduh ulang). */
export type CacheDirMode = 'move' | 'fresh'

export interface RelocationResult {
  newDir: string
  moved: number
  failed: number
  /** Hanya mode fresh: file cache lama yang dihapus. */
  removed: number
}

export interface CleanupResult {
  deleted: number
  freedBytes: number
  /** Gagal dihapus (mis. sedang dipakai); dicoba lagi otomatis. */
  deferred: number
}

export interface CacheManagerOptions {
  /** Cadangan ruang disk minimal (default 1 GiB). */
  minFreeBytes?: number
  diskSpaceFn?: (dir: string) => Promise<DiskSpace | null>
  /** File yang tidak lagi dipakai playlist baru dihapus setelah selang ini (default 30 menit). */
  orphanGraceMs?: number
  now?: () => number
  /** Operasi file untuk pemindahan folder; diganti di tes untuk mensimulasikan beda drive (EXDEV). */
  fileOps?: {
    rename: (from: string, to: string) => void
    copyFile: (from: string, to: string) => Promise<void>
  }
  /** Penentu dua folder berada di drive yang sama; diganti di tes untuk mensimulasikan drive berbeda. */
  sameVolumeFn?: (a: string, b: string) => boolean
}

interface ContentResponse {
  statusCode: number
  body: Readable
  headers?: Record<string, string | string[] | undefined>
}

type ContentRequester = (url: URL, headers: Record<string, string>) => Promise<ContentResponse>

/** Cache konten versi-spesifik, dengan penulisan temp lalu rename atomik. */
export class CacheManager {
  private readonly agent: Agent
  private readonly requestContent: ContentRequester
  private readonly pendingDelete = new Set<string>()
  private deleteRetryTimer: NodeJS.Timeout | null = null
  private readonly orphanGraceMs: number
  private readonly now: () => number
  private readonly minFreeBytes: number
  private readonly diskSpaceFn: (dir: string) => Promise<DiskSpace | null>
  private readonly fileOps: NonNullable<CacheManagerOptions['fileOps']>
  private readonly sameVolumeFn: (a: string, b: string) => boolean

  constructor(
    private cacheDir: string,
    private readonly config: AppConfig,
    requester?: ContentRequester,
    private readonly warn: (message: string) => void = () => {},
    options: CacheManagerOptions = {}
  ) {
    this.orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS
    this.now = options.now ?? Date.now
    this.minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES
    this.diskSpaceFn = options.diskSpaceFn ?? defaultDiskSpace
    this.fileOps = options.fileOps ?? {
      rename: renameSync,
      copyFile: (from, to) => copyFile(from, to)
    }
    this.sameVolumeFn = options.sameVolumeFn ?? sameVolumeOnDisk
    prepareCacheDir(cacheDir)
    this.removeStaleTempFiles()
    this.agent = new Agent({ connect: { timeout: config.connectTimeoutMs } })
    this.requestContent =
      requester ??
      ((url, headers) =>
        request(url, {
          method: 'GET',
          headers,
          dispatcher: this.agent,
          headersTimeout: config.requestTimeoutMs,
          bodyTimeout: DOWNLOAD_BODY_TIMEOUT_MS
        }))
  }

  async download(item: PlaylistItemDto): Promise<DownloadResult> {
    let url: URL
    let useBackendHostHeader = false
    try {
      url = new URL(item.content_url, this.config.baseUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('URL konten harus menggunakan HTTP atau HTTPS')
      }
      if (this.config.hostHeader && isLocalHost(url.hostname)) {
        const backendUrl = new URL(this.config.baseUrl)
        url = new URL(`${url.pathname}${url.search}${url.hash}`, backendUrl)
        useBackendHostHeader = true
      }
    } catch (error) {
      return failed(0, errorMessage(error))
    }

    const target = this.cachePath(item, url)
    if (await this.isValidCache(target, item)) {
      return { ok: true, path: target, bytesDownloaded: 0, released: false, error: null }
    }

    let bytesDownloaded = 0
    let lastError = 'unduhan gagal'
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const temporary = `${target}.${randomUUID()}.tmp`
      let attemptBytes = 0
      try {
        const headers: Record<string, string> = { accept: '*/*' }
        if (useBackendHostHeader && this.config.hostHeader) {
          headers.host = this.config.hostHeader
        }
        const response = await this.requestContent(url, headers)
        if (response.statusCode === 401 || response.statusCode === 403) {
          if (await isApiMessageBody(response.body)) {
            return {
              ok: false,
              path: null,
              bytesDownloaded,
              released: true,
              error: `HTTP ${response.statusCode}`
            }
          }
          throw new Error(`HTTP ${response.statusCode}`)
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.body.destroy()
          throw new Error(`HTTP ${response.statusCode}`)
        }

        const needed = item.file_size ?? headerLength(response.headers)
        if (needed > 0 && !(await this.hasRoomFor(needed))) {
          response.body.destroy()
          return {
            ...failed(
              bytesDownloaded,
              `ruang disk tidak cukup untuk ${formatBytes(needed)} (cadangan ${formatBytes(this.minFreeBytes)})`
            ),
            diskFull: true
          }
        }

        const hash = createHash('sha256')
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            attemptBytes += chunk.length
            hash.update(chunk)
            callback(null, chunk)
          }
        })
        await pipeline(response.body, meter, createWriteStream(temporary, { flags: 'wx' }))
        bytesDownloaded += attemptBytes
        attemptBytes = 0

        const actualSize = statSync(temporary).size
        if (actualSize === 0) throw new Error('file konten kosong')
        if (item.file_size != null && actualSize !== item.file_size) {
          throw new Error(`ukuran file tidak cocok (${actualSize}/${item.file_size})`)
        }
        const actualChecksum = hash.digest('hex')
        if (item.checksum_sha256 != null) {
          if (!/^[a-fA-F0-9]{64}$/.test(item.checksum_sha256)) {
            throw new Error('checksum_sha256 tidak valid')
          }
          if (actualChecksum.toLowerCase() !== item.checksum_sha256.toLowerCase()) {
            throw new Error('checksum SHA-256 tidak cocok')
          }
        }

        if (existsSync(target)) unlinkSync(target)
        renameSync(temporary, target)
        return { ok: true, path: target, bytesDownloaded, released: false, error: null }
      } catch (error) {
        lastError = errorMessage(error)
        this.removeFile(temporary)
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
          return {
            ...failed(bytesDownloaded + attemptBytes, 'disk penuh saat menulis file'),
            diskFull: true
          }
        }
      }
      if (attemptBytes > 0) bytesDownloaded += attemptBytes
    }
    return failed(bytesDownloaded, lastError)
  }

  /**
   * Hapus file cache milik kita yang tidak dipakai playlist aktif. File yatim baru dihapus setelah masa tenggang
   * (dihitung dari mtime = "terakhir direferensikan", lihat touch) kecuali ignoreGrace. File .tmp (unduhan
   * berjalan) dan file asing di folder tidak pernah disentuh.
   */
  cleanupUnused(
    usedPaths: Iterable<string>,
    options: { ignoreGrace?: boolean } = {}
  ): CleanupResult {
    const result: CleanupResult = { deleted: 0, freedBytes: 0, deferred: 0 }
    try {
      const keep = new Set([...usedPaths].map((path) => resolve(path)))
      const now = this.now()
      this.retryDeferredDeletes()
      for (const name of readdirSync(this.cacheDir)) {
        if (!CACHE_FILE_PATTERN.test(name)) continue
        const file = resolve(this.cacheDir, name)
        if (dirname(file) !== resolve(this.cacheDir) || keep.has(file)) continue
        if (!options.ignoreGrace) {
          try {
            if (now - statSync(file).mtimeMs < this.orphanGraceMs) continue
          } catch {
            continue // hilang sendiri
          }
        }
        let size = 0
        try {
          size = statSync(file).size
        } catch {
          continue
        }
        if (this.removeFile(file)) {
          result.deleted++
          result.freedBytes += size
        } else {
          result.deferred++
        }
      }
    } catch (error) {
      this.warn(`cleanup cache gagal: ${errorMessage(error)}`)
    }
    return result
  }

  /**
   * Menandai file sebagai "terakhir direferensikan sekarang" (mtime). Masa tenggang file yatim dihitung dari sini,
   * bukan dari waktu unduh, sehingga file yang baru berhenti dipakai tidak langsung terhapus.
   */
  touch(paths: Iterable<string>): void {
    const when = new Date(this.now())
    for (const path of paths) {
      try {
        utimesSync(path, when, when)
      } catch {
        // file belum ada / terkunci: abaikan
      }
    }
  }

  pathFor(fileName: string): string {
    return join(this.cacheDir, fileName)
  }

  /** Path file cache untuk nama file yang valid dan ada; null selain itu (dipakai protokol media). */
  resolveCachedFile(fileName: string): string | null {
    if (!CACHE_FILE_PATTERN.test(fileName)) return null
    const file = join(this.cacheDir, fileName)
    try {
      return statSync(file).isFile() ? file : null
    } catch {
      return null
    }
  }

  get directory(): string {
    return this.cacheDir
  }

  diskSpace(): Promise<DiskSpace | null> {
    return this.diskSpaceFn(this.cacheDir)
  }

  /** Apakah masih muat `bytes` tambahan dengan tetap menyisakan cadangan minimal? Tidak terukur = dianggap cukup. */
  async hasRoomFor(bytes: number): Promise<boolean> {
    const space = await this.diskSpace()
    return space === null || space.free - bytes >= this.minFreeBytes
  }

  /** Daftar file cache milik kita beserta ukurannya (file asing dan .tmp tidak dihitung). */
  stats(): { fileCount: number; totalBytes: number; files: { name: string; size: number }[] } {
    const files: { name: string; size: number }[] = []
    let totalBytes = 0
    try {
      for (const name of readdirSync(this.cacheDir)) {
        if (!CACHE_FILE_PATTERN.test(name)) continue
        try {
          const stat = statSync(join(this.cacheDir, name))
          if (!stat.isFile()) continue
          files.push({ name, size: stat.size })
          totalBytes += stat.size
        } catch {
          // hilang saat dibaca: abaikan
        }
      }
    } catch {
      // folder belum bisa dibaca: dianggap kosong
    }
    return { fileCount: files.length, totalBytes, files }
  }

  /** Path tujuan unduhan untuk item ini (null kalau URL-nya tidak valid). */
  plannedPath(item: PlaylistItemDto): string | null {
    try {
      return this.cachePath(item, new URL(item.content_url, this.config.baseUrl))
    } catch {
      return null
    }
  }

  /** File sudah ada dengan ukuran yang cocok (murah; tanpa hash). Dipakai memperkirakan kebutuhan ruang. */
  isCachedBySize(item: PlaylistItemDto): boolean {
    const path = this.plannedPath(item)
    if (!path) return false
    try {
      const size = statSync(path).size
      return size > 0 && (item.file_size == null || size === item.file_size)
    } catch {
      return false
    }
  }

  /** Memeriksa satu file cache terhadap ukuran dan checksum dari server (hash dibaca bertahap, tidak memblokir). */
  async verifyFile(
    path: string,
    expected: { size: number | null; checksum: string | null }
  ): Promise<FileVerdict> {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return 'missing'
    }
    if (size <= 0 || (expected.size != null && size !== expected.size)) return 'corrupt'
    if (!expected.checksum) return 'ok'
    if (!/^[a-fA-F0-9]{64}$/.test(expected.checksum)) return 'ok' // checksum tak valid dari server: tidak bisa diverifikasi
    try {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      return hash.digest('hex').toLowerCase() === expected.checksum.toLowerCase() ? 'ok' : 'corrupt'
    } catch {
      return 'missing'
    }
  }

  /** Menghapus satu file cache (kegagalan karena file dipakai ditunda dan dicoba ulang). */
  discard(path: string): void {
    this.removeFile(path)
  }

  /**
   * Memindahkan folder cache. HARUS dipanggil saat tidak ada unduhan berjalan (dalam SyncService.runExclusive).
   * Semua pemeriksaan dilakukan sebelum ada yang berubah: kalau melempar Error, folder lama tetap dipakai utuh.
   * Setelah folder berganti, file yang gagal dipindahkan akan terdeteksi hilang oleh verifikasi cache dan diunduh ulang.
   */
  async changeDirectory(newDirInput: string, mode: CacheDirMode): Promise<RelocationResult> {
    const next = resolve(newDirInput)
    const current = resolve(this.cacheDir)
    const compare = (value: string): string =>
      process.platform === 'win32' ? value.toLowerCase() : value

    if (compare(next) === compare(current)) {
      throw new Error('Folder tujuan sama dengan folder cache saat ini.')
    }
    if (
      compare(next).startsWith(compare(current) + sep) ||
      compare(current).startsWith(compare(next) + sep)
    ) {
      throw new Error(
        'Folder tujuan tidak boleh berada di dalam (atau membungkus) folder cache saat ini.'
      )
    }
    const check = validateCacheDir(next)
    if (!check.ok) throw new Error(check.reason)
    prepareCacheDir(next)

    const source = this.stats()
    if (mode === 'move' && source.totalBytes > 0 && !this.sameVolumeFn(current, next)) {
      const space = await this.diskSpaceFn(next)
      if (space && space.free - source.totalBytes < this.minFreeBytes) {
        throw new Error(
          `Ruang di folder tujuan tidak cukup (butuh ${formatBytes(source.totalBytes)}, kosong ${formatBytes(space.free)}).`
        )
      }
    }

    let moved = 0
    let failed = 0
    let removed = 0
    for (const file of source.files) {
      const from = join(current, file.name)
      if (mode === 'fresh') {
        if (this.removeFile(from)) removed++
        continue
      }
      try {
        await this.moveFile(from, join(next, file.name))
        moved++
      } catch (error) {
        failed++
        this.warn(`gagal memindahkan ${file.name}: ${errorMessage(error)}`)
      }
    }

    this.cacheDir = next
    this.warn(
      `folder cache dipindah ke ${next} (${moved} dipindahkan, ${failed} gagal, ${removed} dihapus)`
    )
    return { newDir: next, moved, failed, removed }
  }

  /** Rename kalau satu drive; kalau tidak (EXDEV) salin ke .tmp, cocokkan ukuran, rename, lalu hapus sumber. */
  private async moveFile(from: string, to: string): Promise<void> {
    if (existsSync(to)) unlinkSync(to) // sisa lama dengan nama sama
    try {
      this.fileOps.rename(from, to)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
    const staging = `${to}.moving.tmp`
    try {
      await this.fileOps.copyFile(from, staging)
      if (statSync(staging).size !== statSync(from).size)
        throw new Error('ukuran salinan tidak cocok')
      renameSync(staging, to)
    } catch (error) {
      this.removeFile(staging)
      throw error
    }
    this.removeFile(from)
  }

  /** Hapus cache saat device dilepas; kegagalan penghapusan dicoba ulang pada cleanup berikutnya. */
  clear(): void {
    try {
      this.retryDeferredDeletes()
      for (const name of readdirSync(this.cacheDir)) {
        if (CACHE_FILE_PATTERN.test(name) || name.endsWith('.tmp')) {
          this.removeFile(join(this.cacheDir, name))
        }
      }
    } catch (error) {
      this.warn(`penghapusan cache gagal: ${errorMessage(error)}`)
    }
  }

  async close(): Promise<void> {
    if (this.deleteRetryTimer) clearInterval(this.deleteRetryTimer)
    this.deleteRetryTimer = null
    await this.agent.close()
  }

  retryPendingDeletes(): void {
    this.retryDeferredDeletes()
  }

  private cachePath(item: PlaylistItemDto, url: URL): string {
    // Identitas = content_id + URL. checksum_sha256/file_size SENGAJA tidak ikut: backend mengisinya belakangan
    // (patch checksum + backfill), dan kalau ikut kunci, semua player mengunduh ulang seluruh konten.
    // Konten yang diganti selalu mendapat URL baru; checksum/ukuran tetap diverifikasi di isValidCache/download.
    const identity = createHash('sha256').update(item.content_url).digest('hex').slice(0, 20)
    const rawExtension = extname(url.pathname).slice(1).toLowerCase()
    const extension = /^[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : 'bin'
    return join(this.cacheDir, `content_${item.content_id}_${identity}.${extension}`)
  }

  /** Dipanggil sekali saat startup (belum ada unduhan berjalan): semua .tmp adalah sisa unduhan yang terputus. */
  private removeStaleTempFiles(): void {
    try {
      for (const name of readdirSync(this.cacheDir)) {
        if (name.endsWith('.tmp')) this.removeFile(join(this.cacheDir, name))
      }
    } catch (error) {
      this.warn(`gagal membersihkan sisa unduhan: ${errorMessage(error)}`)
    }
  }

  private async isValidCache(file: string, item: PlaylistItemDto): Promise<boolean> {
    try {
      const size = statSync(file).size
      if (size <= 0 || (item.file_size != null && size !== item.file_size)) return false
      if (item.checksum_sha256 == null) return true
      if (!/^[a-fA-F0-9]{64}$/.test(item.checksum_sha256)) return false
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file)) hash.update(chunk)
      return hash.digest('hex').toLowerCase() === item.checksum_sha256.toLowerCase()
    } catch {
      return false
    }
  }

  private removeFile(file: string): boolean {
    try {
      if (existsSync(file)) unlinkSync(file)
      this.pendingDelete.delete(file)
      return true
    } catch (error) {
      this.pendingDelete.add(file)
      this.warn(`cache menunggu penghapusan: ${basename(file)} (${errorMessage(error)})`)
      if (!this.deleteRetryTimer) {
        this.deleteRetryTimer = setInterval(
          () => this.retryDeferredDeletes(),
          DELETE_RETRY_INTERVAL_MS
        )
        this.deleteRetryTimer.unref()
      }
      return false
    }
  }

  private retryDeferredDeletes(): void {
    for (const file of this.pendingDelete) this.removeFile(file)
    if (this.pendingDelete.size === 0 && this.deleteRetryTimer) {
      clearInterval(this.deleteRetryTimer)
      this.deleteRetryTimer = null
    }
  }
}

function sameVolumeOnDisk(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev
  } catch {
    return false
  }
}

async function defaultDiskSpace(dir: string): Promise<DiskSpace | null> {
  try {
    const stats = await statfs(dir)
    return {
      free: Number(stats.bavail) * Number(stats.bsize),
      total: Number(stats.blocks) * Number(stats.bsize)
    }
  } catch {
    return null
  }
}

function headerLength(headers: ContentResponse['headers']): number {
  const raw = headers?.['content-length']
  const value = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

function failed(bytesDownloaded: number, error: string): DownloadResult {
  return { ok: false, path: null, bytesDownloaded, released: false, error }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isLocalHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase())
}

async function isApiMessageBody(body: Readable): Promise<boolean> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024) {
      body.destroy()
      return false
    }
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { message?: unknown }).message === 'string'
    )
  } catch {
    return false
  }
}
