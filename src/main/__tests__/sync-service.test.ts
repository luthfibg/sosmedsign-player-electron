import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../config'
import type { PlaylistItemDto, PlaylistResponse } from '../services/api-types'
import type { ApiClient } from '../services/api-client'
import { CacheManager } from '../services/cache-manager'
import type { CredentialStore } from '../services/credential-store'
import type { DeviceService, RegistrationValidation } from '../services/device-service'
import { SyncService, describeSyncOutcome, type SyncOutcome } from '../services/sync-service'
import { makeTempDir, registerTempDirCleanup } from './helpers'
import { MemoryPlaylistStore } from './memory-store'

registerTempDirCleanup()

const MIN = 60_000
const config: AppConfig = {
  baseUrl: 'https://cms.example.test/',
  hostHeader: null,
  connectTimeoutMs: 20_000,
  requestTimeoutMs: 30_000
}

function dto(id: number, url = `https://cdn.example.test/c${id}.mp4`): PlaylistItemDto {
  return {
    slot_number: id,
    slots_used: [id],
    content_id: id,
    content_label: `Konten ${id}`,
    content_url: url,
    media_type: 'video',
    duration_seconds: 15
  }
}

function response(items: PlaylistItemDto[], version = 'v1'): PlaylistResponse {
  return {
    device_id: 'device-1',
    slot_duration_seconds: 15,
    playlist: items,
    version_hash: version,
    generated_at: '2026-10-01T00:00:00+00:00'
  }
}

interface PlaylistReply {
  status: number
  json?: unknown
  isApiMessage?: boolean
}

type Requester = (url: URL) => Promise<{ statusCode: number; body: Readable }>

const okBody = (text = 'konten'): ReturnType<Requester> =>
  Promise.resolve({ statusCode: 200, body: Readable.from([Buffer.from(text)]) })

interface SetupOptions {
  reply?: PlaylistReply
  requester?: Requester
  online?: boolean
  graceFailures?: number
  store?: MemoryPlaylistStore
  clock?: { t: number }
  /** Ruang disk palsu; tanpa ini, tes tidak bergantung pada disk mesin (cadangan 0 dan ruang tak terukur). */
  disk?: { free: number; total: number; minFree?: number }
  reporter?: { flush: ReturnType<typeof vi.fn> }
}

function setup(options: SetupOptions = {}): {
  store: MemoryPlaylistStore
  clock: { t: number }
  cacheDir: string
  cache: CacheManager
  service: SyncService
  reply: PlaylistReply
  validation: { value: RegistrationValidation }
  requester: { fn: Requester }
  online: { value: boolean }
  api: { playlist: ReturnType<typeof vi.fn>; postSyncLog: ReturnType<typeof vi.fn> }
  device: {
    validateRegistration: ReturnType<typeof vi.fn>
    forgetRegistration: ReturnType<typeof vi.fn>
  }
  syncLogs: { playlist_version_hash: string; status: string; bytes_downloaded: number }[]
  log: ReturnType<typeof vi.fn>
} {
  const store = options.store ?? new MemoryPlaylistStore()
  const clock = options.clock ?? { t: Date.now() }
  const reply: PlaylistReply = options.reply ?? { status: 204 }
  const validation: { value: RegistrationValidation } = { value: { kind: 'registered' } }
  const requester = { fn: options.requester ?? ((): ReturnType<Requester> => okBody()) }
  const online = { value: options.online ?? true }
  const syncLogs: { playlist_version_hash: string; status: string; bytes_downloaded: number }[] = []

  const api = {
    playlist: vi.fn(async () => ({
      status: reply.status,
      json: reply.json ?? null,
      isApiMessage: reply.isApiMessage ?? false,
      message: null
    })),
    postSyncLog: vi.fn(async (_deviceCode: string, _token: string, body) => {
      syncLogs.push(body)
      return { status: 201, json: null, isApiMessage: false, message: null }
    })
  }
  const device = {
    validateRegistration: vi.fn(async () => validation.value),
    forgetRegistration: vi.fn()
  }
  const credentials = {
    isRegistered: () => true,
    getOrCreateDeviceCode: () => 'device-1',
    load: () => ({ apiToken: 'token' })
  } as unknown as CredentialStore
  const log = vi.fn()
  const cacheDir = options.store ? makeTempDir() : makeTempDir()
  const cache = new CacheManager(cacheDir, config, (url) => requester.fn(url), undefined, {
    now: () => clock.t,
    orphanGraceMs: 30 * MIN,
    minFreeBytes: options.disk?.minFree ?? 0,
    diskSpaceFn: async () =>
      options.disk ? { free: options.disk.free, total: options.disk.total } : null
  })
  const service = new SyncService(
    store,
    api as unknown as ApiClient,
    device as unknown as DeviceService,
    credentials,
    cache,
    { log },
    {
      isOnline: () => online.value,
      graceFailures: options.graceFailures ?? 3,
      reporter: options.reporter as never
    }
  )
  return {
    store,
    clock,
    cacheDir,
    cache,
    service,
    reply,
    validation,
    requester,
    online,
    api,
    device,
    syncLogs,
    log
  }
}

