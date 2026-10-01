import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

// better-sqlite3 adalah modul native. Setelah `npm install` (postinstall: electron-builder install-app-deps)
// ia dikompilasi untuk ABI Electron, sehingga tidak bisa dimuat oleh Node biasa (vitest). Kalau begitu,
// test DB di-skip otomatis; skema tetap tervalidasi saat aplikasi dijalankan (`npm run dev`).
async function tryLoad(): Promise<boolean> {
  try {
    const { default: Database } = await import('better-sqlite3')
    new Database(':memory:').close()
    return true
  } catch {
    return false
  }
}
const canLoad = await tryLoad()

describe.skipIf(!canLoad)('database migrations', () => {
  it('membuat skema v1 pada database baru dan idempoten saat dibuka ulang', async () => {
    const { openDatabase } = await import('../db/database')
    const { getSchemaVersion, MIGRATIONS } = await import('../db/migrations')
    const file = join(makeTempDir(), 'player.db')

    const db = openDatabase(file)
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version)
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((t) => t.name)
    expect(tables).toEqual(
      expect.arrayContaining(['playlists', 'playlist_items', 'pending_playback_logs'])
    )
    db.prepare(
      "INSERT INTO pending_playback_logs (content_id, played_at, duration_seconds) VALUES (1, '2026-09-30T00:00:00Z', 15)"
    ).run()
    db.close()

    const reopened = openDatabase(file)
    expect(
      (reopened.prepare('SELECT COUNT(*) AS n FROM pending_playback_logs').get() as { n: number }).n
    ).toBe(1)
    reopened.close()
  })

  it('hanya boleh ada satu playlist aktif', async () => {
    const { openDatabase } = await import('../db/database')
    const db = openDatabase(join(makeTempDir(), 'player.db'))
    const insert = db.prepare(
      "INSERT INTO playlists (version_hash, generated_at, slot_duration_seconds, is_active) VALUES (?, 'x', 15, ?)"
    )
    insert.run('a', 1)
    expect(() => insert.run('b', 1)).toThrow(/UNIQUE/)
    insert.run('c', 0)
    db.close()
  })

  it('menghapus playlist ikut menghapus item-nya (CASCADE)', async () => {
    const { openDatabase } = await import('../db/database')
    const db = openDatabase(join(makeTempDir(), 'player.db'))
    const id = db
      .prepare(
        "INSERT INTO playlists (version_hash, generated_at, slot_duration_seconds) VALUES ('a','x',15)"
      )
      .run().lastInsertRowid
    db.prepare(
      "INSERT INTO playlist_items (playlist_id, slot_number, content_id, content_url, duration_seconds) VALUES (?, 1, 9, 'http://x/a.mp4', 15)"
    ).run(id)
    db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
    expect((db.prepare('SELECT COUNT(*) AS n FROM playlist_items').get() as { n: number }).n).toBe(
      0
    )
    db.close()
  })
})
