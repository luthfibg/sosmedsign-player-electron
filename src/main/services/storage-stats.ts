import { existsSync, statSync } from 'fs'
import { basename } from 'path'
import type { PlaylistStore } from '../db/playlist-store'
import type { CacheManager } from './cache-manager'

export interface StorageStatsSnapshot {
  cacheDir: string
  cacheFiles: number
  cacheBytes: number
  /** File cache yang tidak dipakai playlist aktif (menunggu masa tenggang atau penghapusan). */
  orphanFiles: number
  orphanBytes: number
  diskFreeBytes: number | null
  diskTotalBytes: number | null
  /** Database + file WAL/SHM. */
  dbBytes: number
  itemsTotal: number
  itemsReady: number
  itemsFailed: number
  pendingPlaybackLogs: number
}

interface Deps {
  cache: CacheManager
  store: PlaylistStore
  /** Path file database; null kalau tidak diketahui (tes). */
  dbFile: string | null
  pendingPlaybackLogs: () => number
}

/** Angka penyimpanan untuk menu Pengaturan dan pemantauan. Hanya membaca; tidak mengubah apa pun. */
export class StorageStats {
  constructor(private readonly deps: Deps) {}

  async collect(): Promise<StorageStatsSnapshot> {
    const { cache, store } = this.deps
    const stats = cache.stats()
    const active = store.getActivePlaylist()
    const referenced = new Set(
      (active?.items ?? [])
        .filter((item) => item.localFile)
        .map((item) => basename(item.localFile!))
    )

    let orphanFiles = 0
    let orphanBytes = 0
    for (const file of stats.files) {
      if (referenced.has(file.name)) continue
      orphanFiles++
      orphanBytes += file.size
    }
    const disk = await cache.diskSpace()
    const items = active?.items ?? []

    return {
      cacheDir: cache.directory,
      cacheFiles: stats.fileCount,
      cacheBytes: stats.totalBytes,
      orphanFiles,
      orphanBytes,
      diskFreeBytes: disk?.free ?? null,
      diskTotalBytes: disk?.total ?? null,
      dbBytes: this.databaseBytes(),
      itemsTotal: items.length,
      itemsReady: items.filter((item) => item.downloadStatus === 'READY').length,
      itemsFailed: items.filter((item) => item.downloadStatus === 'FAILED').length,
      pendingPlaybackLogs: this.deps.pendingPlaybackLogs()
    }
  }

  private databaseBytes(): number {
    const file = this.deps.dbFile
    if (!file) return 0
    let total = 0
    for (const path of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        if (existsSync(path)) total += statSync(path).size
      } catch {
        // sedang ditulis / terkunci: abaikan
      }
    }
    return total
  }
}