type Context = ReturnType<typeof setup>

const cacheFiles = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.startsWith('content_') && !name.endsWith('.tmp'))

/** Menerapkan playlist awal lewat jalur sync normal, supaya file cache dan baris DB nyata. */
async function applyInitial(ctx: Context, items: PlaylistItemDto[], version = 'v1'): Promise<void> {
  ctx.reply.status = 200
  ctx.reply.json = response(items, version)
  expect(await ctx.service.syncOnce()).toBe('applied')
  ctx.syncLogs.length = 0
}

function backdate(dir: string, name: string, ageMs: number, now: number): void {
  const when = new Date(now - ageMs)
  utimesSync(join(dir, name), when, when)
}

describe('SyncService mirror sync', () => {
  it('activates a partial snapshot, reports partial, and removes long-orphaned files', async () => {
    const ctx = setup({
      reply: { status: 200, json: response([dto(1), dto(2)], 'new-version') },
      requester: async (url) =>
        url.pathname.endsWith('c2.mp4')
          ? { statusCode: 500, body: Readable.from([]) }
          : okBody('ready')
    })
    const stale = `content_9_${'a'.repeat(20)}.mp4`
    writeFileSync(join(ctx.cacheDir, stale), 'old')
    backdate(ctx.cacheDir, stale, 2 * 60 * MIN, ctx.clock.t) // tidak dipakai sejak 2 jam lalu

    expect(await ctx.service.syncOnce()).toBe('partial')

    const active = ctx.store.getActivePlaylist()
    expect(active?.versionHash).toBe('new-version')
    expect(active?.items.map((i) => i.downloadStatus)).toEqual(['READY', 'FAILED'])
    expect(ctx.syncLogs).toEqual([
      { playlist_version_hash: 'new-version', status: 'partial', bytes_downloaded: 5 }
    ])
    expect(existsSync(join(ctx.cacheDir, stale))).toBe(false)
    const indicators = ctx.service.getDiagnosticIndicators(true, true)
    expect(indicators.connected.state).toBe('active')
    expect(indicators.sync.state).toBe('warning')
    await ctx.cache.close()
  })

  it('stores the cache file NAME (not an absolute path) and keeps recently dropped files during the grace period', async () => {
    const ctx = setup()
    await applyInitial(ctx, [dto(1), dto(2)])
    const [first, second] = ctx.store.getActivePlaylist()!.items
    expect(first.localFile).toMatch(/^content_1_[0-9a-f]{20}\.mp4$/)
    expect(first.localFile).not.toContain('/')

    ctx.reply.json = response([dto(1)], 'v2')
    expect(await ctx.service.syncOnce()).toBe('applied')

    expect(existsSync(join(ctx.cacheDir, second.localFile!))).toBe(true) // masa tenggang
    await ctx.cache.close()
  })

  it('preserves the active playlist and its cache when every item download fails', async () => {
    const ctx = setup()
    await applyInitial(ctx, [dto(1)])
    const files = cacheFiles(ctx.cacheDir)

    ctx.requester.fn = async () => ({ statusCode: 500, body: Readable.from([]) })
    ctx.reply.json = response([dto(7, 'https://cdn.example.test/new.mp4')], 'v2')
    expect(await ctx.service.syncOnce()).toBe('download-failed')

    expect(ctx.store.getActivePlaylist()?.versionHash).toBe('v1')
    expect(cacheFiles(ctx.cacheDir)).toEqual(files)
    expect(ctx.syncLogs).toEqual([
      { playlist_version_hash: 'v2', status: 'failed', bytes_downloaded: 0 }
    ])
    await ctx.cache.close()
  })

  it('does not erase the playlist on a 404 "no snapshot yet" response', async () => {
    const ctx = setup()
    await applyInitial(ctx, [dto(1)])
    ctx.reply.status = 404
    ctx.reply.isApiMessage = true
    expect(await ctx.service.syncOnce()).toBe('no-playlist')
    expect(ctx.store.getActivePlaylist()?.items).toHaveLength(1)
    await ctx.cache.close()
  })

  it('skips registration validation and playlist requests while offline', async () => {
    const ctx = setup({ reply: { status: 200, json: response([dto(1)]) }, online: false })
    expect(await ctx.service.syncOnce()).toBe('offline')
    expect(ctx.device.validateRegistration).not.toHaveBeenCalled()
    expect(ctx.api.playlist).not.toHaveBeenCalled()
    await ctx.cache.close()
  })

  it('downloads shared content once and sends null as current version when forced', async () => {
    const requester = vi.fn(async () => okBody('video'))
    const ctx = setup({
      reply: { status: 200, json: response([dto(1), { ...dto(1), slot_number: 2 }]) },
      requester
    })
    expect(await ctx.service.syncOnce()).toBe('applied')
    expect(requester).toHaveBeenCalledTimes(1)
    const items = ctx.store.getActivePlaylist()!.items
    expect(items).toHaveLength(2)
    expect(items[0].localFile).toBe(items[1].localFile)

    await ctx.service.syncOnce(true)
    expect(ctx.api.playlist).toHaveBeenLastCalledWith('device-1', 'token', null)
    await ctx.cache.close()
  })

  it('skips malformed items individually instead of failing the whole snapshot', async () => {
    const broken = { slot_number: 'x', content_id: 3 } as unknown as PlaylistItemDto
    const ctx = setup({ reply: { status: 200, json: response([dto(1), broken]) } })
    expect(await ctx.service.syncOnce()).toBe('applied')
    expect(ctx.store.getActivePlaylist()?.items).toHaveLength(1)
    await ctx.cache.close()
  })

  it('ignores a snapshot whose items are all malformed (never wipes data on bad payloads)', async () => {
    const ctx = setup()
    await applyInitial(ctx, [dto(1)])
    ctx.reply.json = response([{ nope: true } as unknown as PlaylistItemDto], 'v2')
    expect(await ctx.service.syncOnce()).toBe('error')
    expect(ctx.store.getActivePlaylist()?.versionHash).toBe('v1')
    await ctx.cache.close()
  })

  it('notifies listeners when the active playlist changes', async () => {
    const ctx = setup({ reply: { status: 200, json: response([dto(1)]) } })
    const listener = vi.fn()
    ctx.service.onPlaylistChanged(listener)
    await ctx.service.syncOnce()
    expect(listener).toHaveBeenCalledTimes(1)
    await ctx.cache.close()
  })

  it('retries FAILED items when the playlist is unchanged (204) and announces recovery', async () => {
    const ctx = setup({
      reply: { status: 200, json: response([dto(1), dto(2)]) },
      requester: async (url) =>
        url.pathname.endsWith('c2.mp4') ? { statusCode: 500, body: Readable.from([]) } : okBody()
    })
    await ctx.service.syncOnce()
    expect(ctx.store.getActivePlaylist()!.items.map((i) => i.downloadStatus)).toEqual([
      'READY',
      'FAILED'
    ])

    ctx.reply.status = 204
    ctx.requester.fn = async () => okBody('pulih')
    const listener = vi.fn()
    ctx.service.onPlaylistChanged(listener)
    expect(await ctx.service.syncOnce()).toBe('not-modified')

    const items = ctx.store.getActivePlaylist()!.items
    expect(items.map((i) => i.downloadStatus)).toEqual(['READY', 'READY'])
    expect(items[1].localFile).toMatch(/^content_2_/)
    expect(listener).toHaveBeenCalledTimes(1)
    await ctx.cache.close()
  })
})

