import type Database from 'better-sqlite3'

interface Migration {
  version: number
  description: string
  sql: string
}

/**
 * Migrasi berurutan berbasis PRAGMA user_version. JANGAN mengubah migrasi yang sudah dirilis;
 * tambahkan versi baru. Tabel pending_playback_logs adalah antrean statistik yang belum terkirim:
 * migrasi tidak boleh menghapus atau mengosongkannya (beda dengan cache playlist yang bisa dibangun ulang).
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'skema awal: playlist, item playlist, antrean playback log',
    sql: `
      CREATE TABLE playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_hash TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        slot_duration_seconds INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      );
      -- Paling banyak SATU playlist aktif (aktivasi atomik dilakukan dalam satu transaksi di M2).
      CREATE UNIQUE INDEX idx_playlists_one_active ON playlists(is_active) WHERE is_active = 1;

      CREATE TABLE playlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        slot_number INTEGER NOT NULL,
        slots_used TEXT NOT NULL DEFAULT '[]',
        content_id INTEGER NOT NULL,
        content_label TEXT,
        content_url TEXT NOT NULL,
        media_type TEXT NOT NULL DEFAULT 'video',
        duration_seconds REAL NOT NULL,
        file_size INTEGER,
        checksum_sha256 TEXT,
        local_file_path TEXT,
        download_status TEXT NOT NULL DEFAULT 'PENDING',
        schedule_days TEXT,
        schedule_start TEXT,
        schedule_end TEXT,
        schedule_timezone TEXT,
        schedule_start_date TEXT,
        schedule_end_date TEXT
      );
      CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id, slot_number);

      CREATE TABLE pending_playback_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id INTEGER NOT NULL,
        content_label TEXT,
        played_at TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        was_offline INTEGER NOT NULL DEFAULT 0
      );
    `
  },
  {
    version: 2,
    description: 'app_state: pasangan key/value kecil (penghitung masa tenggang validasi/token)',
    sql: `
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  }
]

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number
}

export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  const current = getSchemaVersion(db)
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)
  for (const m of pending) {
    const apply = db.transaction(() => {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
    })
    apply()
  }
}
