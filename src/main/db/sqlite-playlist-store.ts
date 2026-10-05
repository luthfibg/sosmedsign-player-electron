import type { Db } from './database'
import type {
  DownloadStatus,
  ItemSchedule,
  MediaType,
  NewPlaylistItem,
  PlaylistMeta,
  PlaylistStore,
  StoredPlaylist,
  StoredPlaylistItem
} from './playlist-store'

interface PlaylistRow {
  id: number
  version_hash: string
  generated_at: string
  slot_duration_seconds: number
}

interface ItemRow {
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
  local_file_path: string | null
  download_status: string
  schedule_days: string | null
  schedule_start: string | null
  schedule_end: string | null
  schedule_timezone: string | null
  schedule_start_date: string | null
  schedule_end_date: string | null
}

export class SqlitePlaylistStore implements PlaylistStore {
  constructor(private readonly db: Db) {}

  getActivePlaylist(): StoredPlaylist | null {
    const row = this.db.prepare('SELECT * FROM playlists WHERE is_active = 1').get() as
      PlaylistRow | undefined
    if (!row) return null
    const items = this.db
      .prepare(
        'SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY slot_number ASC, id ASC'
      )
      .all(row.id) as ItemRow[]
    return {
      id: row.id,
      versionHash: row.version_hash,
      generatedAt: row.generated_at,
      slotDurationSeconds: row.slot_duration_seconds,
      items: items.map(toItem)
    }
  }

  getActiveVersion(): string | null {
    const row = this.db.prepare('SELECT version_hash FROM playlists WHERE is_active = 1').get() as
      { version_hash: string } | undefined
    return row?.version_hash ?? null
  }

  activatePlaylist(meta: PlaylistMeta, items: NewPlaylistItem[]): StoredPlaylist {
    const run = this.db.transaction((): number => {
      this.db.prepare('DELETE FROM playlists').run() // CASCADE menghapus item playlist lama
      const id = Number(
        this.db
          .prepare(
            'INSERT INTO playlists (version_hash, generated_at, slot_duration_seconds, is_active) VALUES (?, ?, ?, 1)'
          )
          .run(meta.versionHash, meta.generatedAt, meta.slotDurationSeconds).lastInsertRowid
      )
      const insert = this.db.prepare(`
        INSERT INTO playlist_items (
          playlist_id, slot_number, slots_used, content_id, content_label, content_url, media_type,
          duration_seconds, file_size, checksum_sha256, local_file_path, download_status,
          schedule_days, schedule_start, schedule_end, schedule_timezone, schedule_start_date, schedule_end_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of items) {
        insert.run(
          id,
          item.slotNumber,
          JSON.stringify(item.slotsUsed),
          item.contentId,
          item.contentLabel,
          item.contentUrl,
          item.mediaType,
          item.durationSeconds,
          item.fileSize,
          item.checksumSha256,
          item.localFile,
          item.downloadStatus,
          item.schedule?.days ?? null,
          item.schedule?.start ?? null,
          item.schedule?.end ?? null,
          item.schedule?.timezone ?? null,
          item.schedule?.startDate ?? null,
          item.schedule?.endDate ?? null
        )
      }
      return id
    })
    run()
    return this.getActivePlaylist()!
  }

  updateItem(
    itemId: number,
    patch: { localFile: string | null; downloadStatus: DownloadStatus }
  ): void {
    this.db
      .prepare('UPDATE playlist_items SET local_file_path = ?, download_status = ? WHERE id = ?')
      .run(patch.localFile, patch.downloadStatus, itemId)
  }

  clearPlaylists(): void {
    this.db.prepare('DELETE FROM playlists').run()
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
      { value: string } | undefined
    return row?.value ?? null
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key)
  }
}

function toItem(row: ItemRow): StoredPlaylistItem {
  const hasSchedule =
    row.schedule_days !== null ||
    row.schedule_start !== null ||
    row.schedule_end !== null ||
    row.schedule_timezone !== null ||
    row.schedule_start_date !== null ||
    row.schedule_end_date !== null
  const schedule: ItemSchedule | null = hasSchedule
    ? {
        days: row.schedule_days,
        start: row.schedule_start,
        end: row.schedule_end,
        timezone: row.schedule_timezone,
        startDate: row.schedule_start_date,
        endDate: row.schedule_end_date
      }
    : null
  return {
    id: row.id,
    slotNumber: row.slot_number,
    slotsUsed: parseSlots(row.slots_used),
    contentId: row.content_id,
    contentLabel: row.content_label,
    contentUrl: row.content_url,
    mediaType: row.media_type === 'image' ? ('image' as MediaType) : 'video',
    durationSeconds: row.duration_seconds,
    fileSize: row.file_size,
    checksumSha256: row.checksum_sha256,
    localFile: row.local_file_path,
    downloadStatus: row.download_status as DownloadStatus,
    schedule
  }
}

function parseSlots(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}
