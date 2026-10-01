import { basename } from 'path'
import { OFFLINE_GRACE_VALIDATION_FAILURES, SYNC_INTERVAL_MS } from '../config'
import type { Db } from '../db/database'
import type { ApiClient } from './api-client'
import type { PlaylistItemDto, PlaylistResponse } from './api-types'
import { CacheManager, type DownloadResult } from './cache-manager'
import type { CredentialStore } from './credential-store'
import type { DeviceService } from './device-service'
import type { Diagnostics } from './diagnostics'

export type SyncOutcome =
  | 'applied'
  | 'not-modified'
  | 'no-playlist'
  | 'offline'
  | 'not-registered'
  | 'validation-grace'
  | 'released'
  | 'download-failed'
  | 'error'
  | 'busy'
  | 'aborted'

interface PreparedItem {
  dto: PlaylistItemDto
  download: DownloadResult
}

interface StoredItem {
  id: number
  slot_number: number
  slots_used: string
  content_id: number
  content_label: string | null
  content_url: string
  media_type: string
  duration_seconds: number
  file_size: number | null
  checksum_sha256: string | null
  days: string | null
  start: string | null
  end: string | null
  timezone: string | null
  startDate: string | null
  endDate: string | null
}

interface SyncServiceOptions {
  intervalMs?: number
  isOnline?: () => boolean
}

/** Polling dan mirror-sync playlist; semua pekerjaan cache/DB berjalan di main process. */
export class SyncService {
  private timer: NodeJS.Timeout | null = null
  private syncInProgress = false
  private validationFailures = 0
  /** Naik setiap data lokal dihapus (release/reset); sync yang sedang berjalan membuang hasilnya. */
  private generation = 0
  private readonly intervalMs: number
  private readonly isOnline: () => boolean