describe('SyncService release/reset handling', () => {
  it('does not resurrect the playlist or cache when the device is released mid-sync', async () => {
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const ctx = setup({
      reply: { status: 200, json: response([dto(1)]) },
      requester: async () => {
        markStarted()
        await gate
        return { statusCode: 200, body: Readable.from([Buffer.from('bytes')]) }
      }
    })

    const pending = ctx.service.syncOnce()
    await started
    ctx.service.handleRegistrationCleared('released') // pengguna melepas device saat unduhan berjalan
    openGate()

    expect(await pending).toBe('aborted')
    expect(ctx.store.getActivePlaylist()).toBeNull()
    expect(cacheFiles(ctx.cacheDir)).toEqual([])
    expect(ctx.syncLogs).toEqual([])
    await ctx.cache.close()
  })

  it.each(['released', 'identity-reset', 'unregistered'] as const)(
    'wipes playlist and cache when registration is cleared (%s)',
    async (reason) => {
      const ctx = setup()
      await applyInitial(ctx, [dto(1)])
      const listener = vi.fn()
      ctx.service.onPlaylistChanged(listener)

      ctx.service.handleRegistrationCleared(reason)

      expect(ctx.store.getActivePlaylist()).toBeNull()
      expect(cacheFiles(ctx.cacheDir)).toEqual([])
      expect(listener).toHaveBeenCalledTimes(1)
      await ctx.cache.close()
    }
  )

  it('keeps playlist and cache when the token became invalid (credentials-invalid)', async () => {
    const ctx = setup()
    await applyInitial(ctx, [dto(1)])
    ctx.service.handleRegistrationCleared('credentials-invalid')
    expect(ctx.store.getActivePlaylist()?.items).toHaveLength(1)
    expect(cacheFiles(ctx.cacheDir)).toHaveLength(1)
    await ctx.cache.close()
  })
})

