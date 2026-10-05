import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../config'
import type { NewPlaylistItem } from '../db/playlist-store'
import { CacheManager } from '../services/cache-manager'
import { StorageStats } from '../services/storage-stats'
import { makeTempDir, registerTempDirCleanup } from './helpers'
import { MemoryPlaylistStore } from './memory-store'

registerTempDirCleanup()

const config: AppConfig = {
  baseUrl: 'https://cms.example.test/',
  hostHeader: null,
  connectTimeoutMs: 20_000,
  requestTimeoutMs: 30_000
}

const A = `content_1_${'a'.repeat(20)}.mp4`
const B = `content_2_${'b'.repeat(20)}.mp4`
const ORPHAN = `content_9_${'f'.repeat(20)}.mp4`

function item(
  contentId: number,
  localFile: string | null,
  status: 'READY' | 'FAILED'
): NewPlaylistItem {
  return {
    slotNumber: contentId,
    slotsUsed: [contentId],
    contentId,
    contentLabel: `K${contentId}`,
    contentUrl: `https://cdn/c${contentId}.mp4`,
    mediaType: 'video' as const,
    durationSeconds: 15,
    fileSize: null,
    checksumSha256: null,
    localFile,
    downloadStatus: status,
    schedule: null
  }
}

describe('StorageStats', () => {
  it('summarizes cache size, orphans, playlist item states, database size and pending logs', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, A), 'aaaa')
    writeFileSync(join(dir, B), 'bb')
    writeFileSync(join(dir, ORPHAN), 'ffffff')
    const dbFile = join(makeTempDir(), 'player.db')
    writeFileSync(dbFile, 'x'.repeat(100))
    writeFileSync(`${dbFile}-wal`, 'y'.repeat(30))

    const store = new MemoryPlaylistStore()
    store.activatePlaylist({ versionHash: 'v', generatedAt: 'x', slotDurationSeconds: 15 }, [
      item(1, A, 'READY'),
      item(2, B, 'READY'),
      item(3, null, 'FAILED')
    ])
    const cache = new CacheManager(dir, config, undefined, undefined, {
      diskSpaceFn: async () => ({ free: 40_000, total: 100_000 })
    })

    const stats = await new StorageStats({
      cache,
      store,
      dbFile,
      pendingPlaybackLogs: () => 12
    }).collect()

    expect(stats).toEqual({
      cacheDir: dir,
      cacheFiles: 3,
      cacheBytes: 12,
      orphanFiles: 1,
      orphanBytes: 6,
      diskFreeBytes: 40_000,
      diskTotalBytes: 100_000,
      dbBytes: 130,
      itemsTotal: 3,
      itemsReady: 2,
      itemsFailed: 1,
      pendingPlaybackLogs: 12
    })
    await cache.close()
  })

  it('handles no playlist, an unmeasurable disk and an unknown database file', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, A), 'aaaa')
    const cache = new CacheManager(dir, config, undefined, undefined, {
      diskSpaceFn: async () => null
    })

    const stats = await new StorageStats({
      cache,
      store: new MemoryPlaylistStore(),
      dbFile: null,
      pendingPlaybackLogs: () => 0
    }).collect()

    expect(stats).toMatchObject({
      cacheFiles: 1,
      orphanFiles: 1, // tanpa playlist aktif semua file dianggap yatim
      diskFreeBytes: null,
      diskTotalBytes: null,
      dbBytes: 0,
      itemsTotal: 0
    })
    await cache.close()
  })
})
