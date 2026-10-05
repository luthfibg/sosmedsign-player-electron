import type { Db } from './database'

export interface NewPlaybackLog {
  contentId: number
  contentLabel: string | null
  /** UTC ISO-8601, waktu MULAI tayang. */
  playedAt: string
  durationSeconds: number
  wasOffline: boolean
}

export interface PendingPlaybackLog extends NewPlaybackLog {
  id: number
}

/**
 * Antrean statistik tayang yang belum terkirim (tabel pending_playback_logs). BUKAN bagian cache:
 * tidak dihapus saat release/reset, dan migrasi tidak boleh mengosongkannya.
 */
export interface PlaybackLogStore {
  add(log: NewPlaybackLog): void
  /** Baris terlama lebih dulu (id naik). */
  peek(limit: number): PendingPlaybackLog[]
  /** Menghapus semua baris dengan id <= maxId (batch yang sudah dikirim selalu awal antrean). */
  removeUpTo(maxId: number): void
  count(): number
}

/** Batas antrean saat device offline sangat lama (mis. berbulan-bulan); baris tertua dibuang lebih dulu. */
export const MAX_PENDING_PLAYBACK_LOGS = 500_000

interface Row {
  id: number
  content_id: number
  content_label: string | null
  played_at: string
  duration_seconds: number
  was_offline: number
}

export class SqlitePlaybackLogStore implements PlaybackLogStore {
  constructor(
    private readonly db: Db,
    private readonly maxRows: number = MAX_PENDING_PLAYBACK_LOGS
  ) {}

  add(log: NewPlaybackLog): void {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO pending_playback_logs (content_id, content_label, played_at, duration_seconds, was_offline)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          log.contentId,
          log.contentLabel,
          log.playedAt,
          log.durationSeconds,
          log.wasOffline ? 1 : 0
        )
      // id selalu naik, jadi "id <= MAX(id) - batas" membuang yang tertua dan murah (tanpa COUNT).
      this.db
        .prepare(
          'DELETE FROM pending_playback_logs WHERE id <= (SELECT MAX(id) FROM pending_playback_logs) - ?'
        )
        .run(this.maxRows)
    })
    insert()
  }

  peek(limit: number): PendingPlaybackLog[] {
    const rows = this.db
      .prepare('SELECT * FROM pending_playback_logs ORDER BY id ASC LIMIT ?')
      .all(limit) as Row[]
    return rows.map((row) => ({
      id: row.id,
      contentId: row.content_id,
      contentLabel: row.content_label,
      playedAt: row.played_at,
      durationSeconds: row.duration_seconds,
      wasOffline: row.was_offline === 1
    }))
  }

  removeUpTo(maxId: number): void {
    this.db.prepare('DELETE FROM pending_playback_logs WHERE id <= ?').run(maxId)
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM pending_playback_logs').get() as {
      n: number
    }
    return row.n
  }
}
