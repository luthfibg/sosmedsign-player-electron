import { existsSync, readdirSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../config'
import type { NewPlaylistItem } from '../db/playlist-store'
import { CACHE_MARKER_FILE } from '../services/cache-dir'
import { CacheManager } from '../services/cache-manager'
import { MaintenanceService } from '../services/maintenance-service'
import { SettingsStore } from '../services/settings-store'
import { StorageStats } from '../services/storage-stats'
import type { SyncOutcome, VerifyResult } from '../services/sync-service'
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
const ORPHAN = `content_9_${'f'.repeat(20)}.mp4`

function playlistItem(file: string): NewPlaylistItem {
  return {
    slotNumber: 1,
    slotsUsed: [1],
    contentId: 1,
    contentLabel: 'Promo',
    contentUrl: 'https://cdn/c1.mp4',
    mediaType: 'video',
    durationSeconds: 15,
    fileSize: null,
    checksumSha256: null,
    localFile: file,
    downloadStatus: 'READY',
    schedule: null
  }
}

interface Rig {
  service: MaintenanceService
  cache: CacheManager
  store: MemoryPlaylistStore
  settings: SettingsStore
  defaultDir: string
  sync: {
    runExclusive: ReturnType<typeof vi.fn>
    verifyAndRepair: ReturnType<typeof vi.fn>
    syncOnce: ReturnType<typeof vi.fn>
    getDiagnosticIndicators: ReturnType<typeof vi.fn>
  }
  device: { getState: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
  applyKeepScreenOn: ReturnType<typeof vi.fn>
  logs: string[]
}

function setup(options: { registered?: boolean; fallbackReason?: string | null } = {}): Rig {
  const defaultDir = join(makeTempDir(), 'bawaan')
  const cache = new CacheManager(defaultDir, config, undefined, undefined, {
    minFreeBytes: 0,
    diskSpaceFn: async () => ({ free: 50_000, total: 100_000 })
  })
  const store = new MemoryPlaylistStore()
  const settings = new SettingsStore(join(makeTempDir(), 'settings.json'))
  const logs: string[] = []
  const verify: VerifyResult = { checked: 0, missing: 0, corrupt: 0, stillFailed: 0 }
  const sync = {
    runExclusive: vi.fn(async (task: () => Promise<unknown>) => task()),
    verifyAndRepair: vi.fn(async () => verify),
    syncOnce: vi.fn(async (): Promise<SyncOutcome> => 'not-modified'),
    getDiagnosticIndicators: vi.fn(() => ({
      connected: { state: 'active', detail: 'API CMS merespons' },
      sync: { state: 'active', detail: 'Sinkronisasi terakhir berhasil' }
    }))
  }
  const device = {
    getState: vi.fn(() => ({
      registered: options.registered ?? true,
      deviceCode: 'device-uuid-1234',
      venueId: 7,
      deviceName: 'Lobby'
    })),
    release: vi.fn(async () => ({ ok: true as const }))
  }
  const applyKeepScreenOn = vi.fn()
  const service = new MaintenanceService({
    cache,
    store,
    settings,
    storageStats: new StorageStats({ cache, store, dbFile: null, pendingPlaybackLogs: () => 4 }),
    sync: sync as never,
    device: device as never,
    diagnostics: { log: (m) => logs.push(m) },
    defaultCacheDir: defaultDir,
    cacheDirFallbackReason: options.fallbackReason ?? null,
    backendUrl: 'https://cms.example.test/',
    isOnline: () => true,
    appInfo: () => ({ version: '1.2.3', electron: '39.0.0' }),
    memory: () => ({ appBytes: 300, systemTotalBytes: 1000, systemFreeBytes: 400 }),
    applyKeepScreenOn
  })
  return { service, cache, store, settings, defaultDir, sync, device, applyKeepScreenOn, logs }
}

describe('MaintenanceService.getOverview', () => {
  it('combines device, app, system, storage, sync and settings information', async () => {
    const rig = setup({ fallbackReason: 'drive tidak ada' })
    writeFileSync(join(rig.defaultDir, A), 'abcd')
    rig.store.activatePlaylist({ versionHash: 'v', generatedAt: 'x', slotDurationSeconds: 15 }, [
      playlistItem(A)
    ])

    const overview = await rig.service.getOverview()

    expect(overview.device).toEqual({
      registered: true,
      deviceCode: 'device-uuid-1234',
      deviceName: 'Lobby',
      venueId: 7
    })
    expect(overview.app).toEqual({
      version: '1.2.3',
      electron: '39.0.0',
      backendUrl: 'https://cms.example.test/'
    })
    expect(overview.system).toEqual({ appBytes: 300, systemTotalBytes: 1000, systemFreeBytes: 400 })
    expect(overview.storage).toMatchObject({
      cacheDir: rig.defaultDir,
      cacheFiles: 1,
      cacheBytes: 4,
      orphanFiles: 0,
      diskFreeBytes: 50_000,
      itemsTotal: 1,
      itemsReady: 1,
      pendingPlaybackLogs: 4
    })
    expect(overview.sync).toEqual({ state: 'active', detail: 'Sinkronisasi terakhir berhasil' })
    expect(overview.settings).toEqual({
      keepScreenOn: true,
      customCacheDir: null,
      defaultCacheDir: rig.defaultDir,
      cacheDirFallbackReason: 'drive tidak ada'
    })
  })
})

describe('MaintenanceService.previewCacheDir', () => {
  it('reports validation failures with the reason', () => {
    const rig = setup()
    const foreign = makeTempDir()
    writeFileSync(join(foreign, 'dokumen.docx'), 'x')
    expect(rig.service.previewCacheDir(foreign)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('bukan folder cache')
    })
    expect(rig.service.previewCacheDir('relatif')).toMatchObject({ ok: false })
  })

  it('reports a usable folder together with what would be moved', () => {
    const rig = setup()
    writeFileSync(join(rig.defaultDir, A), 'abcd')
    expect(rig.service.previewCacheDir(join(makeTempDir(), 'baru'))).toEqual({
      ok: true,
      reason: null,
      isNew: true,
      existingCacheFiles: 0,
      currentFiles: 1,
      currentBytes: 4
    })
  })
})

describe('MaintenanceService.changeCacheDir', () => {
  it('moves the cache, saves the setting, clears the fallback warning, and repairs only by size', async () => {
    const rig = setup({ fallbackReason: 'drive tidak ada' })
    writeFileSync(join(rig.defaultDir, A), 'abcd')
    const target = join(makeTempDir(), 'baru')

    const result = await rig.service.changeCacheDir(target, 'move')

    expect(result.ok).toBe(true)
    expect(result.message).toContain(target)
    expect(result.message).toContain('1 file dipindahkan')
    expect(rig.settings.get().cacheDir).toBe(target)
    expect(existsSync(join(target, A))).toBe(true)
    expect(rig.sync.runExclusive).toHaveBeenCalledTimes(1)
    expect(rig.sync.verifyAndRepair).toHaveBeenCalledWith({ checksum: false })
    expect((await rig.service.getOverview()).settings.cacheDirFallbackReason).toBeNull()
  })

  it('switching back to the default folder clears the custom setting', async () => {
    const rig = setup()
    const custom = join(makeTempDir(), 'khusus')
    await rig.service.changeCacheDir(custom, 'move')
    expect(rig.settings.get().cacheDir).toBe(custom)

    const result = await rig.service.changeCacheDir(rig.defaultDir, 'move')

    expect(result.ok).toBe(true)
    expect(rig.settings.get().cacheDir).toBeNull()
  })

  it('reports invalid folders and changes nothing', async () => {
    const rig = setup()
    const foreign = makeTempDir()
    writeFileSync(join(foreign, 'dokumen.docx'), 'x')

    const result = await rig.service.changeCacheDir(foreign, 'move')

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('bukan folder cache')
    })
    expect(rig.settings.get().cacheDir).toBeNull()
    expect(rig.sync.verifyAndRepair).not.toHaveBeenCalled()
  })

  it('fresh mode reports deleted files and the re-download', async () => {
    const rig = setup()
    writeFileSync(join(rig.defaultDir, A), 'abcd')
    rig.sync.verifyAndRepair.mockResolvedValueOnce({
      checked: 1,
      missing: 1,
      corrupt: 0,
      stillFailed: 0
    })

    const result = await rig.service.changeCacheDir(join(makeTempDir(), 'baru'), 'fresh')

    expect(result.message).toContain('1 file lama dihapus')
    expect(result.message).toContain('1 konten diunduh ulang')
  })

  it('tells when some content still could not be downloaded', async () => {
    const rig = setup()
    rig.sync.verifyAndRepair.mockResolvedValueOnce({
      checked: 2,
      missing: 2,
      corrupt: 0,
      stillFailed: 2
    })
    const result = await rig.service.changeCacheDir(join(makeTempDir(), 'baru'), 'fresh')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('2 konten belum terunduh')
  })

  it('returns the error when the exclusive section cannot start (sync stuck)', async () => {
    const rig = setup()
    rig.sync.runExclusive.mockRejectedValueOnce(new Error('Sinkronisasi masih berjalan'))
    expect(await rig.service.changeCacheDir(join(makeTempDir(), 'baru'), 'move')).toEqual({
      ok: false,
      message: 'Sinkronisasi masih berjalan'
    })
  })
})

