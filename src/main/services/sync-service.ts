import { basename } from 'path'
import { OFFLINE_GRACE_VALIDATION_FAILURES, SYNC_INTERVAL_MS } from '../config'
import type { PlaylistStore, StoredPlaylist } from '../db/playlist-store'
import type { ApiClient } from './api-client'
import type { PlaylistItemDto, PlaylistResponse } from './api-types'
import { formatBytes, type CacheManager, type DownloadResult } from './cache-manager'
import type { CredentialStore } from './credential-store'
import type { DeviceService, RegistrationClearedReason } from './device-service'
import type { Diagnostics } from './diagnostics'
import type { PlaybackReporter } from './playback-reporter'
import { isPlaylistItem, toNewItem } from './playlist-mapper'

export type SyncOutcome =
  | 'applied'
  | 'not-modified'
  | 'no-playlist'
  | 'offline'
  | 'not-registered'
  | 'validation-grace'
  | 'auth-rejected'
  | 'released'
  | 'download-failed'
  | 'partial'
  | 'error'
  | 'busy'
  | 'aborted'

/** Penghitung masa tenggang disimpan di database supaya tidak hilang saat restart (MiniPC sering dimatikan). */
const K_VALIDATION_FAILURES = 'validation_failures'
const K_AUTH_FAILURES = 'auth_failures'

interface SyncServiceOptions {
  intervalMs?: number
  isOnline?: () => boolean
  /** Jumlah kegagalan beruntun sebelum device dianggap dilepas (default 120, sekitar 6 jam). */
  graceFailures?: number
  /** Pengunggah statistik tayang; dipanggil di tiap siklus sync setelah validasi registrasi berhasil. */
  reporter?: Pick<PlaybackReporter, 'flush'>
}

export interface VerifyResult {
  checked: number
  missing: number
  corrupt: number
  /** Item yang masih FAILED setelah percobaan unduh ulang segera. */
  stillFailed: number
}

type Listener = () => void