describe('A: rejected token has a persisted grace period and keeps data', () => {
  it('counts JSON 403 responses, keeps data, and only gives up after the grace limit', async () => {
    const ctx = setup({ graceFailures: 3 })
    await applyInitial(ctx, [dto(1)])
    ctx.reply.status = 403
    ctx.reply.isApiMessage = true
    ctx.reply.json = { message: 'Token tidak valid' }

    expect(await ctx.service.syncOnce()).toBe('auth-rejected')
    expect(await ctx.service.syncOnce()).toBe('auth-rejected')
    expect(ctx.store.getState('auth_failures')).toBe('2')
    expect(ctx.device.forgetRegistration).not.toHaveBeenCalled()
    expect(ctx.store.getActivePlaylist()?.items).toHaveLength(1)

    expect(await ctx.service.syncOnce()).toBe('released')
    expect(ctx.device.forgetRegistration).toHaveBeenCalledWith(
      'credentials-invalid',
      expect.any(String)
    )
    expect(ctx.store.getActivePlaylist()?.items).toHaveLength(1) // data tetap ada
    await ctx.cache.close()
  })

  it('resets the counter after any successful authenticated response', async () => {
    const ctx = setup({ graceFailures: 3 })
    ctx.reply.status = 403
    ctx.reply.isApiMessage = true
    await ctx.service.syncOnce()
    await ctx.service.syncOnce()
    expect(ctx.store.getState('auth_failures')).toBe('2')

    ctx.reply.status = 204
    ctx.reply.isApiMessage = false
    await ctx.service.syncOnce()
    expect(ctx.store.getState('auth_failures')).toBeNull()
    await ctx.cache.close()
  })

  it('does not trust 403 responses that are not API JSON (proxy / captive portal)', async () => {
    const ctx = setup()
    ctx.reply.status = 403
    ctx.reply.isApiMessage = false
    expect(await ctx.service.syncOnce()).toBe('error')
    expect(ctx.store.getState('auth_failures')).toBeNull()
    await ctx.cache.close()
  })

  it('counts a JSON 403 on a content download instead of releasing immediately', async () => {
    const ctx = setup({
      reply: { status: 200, json: response([dto(1)]) },
      requester: async () => ({
        statusCode: 403,
        body: Readable.from([Buffer.from(JSON.stringify({ message: 'Forbidden' }))])
      })
    })
    expect(await ctx.service.syncOnce()).toBe('auth-rejected')
    expect(ctx.store.getState('auth_failures')).toBe('1')
    expect(ctx.device.forgetRegistration).not.toHaveBeenCalled()
    await ctx.cache.close()
  })
})

describe('B: valid empty snapshots mirror the cloud, with a grace period before deleting files', () => {
  it('accepts an empty snapshot, keeps files during the grace period, then removes them', async () => {
    const ctx = setup()
    await applyInitial(ctx, [dto(1), dto(2)])
    const files = cacheFiles(ctx.cacheDir)
    expect(files).toHaveLength(2)

    ctx.reply.json = response([], 'empty')
    expect(await ctx.service.syncOnce()).toBe('applied')
    expect(ctx.store.getActivePlaylist()).toMatchObject({ versionHash: 'empty', items: [] })
    expect(ctx.syncLogs).toEqual([
      { playlist_version_hash: 'empty', status: 'success', bytes_downloaded: 0 }
    ])
    expect(cacheFiles(ctx.cacheDir)).toEqual(files) // masa tenggang

    ctx.clock.t += 31 * MIN
    ctx.reply.status = 204
    expect(await ctx.service.syncOnce()).toBe('not-modified')
    expect(cacheFiles(ctx.cacheDir)).toEqual([])
    await ctx.cache.close()
  })

  it('counts the grace period from the moment files stopped being used, not from their last touch', async () => {
    const ctx = setup()
    await applyInitial(ctx, [dto(1)])
    // Device offline berhari-hari: mtime file sangat lama.
    for (const name of cacheFiles(ctx.cacheDir))
      backdate(ctx.cacheDir, name, 72 * 60 * MIN, ctx.clock.t)

    ctx.reply.json = response([], 'empty')
    await ctx.service.syncOnce()

    expect(cacheFiles(ctx.cacheDir)).toHaveLength(1) // belum terhapus
    await ctx.cache.close()
  })
})