describe('MaintenanceService.cleanCache', () => {
  it('removes unreferenced files immediately (no grace period) and keeps playlist files', async () => {
    const rig = setup()
    writeFileSync(join(rig.defaultDir, A), 'abcd')
    writeFileSync(join(rig.defaultDir, ORPHAN), 'yatim!')
    const justNow = new Date()
    utimesSync(join(rig.defaultDir, ORPHAN), justNow, justNow) // baru saja, masih dalam masa tenggang
    rig.store.activatePlaylist({ versionHash: 'v', generatedAt: 'x', slotDurationSeconds: 15 }, [
      playlistItem(A)
    ])

    const result = await rig.service.cleanCache()

    expect(result.ok).toBe(true)
    expect(result.message).toMatch(
      /^1 file tidak terpakai dihapus \(6\.0 B\)|^1 file tidak terpakai dihapus \(6 B\)/
    )
    expect(readdirSync(rig.defaultDir).filter((n) => n !== CACHE_MARKER_FILE)).toEqual([A])
    expect(rig.sync.runExclusive).toHaveBeenCalledTimes(1)
  })

  it('says so when there is nothing to clean', async () => {
    const rig = setup()
    expect(await rig.service.cleanCache()).toEqual({
      ok: true,
      message: 'Tidak ada file yang perlu dibersihkan.'
    })
  })
})

