import type { PlaybackLogStore } from '../db/playback-log-store'
import type { ApiClient } from './api-client'

const BATCH_SIZE = 500 // batas validasi backend per request
const MAX_BATCHES_PER_FLUSH = 20 // 10.000 baris per siklus sync; sisanya di siklus berikutnya
const MAX_LABEL_LENGTH = 255
const MAX_DURATION_SECONDS = 24 * 60 * 60

export interface PlaybackEvent {
  contentId: number
  label: string | null
  startedAt: Date | string
  playedSeconds: number
}

export type FlushResult =
  | { kind: 'idle' }
  | { kind: 'sent'; sent: number; pending: number }
  | { kind: 'auth-rejected'; sent: number }
  | { kind: 'error'; sent: number; message: string }

interface ReporterDeps {
  store: PlaybackLogStore
  api: Pick<ApiClient, 'postPlaybackLogs'>
  /** Dipakai untuk menandai was_offline saat tayang selesai (di Electron: net.isOnline()). */
  isOnline: () => boolean
  log?: (message: string) => void
  batchSize?: number
}

/**
 * Mencatat tayang yang SELESAI wajar ke antrean lokal dan mengunggahnya per batch saat sync.
 * Aturan dari player Android (docs/ANDROID_PLAYER_LOGIC.md bagian 9):
 *  - durasi dibulatkan, minimum 1 detik (di bawah itu tidak dicatat);
 *  - baris dihapus HANYA setelah server menjawab sukses, urut dari yang tertua, berhenti di kegagalan pertama;
 *  - tidak pernah mengirim ganda.
 */
export class PlaybackReporter {
  private flushing = false
  private readonly batchSize: number
  private readonly log: (message: string) => void

  constructor(private readonly deps: ReporterDeps) {
    this.batchSize = deps.batchSize ?? BATCH_SIZE
    this.log = deps.log ?? (() => {})
  }

  /** Mengembalikan true kalau tayang dicatat. */
  record(event: PlaybackEvent): boolean {
    const seconds = Math.round(event.playedSeconds)
    if (!Number.isInteger(event.contentId) || !Number.isFinite(seconds) || seconds < 1) return false
    const startedAt = new Date(event.startedAt)
    if (Number.isNaN(startedAt.getTime())) return false

    const label = event.label?.trim()
    this.deps.store.add({
      contentId: event.contentId,
      contentLabel: label ? label.slice(0, MAX_LABEL_LENGTH) : null,
      playedAt: startedAt.toISOString(),
      durationSeconds: Math.min(seconds, MAX_DURATION_SECONDS),
      wasOffline: !this.deps.isOnline()
    })
    return true
  }

  pendingCount(): number {
    return this.deps.store.count()
  }

  async flush(deviceCode: string, token: string): Promise<FlushResult> {
    if (this.flushing) return { kind: 'idle' }
    this.flushing = true
    try {
      return await this.flushBatches(deviceCode, token)
    } finally {
      this.flushing = false
    }
  }

  private async flushBatches(deviceCode: string, token: string): Promise<FlushResult> {
    const { store, api } = this.deps
    let sent = 0

    for (let i = 0; i < MAX_BATCHES_PER_FLUSH; i++) {
      const batch = store.peek(this.batchSize)
      if (batch.length === 0) break

      let response
      try {
        response = await api.postPlaybackLogs(
          deviceCode,
          token,
          batch.map((entry) => ({
            content_id: entry.contentId,
            content_label: entry.contentLabel,
            played_at: entry.playedAt,
            duration_seconds: entry.durationSeconds,
            was_offline: entry.wasOffline
          }))
        )
      } catch (error) {
        return { kind: 'error', sent, message: (error as Error).message }
      }

      const lastId = batch[batch.length - 1].id
      if (response.status >= 200 && response.status < 300) {
        store.removeUpTo(lastId)
        sent += batch.length
      } else if ([401, 403].includes(response.status) && response.isApiMessage) {
        return { kind: 'auth-rejected', sent }
      } else if (isPoisonStatus(response.status) && response.isApiMessage) {
        // Server menolak isi batch (mis. validasi 422): mengulang tidak akan pernah berhasil dan akan
        // menyumbat antrean selamanya, jadi batch ini dibuang.
        store.removeUpTo(lastId)
        this.log(
          `Statistik tayang: ${batch.length} baris ditolak server (HTTP ${response.status}) dan dibuang`
        )
      } else {
        return { kind: 'error', sent, message: `HTTP ${response.status}` }
      }

      if (batch.length < this.batchSize) break
    }

    if (sent === 0) {
      return store.count() === 0
        ? { kind: 'idle' }
        : { kind: 'sent', sent: 0, pending: store.count() }
    }
    this.log(`Statistik tayang terkirim: ${sent} baris (sisa antrean ${store.count()})`)
    return { kind: 'sent', sent, pending: store.count() }
  }
}

/** 4xx yang berarti "isi permintaan salah", bukan masalah sementara atau autentikasi. */
function isPoisonStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status)
}
