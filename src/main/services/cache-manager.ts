import { createHash, randomUUID } from 'crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import { Agent, request } from 'undici'
import { Transform, type Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { AppConfig } from '../config'
import type { PlaylistItemDto } from './api-types'

/** Hanya file dengan nama ini yang dibuat dan boleh dihapus cache manager; file lain di folder tidak disentuh. */
const CACHE_FILE_PATTERN = /^content_\d+_[0-9a-f]{20}\.[a-z0-9]{1,8}$/

const MAX_ATTEMPTS = 3
const DOWNLOAD_BODY_TIMEOUT_MS = 60_000
const DELETE_RETRY_INTERVAL_MS = 5_000

export interface DownloadResult {
  ok: boolean
  path: string | null
  bytesDownloaded: number
  released: boolean
  error: string | null
}

interface ContentResponse {
  statusCode: number
  body: Readable
}

type ContentRequester = (url: URL, headers: Record<string, string>) => Promise<ContentResponse>

/** Cache konten versi-spesifik, dengan penulisan temp lalu rename atomik. */
export class CacheManager {
  private readonly agent: Agent
  private readonly requestContent: ContentRequester
  private readonly pendingDelete = new Set<string>()
  private deleteRetryTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly cacheDir: string,
    private readonly config: AppConfig,
    requester?: ContentRequester,
    private readonly warn: (message: string) => void = () => {}
  ) {
    mkdirSync(cacheDir, { recursive: true })
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
      }
      if (attemptBytes > 0) bytesDownloaded += attemptBytes
    }
    return failed(bytesDownloaded, lastError)
  }

  /** Hapus hanya file cache yang tidak dipakai playlist aktif; file temp selalu dipertahankan. */
  cleanupUnused(usedPaths: Iterable<string>): void {
    try {
      const keep = new Set([...usedPaths].map((path) => resolve(path)))
      this.retryDeferredDeletes()
      for (const name of readdirSync(this.cacheDir)) {
        if (!CACHE_FILE_PATTERN.test(name)) continue // .tmp (unduhan berjalan) dan file asing dibiarkan
        const file = resolve(this.cacheDir, name)
        if (dirname(file) !== resolve(this.cacheDir) || keep.has(file)) continue
        this.removeFile(file)
      }
    } catch (error) {
      this.warn(`cleanup cache gagal: ${errorMessage(error)}`)
    }
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

  private removeFile(file: string): void {
    try {
      if (existsSync(file)) unlinkSync(file)
      this.pendingDelete.delete(file)
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