describe('C: registration validation grace is persisted and ignores "unavailable" answers', () => {
  it('does not count unavailable answers (server down, HTML, timeouts)', async () => {
    const ctx = setup({ graceFailures: 3 })
    await applyInitial(ctx, [dto(1)])
    ctx.validation.value = { kind: 'unavailable', reason: 'timeout' }
    for (let i = 0; i < 6; i++) expect(await ctx.service.syncOnce()).toBe('validation-grace')
    expect(ctx.store.getState('validation_failures')).toBeNull()
    expect(ctx.device.forgetRegistration).not.toHaveBeenCalled()
    await ctx.cache.close()
  })

  it('counts definite "pending" answers, survives restarts, and releases at the limit', async () => {
    const store = new MemoryPlaylistStore()
    const first = setup({ store, graceFailures: 3 })
    first.validation.value = { kind: 'pending' }
    await first.service.syncOnce()
    await first.service.syncOnce()
    expect(store.getState('validation_failures')).toBe('2')

    // "Restart": service baru, store (database) sama
    const second = setup({ store, graceFailures: 3 })
    second.validation.value = { kind: 'pending' }
    expect(await second.service.syncOnce()).toBe('released')
    expect(second.device.forgetRegistration).toHaveBeenCalledWith(
      'unregistered',
      expect.any(String)
    )
    await first.cache.close()
    await second.cache.close()
  })

  it('resets the counter when the server confirms the device is registered again', async () => {
    const ctx = setup({ graceFailures: 3 })
    ctx.validation.value = { kind: 'pending' }
    await ctx.service.syncOnce()
    expect(ctx.store.getState('validation_failures')).toBe('1')
    ctx.validation.value = { kind: 'registered' }
    await ctx.service.syncOnce()
    expect(ctx.store.getState('validation_failures')).toBeNull()
    await ctx.cache.close()
  })
})

describe('diagnostic indicators', () => {
  it('start as unknown before the first sync attempt', async () => {
    const ctx = setup()
    expect(ctx.service.getDiagnosticIndicators(true, true)).toMatchObject({
      connected: { state: 'unknown' },
      sync: { state: 'unknown' }
    })
    await ctx.cache.close()
  })

  it('show an active CMS connection and successful sync after a normal sync', async () => {
    const ctx = setup({ reply: { status: 200, json: response([dto(1)]) } })
    expect(await ctx.service.syncOnce()).toBe('applied')
    expect(ctx.service.getDiagnosticIndicators(true, true)).toMatchObject({
      connected: { state: 'active' },
      sync: { state: 'active' }
    })
    await ctx.cache.close()
  })

  it('show the CMS as unavailable when registration validation cannot reach the API', async () => {
    const ctx = setup({ reply: { status: 200, json: response([dto(1)]) } })
    ctx.validation.value = { kind: 'unavailable', reason: 'connection timeout' }

    expect(await ctx.service.syncOnce()).toBe('validation-grace')

    expect(ctx.service.getDiagnosticIndicators(true, true)).toMatchObject({
      connected: { state: 'inactive' },
      sync: { state: 'warning' }
    })
    expect(ctx.api.playlist).not.toHaveBeenCalled()
    await ctx.cache.close()
  })

  it('mark the CMS as unreachable when the playlist request fails at the network level', async () => {
    const ctx = setup()
    ctx.api.playlist.mockRejectedValueOnce(new Error('ECONNRESET'))
    expect(await ctx.service.syncOnce()).toBe('error')
    expect(ctx.service.getDiagnosticIndicators(true, true)).toMatchObject({
      connected: { state: 'inactive' },
      sync: { state: 'error' }
    })
    await ctx.cache.close()
  })

  it('report an error when every download fails, and a warning while a rejected token is in grace', async () => {
    const ctx = setup({
      reply: { status: 200, json: response([dto(1)]) },
      requester: async () => ({ statusCode: 500, body: Readable.from([]) })
    })
    expect(await ctx.service.syncOnce()).toBe('download-failed')
    expect(ctx.service.getDiagnosticIndicators(true, true).sync.state).toBe('error')

    ctx.reply.status = 403
    ctx.reply.isApiMessage = true
    expect(await ctx.service.syncOnce()).toBe('auth-rejected')
    expect(ctx.service.getDiagnosticIndicators(true, true).sync.state).toBe('warning')
    await ctx.cache.close()
  })

  it('warn when the last CMS response is older than two sync intervals', async () => {
    const ctx = setup({ reply: { status: 204 } })
    await ctx.service.syncOnce()
    const real = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 7 * MIN)
    expect(ctx.service.getDiagnosticIndicators(true, true).connected.state).toBe('warning')
    spy.mockRestore()
    await ctx.cache.close()
  })

  it('reflect missing registration and missing network ahead of any CMS state', async () => {
    const ctx = setup({ reply: { status: 204 } })
    await ctx.service.syncOnce()
    expect(ctx.service.getDiagnosticIndicators(true, false).connected.detail).toBe(
      'Device belum terdaftar'
    )
    expect(ctx.service.getDiagnosticIndicators(false, true).connected.detail).toBe(
      'Tidak ada koneksi jaringan'
    )
    await ctx.cache.close()
  })

  it('show "working" while a sync is running', async () => {
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const ctx = setup({
      reply: { status: 200, json: response([dto(1)]) },
      requester: async () => {
        markStarted()
        await gate
        return { statusCode: 200, body: Readable.from([Buffer.from('bytes')]) }
      }
    })

    const pending = ctx.service.syncOnce()
    await started
    expect(ctx.service.getDiagnosticIndicators(true, true).sync.state).toBe('working')
    openGate()
    await pending
    expect(ctx.service.getDiagnosticIndicators(true, true).sync.state).toBe('active')
    await ctx.cache.close()
  })
})

