import { basename } from 'path'
import type { PlaylistStore } from '../db/playlist-store'
import { formatBytes, type CacheDirMode, type CacheManager } from './cache-manager'
import { validateCacheDir } from './cache-dir'
import type { DeviceService } from './device-service'
import type { Diagnostics } from './diagnostics'
import type { SettingsStore } from './settings-store'
import type { StorageStats } from './storage-stats'
import { describeSyncOutcome, type SyncService } from './sync-service'

export interface ActionResult {
  ok: boolean
  message: string
}

export interface CacheDirPreview {
  ok: boolean
  reason: string | null
  /** Folder belum ada atau kosong. */
  isNew: boolean
  /** File cache SosmedSign yang sudah ada di folder tujuan (folder bertanda). */
  existingCacheFiles: number
  /** Cache saat ini, untuk menjelaskan apa yang akan dipindahkan. */
  currentFiles: number
  currentBytes: number
}

interface Deps {
  cache: CacheManager
  store: PlaylistStore
  settings: SettingsStore
  storageStats: StorageStats
  sync: Pick<
    SyncService,
    'runExclusive' | 'verifyAndRepair' | 'syncOnce' | 'getDiagnosticIndicators'
  >
  device: Pick<DeviceService, 'getState' | 'release'>
  diagnostics: Pick<Diagnostics, 'log'>
  defaultCacheDir: string
  /** Alasan folder khusus tidak dipakai saat startup (null = tidak ada masalah). */
  cacheDirFallbackReason: string | null
  backendUrl: string
  isOnline: () => boolean
  appInfo: () => { version: string; electron: string }
  memory: () => { appBytes: number; systemTotalBytes: number; systemFreeBytes: number }
  applyKeepScreenOn: (on: boolean) => void
}

/** Aksi manual di menu Pengaturan. Semua yang mengubah cache/playlist berjalan eksklusif terhadap sync. */
export class MaintenanceService {
  private fallbackReason: string | null

  constructor(private readonly deps: Deps) {
    this.fallbackReason = deps.cacheDirFallbackReason
  }

  async getOverview(): Promise<SettingsOverviewDto> {
    const { device, settings, sync } = this.deps
    const state = device.getState()
    const online = this.deps.isOnline()
    const storage = await this.deps.storageStats.collect()
    const custom = settings.get()
    return {
      device: {
        registered: state.registered,
        deviceCode: state.deviceCode,
        deviceName: state.deviceName,
        venueId: state.venueId
      },
      app: { ...this.deps.appInfo(), backendUrl: this.deps.backendUrl },
      system: this.deps.memory(),
      storage,
      sync: sync.getDiagnosticIndicators(online, state.registered).sync,
      settings: {
        keepScreenOn: custom.keepScreenOn,
        customCacheDir: custom.cacheDir,
        defaultCacheDir: this.deps.defaultCacheDir,
        cacheDirFallbackReason: this.fallbackReason
      }
    }
  }

  previewCacheDir(path: string): CacheDirPreview {
    const stats = this.deps.cache.stats()
    const base = { currentFiles: stats.fileCount, currentBytes: stats.totalBytes }
    const check = validateCacheDir(path)
    if (!check.ok) {
      return { ok: false, reason: check.reason, isNew: false, existingCacheFiles: 0, ...base }
    }
    return {
      ok: true,
      reason: null,
      isNew: check.isNew,
      existingCacheFiles: check.existingCacheFiles,
      ...base
    }
  }

  async changeCacheDir(path: string, mode: CacheDirMode): Promise<ActionResult> {
    try {
      const result = await this.deps.sync.runExclusive(() =>
        this.deps.cache.changeDirectory(path, mode)
      )
      const isDefault = samePath(result.newDir, this.deps.defaultCacheDir)
      this.deps.settings.update({ cacheDir: isDefault ? null : result.newDir })
      this.fallbackReason = null
      this.deps.diagnostics.log(`Folder cache diganti: ${result.newDir}`)

      // File yang tidak ikut pindah (atau semua, pada mode fresh) terdeteksi hilang dan langsung diunduh ulang.
      const repair = await this.deps.sync.verifyAndRepair({ checksum: false })
      const parts =
        mode === 'move'
          ? [
              `${result.moved} file dipindahkan`,
              ...(result.failed > 0 ? [`${result.failed} gagal`] : [])
            ]
          : [`${result.removed} file lama dihapus`]
      if (repair.missing + repair.corrupt > 0) {
        parts.push(
          repair.stillFailed === 0
            ? `${repair.missing + repair.corrupt} konten diunduh ulang`
            : `${repair.stillFailed} konten belum terunduh (dicoba lagi otomatis)`
        )
      }
      return { ok: true, message: `Folder cache sekarang ${result.newDir}. ${parts.join(', ')}.` }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  async cleanCache(): Promise<ActionResult> {
    try {
      const result = await this.deps.sync.runExclusive(async () => {
        const keep = (this.deps.store.getActivePlaylist()?.items ?? [])
          .filter((item) => item.localFile)
          .map((item) => this.deps.cache.pathFor(basename(item.localFile as string)))
        return this.deps.cache.cleanupUnused(keep, { ignoreGrace: true })
      })
      this.deps.diagnostics.log(
        `Pembersihan manual: ${result.deleted} file dihapus (${formatBytes(result.freedBytes)})`
      )
      if (result.deleted === 0 && result.deferred === 0) {
        return { ok: true, message: 'Tidak ada file yang perlu dibersihkan.' }
      }
      const deferred = result.deferred > 0 ? `, ${result.deferred} ditunda (sedang dipakai)` : ''
      return {
        ok: true,
        message: `${result.deleted} file tidak terpakai dihapus (${formatBytes(result.freedBytes)})${deferred}.`
      }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  async verifyCache(): Promise<ActionResult> {
    try {
      const result = await this.deps.sync.verifyAndRepair()
      if (result.checked === 0)
        return { ok: true, message: 'Tidak ada file cache untuk diperiksa.' }
      const problems = result.corrupt + result.missing
      if (problems === 0) {
        return { ok: true, message: `${result.checked} file diperiksa, semuanya baik.` }
      }
      return {
        ok: result.stillFailed === 0,
        message:
          `${result.checked} file diperiksa: ${result.corrupt} rusak, ${result.missing} hilang. ` +
          (result.stillFailed === 0
            ? 'Semua sudah diunduh ulang.'
            : `${result.stillFailed} konten belum terunduh; dicoba lagi otomatis.`)
      }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  async forceSync(): Promise<ActionResult> {
    this.deps.diagnostics.log('Sync ulang paksa diminta dari menu Pengaturan')
    const outcome = await this.deps.sync.syncOnce(true)
    const failed = ['error', 'download-failed', 'auth-rejected', 'released'].includes(outcome)
    return { ok: !failed, message: describeSyncOutcome(outcome) }
  }

  setKeepScreenOn(on: boolean): void {
    this.deps.settings.update({ keepScreenOn: on })
    this.deps.applyKeepScreenOn(on)
    this.deps.diagnostics.log(`Keep screen on: ${on ? 'aktif' : 'nonaktif'}`)
  }

  async releaseDevice(): Promise<ActionResult> {
    const outcome = await this.deps.device.release()
    return outcome.ok
      ? { ok: true, message: 'Device dilepas dari CMS.' }
      : { ok: false, message: outcome.message }
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string): string =>
    (process.platform === 'win32' ? value.toLowerCase() : value).replace(/[\\/]+$/, '')
  return norm(a) === norm(b)
}