  constructor(
    private readonly db: Db,
    private readonly api: ApiClient,
    private readonly device: DeviceService,
    private readonly credentials: CredentialStore,
    private readonly cache: CacheManager,
    private readonly diagnostics: Diagnostics,
    options: SyncServiceOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS
    this.isOnline = options.isOnline ?? (() => true)
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

  async syncOnce(forceRefresh = false): Promise<SyncOutcome> {
    if (this.syncInProgress) return 'busy'
    this.cache.retryPendingDeletes()
    if (!this.credentials.isRegistered()) return 'not-registered'
    if (!this.isOnline()) return 'offline'

    this.syncInProgress = true
    const generation = this.generation
    try {
      const validation = await this.device.validateRegistration()
      if (validation.kind === 'registered') {
        this.validationFailures = 0
      } else {
        this.validationFailures++
        this.diagnostics.log(
          `Validasi registrasi gagal (${this.validationFailures}/${OFFLINE_GRACE_VALIDATION_FAILURES}): ${validation.kind === 'pending' ? 'pending' : validation.reason}`
        )
        if (this.validationFailures >= OFFLINE_GRACE_VALIDATION_FAILURES) {
          this.releaseLocalDevice('masa tenggang validasi habis')
          return 'released'
        }
        return 'validation-grace'
      }

      const active = this.db
        .prepare('SELECT version_hash FROM playlists WHERE is_active = 1')
        .get() as { version_hash: string } | undefined
      const currentVersion = forceRefresh ? null : (active?.version_hash ?? null)
      const deviceCode = this.credentials.getOrCreateDeviceCode()
      const token = this.credentials.load()?.apiToken
      if (!token) return 'not-registered'

      const response = await this.api.playlist(deviceCode, token, currentVersion)
      if (response.status === 204) {
        const retried = await this.retryFailedItems(generation)
        if (retried.released) return 'released'
        return generation !== this.generation ? 'aborted' : 'not-modified'
      }
      if (response.status === 404 && response.isApiMessage) return 'no-playlist'
      if ([401, 403].includes(response.status) && response.isApiMessage) {
        this.releaseLocalDevice(`playlist ditolak (HTTP ${response.status})`)
        return 'released'
      }
      if (response.status !== 200 || !isPlaylistResponse(response.json)) {
        this.diagnostics.log(`Sync playlist gagal: respons HTTP ${response.status} tidak valid`)
        return 'error'
      }
      if (response.json.playlist.length === 0) {
        this.diagnostics.log('Sync playlist diabaikan: snapshot kosong')
        return 'error'
      }

      return await this.applyPlaylist(response.json, deviceCode, token, generation)
    } catch (error) {
      this.diagnostics.log(`Sync gagal: ${errorMessage(error)}`)
      return 'error'
    } finally {
      this.syncInProgress = false
    }
  }

  /** Dipanggil setelah release/reset identitas; antrean playback sengaja dipertahankan. */
  clearLocalData(): void {
    this.stop()
    this.generation++
    try {
      this.db.prepare('DELETE FROM playlists').run()
    } catch (error) {
      this.diagnostics.log(`Gagal menghapus playlist lokal: ${errorMessage(error)}`)
    }
    this.cache.clear()
    this.diagnostics.log('Cache konten dan playlist lokal dihapus')
  }

  private async applyPlaylist(
    response: PlaylistResponse,
    deviceCode: string,
    token: string,
    generation: number
  ): Promise<SyncOutcome> {
    if (!isPlaylistResponse(response)) {
      this.diagnostics.log('Sync playlist gagal: payload tidak valid')
      return 'error'
    }

    const prepared: PreparedItem[] = []
    let bytesDownloaded = 0
    for (const dto of response.playlist) {
      try {
        const download = await this.cache.download(dto)
        bytesDownloaded += download.bytesDownloaded
        if (download.released) {
          this.releaseLocalDevice('download konten ditolak')
          return 'released'
        }
        prepared.push({ dto, download })
        if (!download.ok) {
          this.diagnostics.log(
            `Konten ${dto.content_id} gagal diunduh: ${download.error ?? 'kesalahan tidak diketahui'}`
          )
        }
      } catch (error) {
        prepared.push({
          dto,
          download: {
            ok: false,
            path: null,
            bytesDownloaded: 0,
            released: false,
            error: errorMessage(error)
          }
        })
        this.diagnostics.log(`Konten ${dto.content_id} gagal diunduh: ${errorMessage(error)}`)
      }
    }

    if (generation !== this.generation) {
      // Device dilepas/direset saat unduhan berjalan: buang hasilnya, jangan menghidupkan kembali data yang sudah dihapus.
      this.cache.clear()
      this.diagnostics.log('Sync dibatalkan: device dilepas saat unduhan berjalan')
      return 'aborted'
    }

    const readyCount = prepared.filter(({ download }) => download.ok).length
    if (prepared.length > 0 && readyCount === 0) {
      const logged = await this.postSyncLog(
        deviceCode,
        token,
        response.version_hash,
        'failed',
        bytesDownloaded
      )
      if (!logged) return 'released'
      return 'download-failed'
    }

    this.activatePlaylist(response, prepared)
    this.cache.cleanupUnused(
      prepared.flatMap(({ download }) => (download.ok && download.path ? [download.path] : []))
    )
    const status = readyCount < prepared.length ? 'partial' : 'success'
    if (
      !(await this.postSyncLog(deviceCode, token, response.version_hash, status, bytesDownloaded))
    ) {
      return 'released'
    }
    this.diagnostics.log(
      `Playlist ${response.version_hash.slice(0, 12)} aktif (${readyCount}/${prepared.length} konten siap, ${bytesDownloaded} byte)`
    )
    return 'applied'
  }

  private activatePlaylist(response: PlaylistResponse, prepared: PreparedItem[]): void {
    const insertPlaylist = this.db.prepare(
      'INSERT INTO playlists (version_hash, generated_at, slot_duration_seconds, is_active) VALUES (?, ?, ?, 0)'
    )
    const insertItem = this.db.prepare(
      `INSERT INTO playlist_items (
				playlist_id, slot_number, slots_used, content_id, content_label, content_url, media_type,
				duration_seconds, file_size, checksum_sha256, local_file_path, download_status,
				schedule_days, schedule_start, schedule_end, schedule_timezone, schedule_start_date, schedule_end_date
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const activate = this.db.transaction(() => {
      const playlistId = insertPlaylist.run(
        response.version_hash,
        response.generated_at,
        response.slot_duration_seconds
      ).lastInsertRowid
      for (const { dto, download } of prepared) {
        const schedule = dto.schedule
        insertItem.run(
          playlistId,
          dto.slot_number,
          JSON.stringify(Array.isArray(dto.slots_used) ? dto.slots_used : []),
          dto.content_id,
          dto.content_label ?? labelFromUrl(dto.content_url),
          dto.content_url,
          dto.media_type === 'image' ? 'image' : 'video',
          dto.duration_seconds,
          dto.file_size ?? null,
          dto.checksum_sha256 ?? null,
          download.ok ? download.path : null,
          download.ok ? 'READY' : 'FAILED',
          schedule?.days ?? schedule?.daysOfWeek ?? null,
          schedule?.start ?? schedule?.startTime ?? null,
          schedule?.end ?? schedule?.endTime ?? null,
          schedule?.timezone ?? null,
          schedule?.startDate ?? null,
          schedule?.endDate ?? null
        )
      }
      this.db.prepare('UPDATE playlists SET is_active = 0 WHERE is_active = 1').run()
      this.db.prepare('UPDATE playlists SET is_active = 1 WHERE id = ?').run(playlistId)
      this.db.prepare('DELETE FROM playlists WHERE id <> ?').run(playlistId)
    })
    activate()
  }

  private async retryFailedItems(generation: number): Promise<{ released: boolean }> {
    const active = this.db
      .prepare(
        `SELECT id, slot_number, slots_used, content_id, content_label, content_url, media_type,
								duration_seconds, file_size, checksum_sha256, schedule_days AS days,
								schedule_start AS start, schedule_end AS end, schedule_timezone AS timezone,
								schedule_start_date AS startDate, schedule_end_date AS endDate
				 FROM playlist_items WHERE playlist_id = (SELECT id FROM playlists WHERE is_active = 1)
					 AND download_status = 'FAILED' ORDER BY slot_number ASC`
      )
      .all() as StoredItem[]
    let recovered = 0
    for (const row of active) {
      const result = await this.cache.download({
        slot_number: row.slot_number,
        slots_used: parseSlotsUsed(row.slots_used),
        content_id: row.content_id,
        content_label: row.content_label,
        content_url: row.content_url,
        media_type: row.media_type === 'image' ? 'image' : 'video',
        duration_seconds: row.duration_seconds,
        file_size: row.file_size,
        checksum_sha256: row.checksum_sha256,
        schedule: {
          days: row.days,
          start: row.start,
          end: row.end,
          timezone: row.timezone,
          startDate: row.startDate,
          endDate: row.endDate
        }
      })
      if (generation !== this.generation) {
        this.cache.clear()
        return { released: false }
      }
      if (result.released) {
        this.releaseLocalDevice('retry download konten ditolak')
        return { released: true }
      }
      if (result.ok && result.path) {
        this.db
          .prepare(
            "UPDATE playlist_items SET local_file_path = ?, download_status = 'READY' WHERE id = ?"
          )
          .run(result.path, row.id)
        recovered++
      }
    }
    if (recovered > 0) this.diagnostics.log(`${recovered} konten gagal berhasil diunduh ulang`)
    return { released: false }
  }

  private async postSyncLog(
    deviceCode: string,
    token: string,
    version: string,
    status: 'success' | 'failed' | 'partial',
    bytesDownloaded: number
  ): Promise<boolean> {
    try {
      const response = await this.api.postSyncLog(deviceCode, token, {
        playlist_version_hash: version,
        status,
        bytes_downloaded: bytesDownloaded
      })
      if ([401, 403].includes(response.status) && response.isApiMessage) {
        this.releaseLocalDevice(`sync-log ditolak (HTTP ${response.status})`)
        return false
      }
      if (response.status < 200 || response.status >= 300) {
        this.diagnostics.log(`Sync-log gagal: HTTP ${response.status}`)
      }
      return true
    } catch (error) {
      this.diagnostics.log(`Sync-log gagal dikirim: ${errorMessage(error)}`)
      return true
    }
  }

  private releaseLocalDevice(reason: string): void {
    this.device.forgetRegistration(reason)
  }
}

function isPlaylistResponse(value: unknown): value is PlaylistResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<PlaylistResponse>
  return (
    typeof response.version_hash === 'string' &&
    response.version_hash.length > 0 &&
    typeof response.generated_at === 'string' &&
    Number.isFinite(response.slot_duration_seconds) &&
    Array.isArray(response.playlist) &&
    response.playlist.every(isPlaylistItem)
  )
}

function isPlaylistItem(value: unknown): value is PlaylistItemDto {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PlaylistItemDto>
  return (
    Number.isInteger(item.slot_number) &&
    Number.isInteger(item.content_id) &&
    typeof item.content_url === 'string' &&
    item.content_url.length > 0 &&
    typeof item.duration_seconds === 'number' &&
    Number.isFinite(item.duration_seconds)
  )
}

function labelFromUrl(contentUrl: string): string {
  try {
    return decodeURIComponent(basename(new URL(contentUrl).pathname)) || contentUrl
  } catch {
    return basename(contentUrl) || contentUrl
  }
}

function parseSlotsUsed(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(Number.isInteger) ? parsed : []
  } catch {
    return []
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