describe('playback statistics upload', () => {
  const flushOk = { kind: 'sent', sent: 3, pending: 0 }

  it('flushes the queue every cycle, after registration is confirmed and before the playlist request', async () => {
    const order: string[] = []
    const reporter = {
      flush: vi.fn(async () => {
        order.push('flush')
        return flushOk
      })
    }
    const ctx = setup({ reporter })
    ctx.api.playlist.mockImplementation(async () => {
      order.push('playlist')
      return { status: 204, json: null, isApiMessage: false, message: null }
    })

    await ctx.service.syncOnce()

    expect(order).toEqual(['flush', 'playlist'])
    expect(reporter.flush).toHaveBeenCalledWith('device-1', 'token')
    await ctx.cache.close()
  })

  it('does not flush while offline or when registration validation is unavailable', async () => {
    const reporter = { flush: vi.fn(async () => flushOk) }
    const offline = setup({ reporter, online: false })
    await offline.service.syncOnce()
    const unavailable = setup({ reporter })
    unavailable.validation.value = { kind: 'unavailable', reason: 'timeout' }
    await unavailable.service.syncOnce()
    expect(reporter.flush).not.toHaveBeenCalled()
    await offline.cache.close()
    await unavailable.cache.close()
  })

  it('a failing upload never blocks the playlist sync', async () => {
    const reporter = { flush: vi.fn(async () => ({ kind: 'error', sent: 0, message: 'HTTP 503' })) }
    const ctx = setup({ reporter, reply: { status: 200, json: response([dto(1)]) } })
    expect(await ctx.service.syncOnce()).toBe('applied')
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining('Statistik tayang belum terkirim (HTTP 503)')
    )
    await ctx.cache.close()
  })

  it('a rejected token on the statistics endpoint counts once toward the grace period and stops the cycle', async () => {
    const reporter = { flush: vi.fn(async () => ({ kind: 'auth-rejected', sent: 0 })) }
    const ctx = setup({ reporter, graceFailures: 3 })

    expect(await ctx.service.syncOnce()).toBe('auth-rejected')

    expect(ctx.store.getState('auth_failures')).toBe('1')
    expect(ctx.api.playlist).not.toHaveBeenCalled()
    await ctx.cache.close()
  })

  it('works without a reporter configured', async () => {
    const ctx = setup({ reply: { status: 204 } })
    expect(await ctx.service.syncOnce()).toBe('not-modified')
    await ctx.cache.close()
  })
})