describe('MaintenanceService.verifyCache', () => {
  it('summarizes the outcomes in plain language', async () => {
    const rig = setup()
    expect(await rig.service.verifyCache()).toEqual({
      ok: true,
      message: 'Tidak ada file cache untuk diperiksa.'
    })

    rig.sync.verifyAndRepair.mockResolvedValueOnce({
      checked: 5,
      missing: 0,
      corrupt: 0,
      stillFailed: 0
    })
    expect((await rig.service.verifyCache()).message).toBe('5 file diperiksa, semuanya baik.')

    rig.sync.verifyAndRepair.mockResolvedValueOnce({
      checked: 5,
      missing: 1,
      corrupt: 1,
      stillFailed: 0
    })
    expect(await rig.service.verifyCache()).toEqual({
      ok: true,
      message: '5 file diperiksa: 1 rusak, 1 hilang. Semua sudah diunduh ulang.'
    })

    rig.sync.verifyAndRepair.mockResolvedValueOnce({
      checked: 5,
      missing: 1,
      corrupt: 0,
      stillFailed: 1
    })
    const partial = await rig.service.verifyCache()
    expect(partial.ok).toBe(false)
    expect(partial.message).toContain('1 konten belum terunduh')
  })

  it('returns errors instead of throwing', async () => {
    const rig = setup()
    rig.sync.verifyAndRepair.mockRejectedValueOnce(new Error('sync macet'))
    expect(await rig.service.verifyCache()).toEqual({ ok: false, message: 'sync macet' })
  })
})

describe('MaintenanceService other actions', () => {
  it.each([
    ['applied', true],
    ['not-modified', true],
    ['offline', true],
    ['error', false],
    ['download-failed', false],
    ['auth-rejected', false]
  ] as const)('forceSync maps outcome %s', async (outcome, ok) => {
    const rig = setup()
    rig.sync.syncOnce.mockResolvedValueOnce(outcome)
    const result = await rig.service.forceSync()
    expect(result.ok).toBe(ok)
    expect(result.message.length).toBeGreaterThan(5)
    expect(rig.sync.syncOnce).toHaveBeenCalledWith(true)
  })

  it('setKeepScreenOn persists the setting and applies it immediately', () => {
    const rig = setup()
    rig.service.setKeepScreenOn(false)
    expect(rig.settings.get().keepScreenOn).toBe(false)
    expect(rig.applyKeepScreenOn).toHaveBeenCalledWith(false)
  })

  it('releaseDevice maps the device service outcome', async () => {
    const rig = setup()
    expect(await rig.service.releaseDevice()).toEqual({
      ok: true,
      message: 'Device dilepas dari CMS.'
    })
    rig.device.release.mockResolvedValueOnce({
      ok: false,
      message: 'Device masih punya booking aktif.'
    } as never)
    expect(await rig.service.releaseDevice()).toEqual({
      ok: false,
      message: 'Device masih punya booking aktif.'
    })
  })
})