/** Polling dan mirror-sync playlist; semua pekerjaan cache/DB berjalan di main process. */
export class SyncService {
  private timer: NodeJS.Timeout | null = null
  private syncInProgress = false
  private cmsConnected: boolean | null = null
  private lastCmsResponseAt: number | null = null
  private lastSyncOutcome: SyncOutcome | null = null
  private lastDiskFull = false
  /** Naik setiap data lokal dihapus (release/reset); sync yang sedang berjalan membuang hasilnya. */
  private generation = 0
  private readonly intervalMs: number
  private readonly isOnline: () => boolean
  private readonly graceFailures: number
  private readonly reporter: Pick<PlaybackReporter, 'flush'> | undefined
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly store: PlaylistStore,
    private readonly api: Pick<ApiClient, 'playlist' | 'postSyncLog'>,
    private readonly device: Pick<DeviceService, 'validateRegistration' | 'forgetRegistration'>,
    private readonly credentials: Pick<
      CredentialStore,
      'isRegistered' | 'getOrCreateDeviceCode' | 'load'
    >,
    private readonly cache: CacheManager,
    private readonly diagnostics: Pick<Diagnostics, 'log'>,
    options: SyncServiceOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS
    this.isOnline = options.isOnline ?? (() => true)
    this.graceFailures = options.graceFailures ?? OFFLINE_GRACE_VALIDATION_FAILURES
    this.reporter = options.reporter
  }

  start(): void {
    if (this.timer || !this.credentials.isRegistered()) return
    void this.syncOnce()
    this.timer = setInterval(() => void this.syncOnce(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  async close(): Promise<void> {
    this.stop()
    await this.cache.close()
  }

  /** Dipanggil saat playlist aktif berubah (playlist baru, item pulih dari FAILED, atau data dihapus). */
  onPlaylistChanged(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Dihubungkan ke DeviceService.onRegistrationCleared. Selalu menghentikan sync dan mereset penghitung;
   * playlist + cache hanya dihapus untuk alasan selain 'credentials-invalid'. Antrean playback sengaja dipertahankan.
   */
  handleRegistrationCleared(reason: RegistrationClearedReason): void {
    this.stop()
    this.store.deleteState(K_VALIDATION_FAILURES)
    this.store.deleteState(K_AUTH_FAILURES)
    if (reason === 'credentials-invalid') return

    this.generation++
    try {
      this.store.clearPlaylists()
    } catch (error) {
      this.diagnostics.log(`Gagal menghapus playlist lokal: ${errorMessage(error)}`)
    }
    this.cache.clear()
    this.diagnostics.log('Cache konten dan playlist lokal dihapus')
    this.emitPlaylistChanged()
  }

  getDiagnosticIndicators(
    online: boolean,
    registered: boolean
  ): Pick<DiagnosticsIndicatorsDto, 'connected' | 'sync'> {
    let connected: DiagnosticIndicatorDto
    if (!registered) {
      connected = { state: 'inactive', detail: 'Device belum terdaftar' }
    } else if (!online) {
      connected = { state: 'inactive', detail: 'Tidak ada koneksi jaringan' }
    } else if (this.cmsConnected === null) {
      connected = { state: 'unknown', detail: 'Menunggu pemeriksaan CMS pertama' }
    } else if (!this.cmsConnected) {
      connected = { state: 'inactive', detail: 'API CMS belum merespons' }
    } else if (
      this.lastCmsResponseAt !== null &&
      Date.now() - this.lastCmsResponseAt > SYNC_INTERVAL_MS * 2
    ) {
      connected = { state: 'warning', detail: 'Respons CMS terakhir sudah lebih dari 6 menit' }
    } else {
      connected = { state: 'active', detail: 'API CMS merespons' }
    }

    return { connected, sync: this.getSyncIndicator() }
  }

  /**
   * Menjalankan pekerjaan yang tidak boleh bersamaan dengan sync (ganti folder cache, verifikasi file).
   * Menunggu sync yang sedang berjalan selesai, lalu menahan siklus berikutnya (mereka mendapat 'busy').
   */
  async runExclusive<T>(task: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (this.syncInProgress) {
      if (Date.now() > deadline) {
        throw new Error('Sinkronisasi masih berjalan; coba lagi beberapa saat lagi')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    this.syncInProgress = true
    try {
      return await task()
    } finally {
      this.syncInProgress = false
    }
  }

  /**
   * Memeriksa semua file cache playlist aktif terhadap ukuran/checksum dari server. File hilang atau rusak ditandai
   * FAILED (file rusak dihapus), lalu langsung dicoba diunduh ulang lewat siklus sync berikutnya.
   */
  async verifyAndRepair(): Promise<VerifyResult> {
    const found = await this.runExclusive(async () => {
      const generation = this.generation
      const active = this.store.getActivePlaylist()
      const counts = { checked: 0, missing: 0, corrupt: 0 }
      if (!active) return counts

      const verdicts = new Map<string, Awaited<ReturnType<CacheManager['verifyFile']>>>()
      for (const item of active.items) {
        if (item.downloadStatus !== 'READY' || !item.localFile) continue
        if (generation !== this.generation) break
        const path = this.cache.pathFor(basename(item.localFile))
        let verdict = verdicts.get(path)
        if (!verdict) {
          verdict = await this.cache.verifyFile(path, {
            size: item.fileSize,
            checksum: item.checksumSha256
          })
          verdicts.set(path, verdict)
          counts.checked++
          if (verdict === 'corrupt') {
            counts.corrupt++
            this.cache.discard(path)
          } else if (verdict === 'missing') {
            counts.missing++
          }
        }
        if (verdict !== 'ok') {
          this.store.updateItem(item.id, { localFile: null, downloadStatus: 'FAILED' })
        }
      }
      if (counts.missing + counts.corrupt > 0) this.emitPlaylistChanged()
      return counts
    })

    this.diagnostics.log(
      `Verifikasi cache: ${found.checked} file diperiksa, ${found.corrupt} rusak, ${found.missing} hilang`
    )
    if (found.corrupt + found.missing > 0) await this.syncOnce() // unduh ulang segera lewat jalur retry item FAILED
    const stillFailed =
      this.store.getActivePlaylist()?.items.filter((item) => item.downloadStatus === 'FAILED')
        .length ?? 0
    return { ...found, stillFailed }
  }

  /** Memperkirakan ruang yang dibutuhkan; kalau kurang, file yatim dihapus sekarang tanpa menunggu masa tenggang. */
  private async makeRoomFor(items: PlaylistItemDto[]): Promise<void> {
    let needed = 0
    const seen = new Set<string>()
    for (const dto of items) {
      const key = `${dto.content_id}\0${dto.content_url}`
      if (seen.has(key)) continue
      seen.add(key)
      if (dto.file_size != null && !this.cache.isCachedBySize(dto)) needed += dto.file_size
    }
    if (needed === 0 || (await this.cache.hasRoomFor(needed))) return

    const keep = [
      ...items.map((dto) => this.cache.plannedPath(dto)).filter((p): p is string => p !== null),
      ...this.pathsOf(this.store.getActivePlaylist())
    ]
    this.diagnostics.log(
      `Ruang disk menipis: membersihkan file yatim lebih awal (butuh ${formatBytes(needed)})`
    )
    this.cache.cleanupUnused(keep, { ignoreGrace: true })
  }

  async syncOnce(forceRefresh = false): Promise<SyncOutcome> {
    const outcome = await this.performSyncOnce(forceRefresh)
    if (outcome !== 'busy') this.lastSyncOutcome = outcome
    return outcome
  }

  private async performSyncOnce(forceRefresh = false): Promise<SyncOutcome> {
    if (this.syncInProgress) return 'busy'
    this.cache.retryPendingDeletes()
    if (!this.credentials.isRegistered()) return 'not-registered'
    if (!this.isOnline()) return 'offline'

    this.syncInProgress = true
    const generation = this.generation
    try {
      return await this.runCycle(generation, forceRefresh)
    } catch (error) {
      this.diagnostics.log(`Sync gagal: ${errorMessage(error)}`)
      return 'error'
    } finally {
      this.syncInProgress = false
    }
  }

  private async runCycle(generation: number, forceRefresh: boolean): Promise<SyncOutcome> {
    // 1. Masih terdaftar? Hanya jawaban pasti "pending" dari server yang dihitung menuju pelepasan.
    //    Server tak terjangkau / respons bukan JSON API = tidak tahu, bukan "dilepas" (tidak dihitung).
    const validation = await this.device.validateRegistration()
    this.recordCmsConnection(validation.kind !== 'unavailable')
    if (generation !== this.generation) return 'aborted'
    if (validation.kind === 'registered') {
      this.store.deleteState(K_VALIDATION_FAILURES)
    } else if (validation.kind === 'pending') {
      const n = this.bump(K_VALIDATION_FAILURES)
      this.diagnostics.log(
        `Server menyatakan device belum/tidak terdaftar (${n}/${this.graceFailures})`
      )
      if (n >= this.graceFailures) {
        this.device.forgetRegistration('unregistered', 'dilepas dari CMS (melewati masa tenggang)')
        return 'released'
      }
      return 'validation-grace'
    } else {
      this.diagnostics.log(
        `Validasi registrasi tidak tersedia (${validation.reason}); sync dilewati`
      )
      return 'validation-grace'
    }

    // 2. Ambil playlist
    const deviceCode = this.credentials.getOrCreateDeviceCode()
    const token = this.credentials.load()?.apiToken
    if (!token) return 'not-registered'

    // Statistik tayang menumpang di siklus sync yang sama. Gagal kirim tidak boleh menghentikan sync playlist.
    const flushed = await this.reporter?.flush(deviceCode, token)
    if (generation !== this.generation) return 'aborted'
    if (flushed?.kind === 'auth-rejected') return this.noteAuthRejected('statistik tayang ditolak')
    if (flushed?.kind === 'error') {
      this.diagnostics.log(`Statistik tayang belum terkirim (${flushed.message})`)
    }

    const currentVersion = forceRefresh ? null : this.store.getActiveVersion()

    let response
    try {
      response = await this.api.playlist(deviceCode, token, currentVersion)
    } catch (error) {
      this.recordCmsConnection(false)
      throw error
    }
    this.recordCmsConnection(
      response.status === 204 ||
        (response.status === 200 && response.json !== null) ||
        response.isApiMessage
    )
    if (generation !== this.generation) return 'aborted'

    if (response.status === 204) {
      this.store.deleteState(K_AUTH_FAILURES)
      return this.afterNotModified(generation)
    }
    if (response.status === 404 && response.isApiMessage) {
      this.store.deleteState(K_AUTH_FAILURES)
      return 'no-playlist'
    }
    if ([401, 403].includes(response.status) && response.isApiMessage) {
      return this.noteAuthRejected(`playlist HTTP ${response.status}`)
    }
    // Respons lain (termasuk 401/403/404 berbentuk HTML dari proxy/captive portal) tidak dipercaya.
    if (response.status !== 200 || !isPlaylistResponse(response.json)) {
      this.diagnostics.log(`Sync playlist gagal: respons HTTP ${response.status} tidak valid`)
      return 'error'
    }
    this.store.deleteState(K_AUTH_FAILURES)
    return this.applyPlaylist(response.json, deviceCode, token, generation)
  }

  // ---- playlist baru ----

  private async applyPlaylist(
    response: PlaylistResponse,
    deviceCode: string,
    token: string,
    generation: number
  ): Promise<SyncOutcome> {
    const items = response.playlist.filter(isPlaylistItem)
    if (items.length < response.playlist.length) {
      this.diagnostics.log(
        `Sync: ${response.playlist.length - items.length} item tidak valid dilewati`
      )
    }
    if (items.length === 0 && response.playlist.length > 0) {
      // Server mengirim item tapi semuanya rusak: jangan mengosongkan playlist karena data yang salah.
      this.diagnostics.log('Sync playlist diabaikan: tidak ada item yang valid')
      return 'error'
    }

    this.lastDiskFull = false
    await this.makeRoomFor(items)

    // Konten yang sama di beberapa slot diunduh sekali.
    const downloads = new Map<string, DownloadResult>()
    const prepared: { dto: PlaylistItemDto; download: DownloadResult }[] = []
    let bytesDownloaded = 0
    for (const dto of items) {
      const key = `${dto.content_id}\0${dto.content_url}`
      let download = downloads.get(key)
      if (!download) {
        try {
          download = await this.cache.download(dto)
        } catch (error) {
          download = failedDownload(errorMessage(error))
        }
        downloads.set(key, download)
        bytesDownloaded += download.bytesDownloaded
        if (download.diskFull) this.lastDiskFull = true
        if (generation !== this.generation) break
        if (download.released) return this.noteAuthRejected('download konten ditolak')
        if (!download.ok) {
          this.diagnostics.log(
            `Konten ${dto.content_id} gagal diunduh: ${download.error ?? 'kesalahan tidak diketahui'}`
          )
        }
      }
      prepared.push({ dto, download })
    }

    if (generation !== this.generation) {
      // Device dilepas/direset saat unduhan berjalan: buang hasilnya, jangan menghidupkan kembali data yang sudah dihapus.
      this.cache.clear()
      this.diagnostics.log('Sync dibatalkan: device dilepas saat unduhan berjalan')
      return 'aborted'
    }

    const readyCount = prepared.filter(({ download }) => download.ok).length
    if (prepared.length > 0 && readyCount === 0) {
      await this.postSyncLog(deviceCode, token, response.version_hash, 'failed', bytesDownloaded)
      return 'download-failed'
    }

    // File playlist lama ditandai "terakhir dipakai sekarang" sebelum diganti, supaya masa tenggang file yatim
    // dihitung dari saat playlist berganti (bukan dari saat terakhir online, yang bisa berhari-hari lalu).
    this.cache.touch(this.pathsOf(this.store.getActivePlaylist()))

    const stored = this.store.activatePlaylist(
      {
        versionHash: response.version_hash,
        generatedAt: response.generated_at,
        slotDurationSeconds: response.slot_duration_seconds
      },
      prepared.map(({ dto, download }) =>
        download.ok && download.path
          ? toNewItem(dto, basename(download.path), 'READY')
          : toNewItem(dto, null, 'FAILED')
      )
    )
    const referenced = this.pathsOf(stored)
    this.cache.touch(referenced)
    this.cache.cleanupUnused(referenced)
    this.emitPlaylistChanged()

    const status = readyCount < prepared.length ? 'partial' : 'success'
    await this.postSyncLog(deviceCode, token, response.version_hash, status, bytesDownloaded)
    this.diagnostics.log(
      `Playlist ${response.version_hash.slice(0, 12)} aktif (${readyCount}/${prepared.length} konten siap, ${bytesDownloaded} byte)`
    )
    return status === 'partial' ? 'partial' : 'applied'
  }

  // ---- tidak ada perubahan ----

  private async afterNotModified(generation: number): Promise<SyncOutcome> {
    const active = this.store.getActivePlaylist()
    if (!active) return 'not-modified'

    const referenced = new Set(this.pathsOf(active))
    this.cache.touch(referenced)

    this.lastDiskFull = false
    let recovered = 0
    const attempted = new Map<string, DownloadResult>()
    for (const item of active.items) {
      if (item.downloadStatus !== 'FAILED') continue
      const key = `${item.contentId}\0${item.contentUrl}`
      let result = attempted.get(key)
      if (!result) {
        result = await this.cache.download(toDto(item))
        attempted.set(key, result)
        if (generation !== this.generation) {
          this.cache.clear()
          return 'aborted'
        }
        if (result.diskFull) this.lastDiskFull = true
        if (result.released) return this.noteAuthRejected('retry download konten ditolak')
      }
      if (result.ok && result.path) {
        this.store.updateItem(item.id, {
          localFile: basename(result.path),
          downloadStatus: 'READY'
        })
        referenced.add(result.path)
        recovered++
      }
    }

    // Sweep juga di siklus tanpa perubahan: file yatim baru terhapus setelah masa tenggang lewat.
    this.cache.cleanupUnused(referenced)
    if (recovered > 0) {
      this.diagnostics.log(`${recovered} konten gagal berhasil diunduh ulang`)
      this.emitPlaylistChanged()
    }
    return 'not-modified'
  }

  // ---- bantu ----

  /**
   * Token ditolak server (401/403 berbentuk JSON API). Dihitung lewat masa tenggang yang sama dengan validasi
   * registrasi dan TIDAK menghapus data: setelah token diterbitkan ulang (kode reissue), konten yang sudah
   * diunduh tetap dipakai.
   */
  private noteAuthRejected(source: string): SyncOutcome {
    const n = this.bump(K_AUTH_FAILURES)
    this.diagnostics.log(`Token ditolak server (${n}/${this.graceFailures}): ${source}`)
    if (n >= this.graceFailures) {
      this.device.forgetRegistration('credentials-invalid', 'token ditolak server berulang kali')
      return 'released'
    }
    return 'auth-rejected'
  }

  private async postSyncLog(
    deviceCode: string,
    token: string,
    version: string,
    status: 'success' | 'failed' | 'partial',
    bytesDownloaded: number
  ): Promise<void> {
    try {
      const response = await this.api.postSyncLog(deviceCode, token, {
        playlist_version_hash: version,
        status,
        bytes_downloaded: bytesDownloaded
      })
      this.recordCmsConnection(
        (response.status >= 200 && response.status < 300) || response.isApiMessage
      )
      if ([401, 403].includes(response.status) && response.isApiMessage) {
        this.noteAuthRejected(`sync-log HTTP ${response.status}`)
      } else if (response.status < 200 || response.status >= 300) {
        this.diagnostics.log(`Sync-log gagal: HTTP ${response.status}`)
      }
    } catch (error) {
      // Gagal mengirim sync-log tidak boleh mengganggu playback.
      this.diagnostics.log(`Sync-log gagal dikirim: ${errorMessage(error)}`)
    }
  }

  private pathsOf(playlist: StoredPlaylist | null): string[] {
    return (playlist?.items ?? [])
      .filter((item) => item.localFile)
      .map((item) => this.cache.pathFor(basename(item.localFile as string)))
  }

  private bump(key: string): number {
    const current = Number(this.store.getState(key))
    const next = (Number.isFinite(current) && current > 0 ? Math.trunc(current) : 0) + 1
    this.store.setState(key, String(next))
    return next
  }

  private emitPlaylistChanged(): void {
    for (const listener of this.listeners) listener()
  }

  private recordCmsConnection(connected: boolean): void {
    this.cmsConnected = connected
    this.lastCmsResponseAt = Date.now()
  }

  private getSyncIndicator(): DiagnosticIndicatorDto {
    if (this.syncInProgress) return { state: 'working', detail: 'Sinkronisasi sedang berjalan' }
    if (this.lastSyncOutcome === null) {
      return { state: 'unknown', detail: 'Belum ada percobaan sinkronisasi' }
    }
    if (
      this.lastDiskFull &&
      ['partial', 'download-failed', 'not-modified'].includes(this.lastSyncOutcome)
    ) {
      return { state: 'error', detail: 'Ruang disk tidak cukup untuk mengunduh konten' }
    }
    switch (this.lastSyncOutcome) {
      case 'applied':
      case 'not-modified':
        return { state: 'active', detail: 'Sinkronisasi terakhir berhasil' }
      case 'partial':
        return { state: 'warning', detail: 'Sebagian konten gagal diunduh' }
      case 'download-failed':
        return { state: 'error', detail: 'Semua unduhan konten gagal' }
      case 'error':
        return { state: 'error', detail: 'Sinkronisasi terakhir gagal' }
      case 'released':
        return { state: 'error', detail: 'Registrasi device dilepas' }
      case 'auth-rejected':
        return { state: 'warning', detail: 'Token ditolak server; masa tenggang berjalan' }
      case 'offline':
        return { state: 'warning', detail: 'Sinkronisasi dilewati saat offline' }
      case 'no-playlist':
        return { state: 'warning', detail: 'CMS belum memiliki playlist untuk device ini' }
      case 'validation-grace':
        return { state: 'warning', detail: 'Validasi CMS belum berhasil; memutar dari cache' }
      case 'not-registered':
        return { state: 'inactive', detail: 'Device belum terdaftar' }
      case 'aborted':
        return { state: 'warning', detail: 'Sinkronisasi dibatalkan' }
      case 'busy':
        return { state: 'working', detail: 'Sinkronisasi sedang berjalan' }
    }
  }
}

function toDto(item: StoredPlaylist['items'][number]): PlaylistItemDto {
  return {
    slot_number: item.slotNumber,
    slots_used: item.slotsUsed,
    content_id: item.contentId,
    content_label: item.contentLabel,
    content_url: item.contentUrl,
    media_type: item.mediaType,
    duration_seconds: item.durationSeconds,
    file_size: item.fileSize,
    checksum_sha256: item.checksumSha256
  }
}

function failedDownload(error: string): DownloadResult {
  return { ok: false, path: null, bytesDownloaded: 0, released: false, error }
}

/** Snapshot kosong (`playlist: []`) valid: artinya semua booking berakhir/dihapus (mirror sync mengosongkan konten). */
function isPlaylistResponse(value: unknown): value is PlaylistResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<PlaylistResponse>
  return (
    typeof response.version_hash === 'string' &&
    response.version_hash.length > 0 &&
    typeof response.generated_at === 'string' &&
    Number.isFinite(response.slot_duration_seconds) &&
    Array.isArray(response.playlist)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