describe('disk space protection', () => {
  const bigDto = (id: number, size: number): PlaylistItemDto => ({ ...dto(id), file_size: size })

  it('removes fresh orphan files immediately (no grace period) when the new playlist will not fit', async () => {
    const ctx = setup({ disk: { free: 5_000, total: 100_000, minFree: 1_000 } })
    const orphan = `content_99_${'f'.repeat(20)}.mp4`
    writeFileSync(join(ctx.cacheDir, orphan), 'sisa lama')
    ctx.reply.status = 200
    ctx.reply.json = response([bigDto(1, 6_000)])
    ctx.requester.fn = async () => ({ statusCode: 200, body: Readable.from([Buffer.alloc(6_000)]) })

    await ctx.service.syncOnce()

    expect(existsSync(join(ctx.cacheDir, orphan))).toBe(false) // tanpa menunggu masa tenggang 30 menit
    await ctx.cache.close()
  })

  it('never touches files used by the new or the currently active playlist while making room', async () => {
    const ctx = setup({ disk: { free: 5_000, total: 100_000, minFree: 1_000 } })
    ctx.reply.status = 200
    ctx.reply.json = response([dto(1)], 'v1')
    expect(await ctx.service.syncOnce()).toBe('applied') // belum ada file_size: tidak ada pembersihan
    const active = ctx.store.getActivePlaylist()!.items[0].localFile!

    ctx.reply.json = response([dto(1), bigDto(2, 6_000)], 'v2')
    ctx.requester.fn = async () => ({ statusCode: 200, body: Readable.from([Buffer.alloc(6_000)]) })
    await ctx.service.syncOnce()

    expect(existsSync(join(ctx.cacheDir, active))).toBe(true)
    await ctx.cache.close()
  })

  it('reports a disk-full error in the sync indicator when content cannot be downloaded', async () => {
    const ctx = setup({ disk: { free: 5_000, total: 100_000, minFree: 1_000 } })
    ctx.reply.status = 200
    ctx.reply.json = response([bigDto(1, 6_000)])

    expect(await ctx.service.syncOnce()).toBe('download-failed')

    expect(ctx.service.getDiagnosticIndicators(true, true).sync).toEqual({
      state: 'error',
      detail: 'Ruang disk tidak cukup untuk mengunduh konten'
    })
    await ctx.cache.close()
  })

  it('clears the disk-full flag once downloads succeed again', async () => {
    const ctx = setup({ disk: { free: 5_000, total: 100_000, minFree: 1_000 } })
    ctx.reply.status = 200
    ctx.reply.json = response([bigDto(1, 6_000)])
    await ctx.service.syncOnce()

    ctx.reply.json = response([dto(1)], 'v2') // konten lebih kecil / tanpa ukuran: muat
    ctx.requester.fn = async () => okBody('kecil')
    await ctx.service.syncOnce()

    expect(ctx.service.getDiagnosticIndicators(true, true).sync.state).toBe('active')
    await ctx.cache.close()
  })
})

describe('runExclusive', () => {
  it('waits for a running sync, then blocks new cycles until the task finishes', async () => {
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const ctx = setup({
      reply: { status: 200, json: response([dto(1)]) },
      requester: async () => {
        markStarted()
        await gate
        return { statusCode: 200, body: Readable.from([Buffer.from('x')]) }
      }
    })

    const running = ctx.service.syncOnce()
    await started
    const events: string[] = []
    const exclusive = ctx.service.runExclusive(async () => {
      events.push('task-start')
      expect(await ctx.service.syncOnce()).toBe('busy') // siklus terjadwal ditahan
      events.push('task-end')
    })
    events.push('waiting')
    openGate()
    await running
    await exclusive

    expect(events).toEqual(['waiting', 'task-start', 'task-end'])
    ctx.reply.status = 204
    expect(await ctx.service.syncOnce()).toBe('not-modified') // kunci sudah dilepas
    await ctx.cache.close()
  })

  it('gives up with an error when the running sync does not finish in time', async () => {
    let never!: () => void
    const gate = new Promise<void>((resolve) => (never = resolve))
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const ctx = setup({
      reply: { status: 200, json: response([dto(1)]) },
      requester: async () => {
        markStarted()
        await gate
        return { statusCode: 200, body: Readable.from([Buffer.from('x')]) }
      }
    })
    const running = ctx.service.syncOnce()
    await started
    await expect(ctx.service.runExclusive(async () => 1, 120)).rejects.toThrow(/masih berjalan/)
    never()
    await running
    await ctx.cache.close()
  })

  it('releases the lock even when the task throws', async () => {
    const ctx = setup({ reply: { status: 204 } })
    await expect(
      ctx.service.runExclusive(async () => {
        throw new Error('gagal')
      })
    ).rejects.toThrow('gagal')
    expect(await ctx.service.syncOnce()).toBe('not-modified')
    await ctx.cache.close()
  })
})

