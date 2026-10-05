import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

// Lihat database.test.ts: tes yang memakai SQLite di-skip otomatis bila better-sqlite3 dikompilasi untuk Electron.
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

const log = (
  n: number
): Parameters<import('../db/playback-log-store').PlaybackLogStore['add']>[0] => ({
  contentId: n,
  contentLabel: `Konten ${n}`,
  playedAt: '2026-10-05T03:00:00.000Z',
  durationSeconds: 15,
  wasOffline: n % 2 === 0
})

describe.skipIf(!canLoad)('SqlitePlaybackLogStore', () => {
  async function open(maxRows?: number): Promise<{
    store: import('../db/playback-log-store').SqlitePlaybackLogStore
    close: () => void
  }> {
    const { openDatabase } = await import('../db/database')
    const { SqlitePlaybackLogStore } = await import('../db/playback-log-store')
    const db = openDatabase(join(makeTempDir(), 'player.db'))
    return { store: new SqlitePlaybackLogStore(db, maxRows), close: () => db.close() }
  }

  it('returns the oldest rows first and removes exactly the sent batch', async () => {
    const { store, close } = await open()
    for (let i = 1; i <= 5; i++) store.add(log(i))

    const batch = store.peek(3)
    expect(batch.map((r) => r.contentId)).toEqual([1, 2, 3])
    expect(batch[1]).toMatchObject({
      contentLabel: 'Konten 2',
      wasOffline: true,
      durationSeconds: 15
    })

    store.removeUpTo(batch[2].id)
    expect(store.peek(10).map((r) => r.contentId)).toEqual([4, 5])
    expect(store.count()).toBe(2)
    close()
  })

  it('drops the oldest rows when the queue exceeds its cap (very long offline periods)', async () => {
    const { store, close } = await open(3)
    for (let i = 1; i <= 6; i++) store.add(log(i))
    expect(store.peek(10).map((r) => r.contentId)).toEqual([4, 5, 6])
    close()
  })

  it('survives reopening the database (queue is persistent)', async () => {
    const { openDatabase } = await import('../db/database')
    const { SqlitePlaybackLogStore } = await import('../db/playback-log-store')
    const file = join(makeTempDir(), 'player.db')
    const first = openDatabase(file)
    new SqlitePlaybackLogStore(first).add(log(9))
    first.close()
    const second = openDatabase(file)
    expect(new SqlitePlaybackLogStore(second).peek(10)).toHaveLength(1)
    second.close()
  })
})