describe('verifyAndRepair', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
  const withChecksum = (id: number, text: string): PlaylistItemDto => ({
    ...dto(id),
    file_size: Buffer.byteLength(text),
    checksum_sha256: sha(text)
  })

  it('marks missing and corrupt files FAILED, deletes the corrupt ones, and downloads them again', async () => {
    const ctx = setup({
      requester: async (url) => okBody(url.pathname.endsWith('c1.mp4') ? 'satu-asli' : 'dua-asli')
    })
    ctx.reply.status = 200
    ctx.reply.json = response([withChecksum(1, 'satu-asli'), withChecksum(2, 'dua-asli')])
    expect(await ctx.service.syncOnce()).toBe('applied')
    const [first, second] = ctx.store.getActivePlaylist()!.items
    writeFileSync(join(ctx.cacheDir, first.localFile!), 'RUSAK!!!!') // ukuran sama, isi beda
    unlinkSync(join(ctx.cacheDir, second.localFile!)) // hilang
    ctx.reply.status = 204

    const result = await ctx.service.verifyAndRepair()

    expect(result).toEqual({ checked: 2, missing: 1, corrupt: 1, stillFailed: 0 })
    const after = ctx.store.getActivePlaylist()!.items
    expect(after.map((i) => i.downloadStatus)).toEqual(['READY', 'READY'])
    expect(readFileSync(join(ctx.cacheDir, after[0].localFile!), 'utf8')).toBe('satu-asli')
    expect(existsSync(join(ctx.cacheDir, after[1].localFile!))).toBe(true)
    await ctx.cache.close()
  })

  it('leaves healthy files alone and does not hit the network', async () => {
    const requester = vi.fn(async () => okBody('baik'))
    const ctx = setup({ requester })
    ctx.reply.status = 200
    ctx.reply.json = response([withChecksum(1, 'baik')])
    await ctx.service.syncOnce()
    ctx.reply.status = 204
    requester.mockClear()

    expect(await ctx.service.verifyAndRepair()).toEqual({
      checked: 1,
      missing: 0,
      corrupt: 0,
      stillFailed: 0
    })
    expect(requester).not.toHaveBeenCalled()
    await ctx.cache.close()
  })

  it('reports items that still cannot be downloaded', async () => {
    const ctx = setup({ requester: async () => okBody('baik') })
    ctx.reply.status = 200
    ctx.reply.json = response([withChecksum(1, 'baik')])
    await ctx.service.syncOnce()
    unlinkSync(join(ctx.cacheDir, ctx.store.getActivePlaylist()!.items[0].localFile!))
    ctx.reply.status = 204
    ctx.requester.fn = async () => ({ statusCode: 500, body: Readable.from([]) })

    const result = await ctx.service.verifyAndRepair()

    expect(result).toMatchObject({ missing: 1, stillFailed: 1 })
    await ctx.cache.close()
  })

  it('does nothing when there is no active playlist', async () => {
    const ctx = setup({ reply: { status: 204 } })
    expect(await ctx.service.verifyAndRepair()).toEqual({
      checked: 0,
      missing: 0,
      corrupt: 0,
      stillFailed: 0
    })
    await ctx.cache.close()
  })

  it('verifies shared files only once', async () => {
    const ctx = setup({ requester: async () => okBody('baik') })
    ctx.reply.status = 200
    ctx.reply.json = response([
      withChecksum(1, 'baik'),
      { ...withChecksum(1, 'baik'), slot_number: 2 }
    ])
    await ctx.service.syncOnce()
    ctx.reply.status = 204
    expect((await ctx.service.verifyAndRepair()).checked).toBe(1)
    await ctx.cache.close()
  })
})

describe('verifyAndRepair without checksums (after moving the cache folder)', () => {
  it('only checks existence and size, so a same-size corrupt file passes but a missing one is repaired', async () => {
    const text = 'isi-asli'
    const sha = createHash('sha256').update(text).digest('hex')
    const ctx = setup({ requester: async () => okBody(text) })
    ctx.reply.status = 200
    ctx.reply.json = response([
      { ...dto(1), file_size: Buffer.byteLength(text), checksum_sha256: sha },
      { ...dto(2), file_size: Buffer.byteLength(text), checksum_sha256: sha }
    ])
    await ctx.service.syncOnce()
    const [first, second] = ctx.store.getActivePlaylist()!.items
    writeFileSync(join(ctx.cacheDir, first.localFile!), 'RUSAK!!!') // ukuran sama (8 byte)
    unlinkSync(join(ctx.cacheDir, second.localFile!))
    ctx.reply.status = 204

    const result = await ctx.service.verifyAndRepair({ checksum: false })

    expect(result).toMatchObject({ checked: 2, corrupt: 0, missing: 1, stillFailed: 0 })
    expect(readFileSync(join(ctx.cacheDir, first.localFile!), 'utf8')).toBe('RUSAK!!!') // tidak diperiksa isinya
    await ctx.cache.close()
  })
})

describe('describeSyncOutcome', () => {
  it('has a readable message for every outcome', () => {
    const outcomes: SyncOutcome[] = [
      'applied',
      'not-modified',
      'no-playlist',
      'offline',
      'not-registered',
      'validation-grace',
      'auth-rejected',
      'released',
      'download-failed',
      'partial',
      'error',
      'busy',
      'aborted'
    ]
    const messages = outcomes.map(describeSyncOutcome)
    expect(messages.every((m) => m.length > 8 && m.endsWith('.'))).toBe(true)
    expect(new Set(messages).size).toBe(outcomes.length)
  })
})
