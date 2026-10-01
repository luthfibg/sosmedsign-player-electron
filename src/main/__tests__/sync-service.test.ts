import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { Readable } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db/database'
import type { AppConfig } from '../config'
import type { PlaylistItemDto, PlaylistResponse } from '../services/api-types'
import type { ApiClient } from '../services/api-client'
import { CacheManager } from '../services/cache-manager'
import type { CredentialStore } from '../services/credential-store'
import type { DeviceService } from '../services/device-service'
import type { Diagnostics } from '../services/diagnostics'
import { SyncService } from '../services/sync-service'
import { makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

const config: AppConfig = {
  baseUrl: 'https://cms.example.test/',
  hostHeader: null,
  connectTimeoutMs: 20_000,
  requestTimeoutMs: 30_000
}

interface FakePlaylist {
  id: number
  version_hash: string
  generated_at: string
  slot_duration_seconds: number
  is_active: number
}

interface FakeItem {
  id: number
  playlist_id: number
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

class FakeDatabase {
  playlists: FakePlaylist[] = []
  items: FakeItem[] = []
  private nextPlaylistId = 1
  private nextItemId = 1

  prepare(sql: string): {
    get: () => unknown
    all: () => unknown[]
    run: (...params: unknown[]) => { lastInsertRowid: number }
  } {
    return {
      get: () => {
        if (sql.includes('SELECT version_hash FROM playlists')) {
          const active = this.playlists.find((playlist) => playlist.is_active === 1)
          return active ? { version_hash: active.version_hash } : undefined
        }
        return undefined
      },
      all: () => {
        if (!sql.includes("download_status = 'FAILED'")) return []
        const active = this.playlists.find((playlist) => playlist.is_active === 1)
        return active
          ? this.items
              .filter((item) => item.playlist_id === active.id && item.download_status === 'FAILED')
              .map((item) => ({
                ...item,
                days: item.schedule_days,
                start: item.schedule_start,
                end: item.schedule_end,
                timezone: item.schedule_timezone,
                startDate: item.schedule_start_date,
                endDate: item.schedule_end_date
              }))
          : []
      },
      run: (...params: unknown[]) => {
        if (sql.startsWith('INSERT INTO playlists')) {
          const playlist = {
            id: this.nextPlaylistId++,
            version_hash: params[0] as string,
            generated_at: params[1] as string,
            slot_duration_seconds: params[2] as number,
            is_active: 0
          }
          this.playlists.push(playlist)
          return { lastInsertRowid: playlist.id }
        }
        if (sql.startsWith('INSERT INTO playlist_items')) {
          this.items.push({
            id: this.nextItemId++,
            playlist_id: params[0] as number,
            slot_number: params[1] as number,
            slots_used: params[2] as string,
            content_id: params[3] as number,
            content_label: params[4] as string | null,
            content_url: params[5] as string,
            media_type: params[6] as string,
            duration_seconds: params[7] as number,
            file_size: params[8] as number | null,
            checksum_sha256: params[9] as string | null,
            local_file_path: params[10] as string | null,
            download_status: params[11] as string,
            schedule_days: params[12] as string | null,
            schedule_start: params[13] as string | null,
            schedule_end: params[14] as string | null,
            schedule_timezone: params[15] as string | null,
            schedule_start_date: params[16] as string | null,
            schedule_end_date: params[17] as string | null
          })
          return { lastInsertRowid: this.nextItemId - 1 }
        }
        if (sql === 'DELETE FROM playlists') {
          this.playlists = []
          this.items = []
        } else if (sql.startsWith('UPDATE playlists SET is_active = 0')) {
          for (const playlist of this.playlists) playlist.is_active = 0
        } else if (sql.startsWith('UPDATE playlists SET is_active = 1')) {
          const id = params[0] as number
          const playlist = this.playlists.find((candidate) => candidate.id === id)
          if (playlist) playlist.is_active = 1
        } else if (sql.startsWith('DELETE FROM playlists WHERE id <>')) {
          const id = params[0] as number
          const removed = this.playlists.filter((playlist) => playlist.id !== id)
          this.playlists = this.playlists.filter((playlist) => playlist.id === id)
          const removedIds = new Set(removed.map((playlist) => playlist.id))
          this.items = this.items.filter((item) => !removedIds.has(item.playlist_id))
        } else if (sql.startsWith('UPDATE playlist_items SET local_file_path')) {
          const item = this.items.find((candidate) => candidate.id === params[1])
          if (item) {
            item.local_file_path = params[0] as string
            item.download_status = 'READY'
          }
        }
        return { lastInsertRowid: 0 }
      }
    }
  }

  transaction<T>(callback: () => T): () => T {
    return () => callback()
  }

  seedActive(version: string): void {
    this.playlists.push({
      id: this.nextPlaylistId++,
      version_hash: version,
      generated_at: '2026-10-01T00:00:00Z',
      slot_duration_seconds: 15,
      is_active: 1
    })
  }
}

function dto(id: number, url: string): PlaylistItemDto {
  return {
    slot_number: id,
    slots_used: [id],
    content_id: id,
    content_label: `Content ${id}`,
    content_url: url,
    media_type: 'video',
    duration_seconds: 15
  }
}

function response(items: PlaylistItemDto[]): PlaylistResponse {
  return {
    device_id: 'device-1',
    slot_duration_seconds: 15,
    playlist: items,
    version_hash: 'new-version',
    generated_at: '2026-10-01T00:00:00Z'
  }
}

function setup(
  playlistResponse: { status: number; json?: PlaylistResponse | null; isApiMessage?: boolean },
  requestContent: (url: URL) => Promise<{ statusCode: number; body: Readable }>,
  isOnline = true
): {
  db: FakeDatabase
  logs: { playlist_version_hash: string; status: string; bytes_downloaded: number }[]
  api: ApiClient
  device: DeviceService
  cache: CacheManager
  cacheDir: string
  service: SyncService
} {
  const db = new FakeDatabase()
  const logs: { playlist_version_hash: string; status: string; bytes_downloaded: number }[] = []
  const api = {
    playlist: vi.fn(async () => ({
      status: playlistResponse.status,
      json: playlistResponse.json ?? null,
      isApiMessage: playlistResponse.isApiMessage ?? false,
      message: null
    })),
    postSyncLog: vi.fn(async (_deviceCode, _token, body) => {
      logs.push(body)
      return { status: 201, json: null, isApiMessage: false, message: null }
    })
  } as unknown as ApiClient
  const device = {
    validateRegistration: vi.fn(async () => ({ kind: 'registered' as const })),
    forgetRegistration: vi.fn()
  } as unknown as DeviceService
  const credentials = {
    isRegistered: () => true,
    getOrCreateDeviceCode: () => 'device-1',
    load: () => ({ apiToken: 'token' })
  } as unknown as CredentialStore
  const diagnostics = { log: vi.fn() } as unknown as Diagnostics
  const cacheDir = makeTempDir()
  const cache = new CacheManager(cacheDir, config, (url) => requestContent(url))
  const service = new SyncService(
    db as unknown as Db,
    api,
    device,
    credentials,
    cache,
    diagnostics,
    { isOnline: () => isOnline }
  )
  return { db, logs, api, device, cache, cacheDir, service }
}

describe('SyncService mirror sync', () => {
  it('activates a partial snapshot and removes content no longer referenced', async () => {
    const payload = response([
      dto(1, 'https://cdn.example.test/ready.mp4'),
      dto(2, 'https://cdn.example.test/failed.mp4')
    ])
    const context = setup({ status: 200, json: payload }, async (url) =>
      url.pathname.endsWith('failed.mp4')
        ? { statusCode: 500, body: Readable.from([]) }
        : { statusCode: 200, body: Readable.from([Buffer.from('ready')]) }
    )
    context.db.seedActive('old-version')
    const staleFile = `${context.cacheDir}/content_9_${'a'.repeat(20)}.mp4`
    writeFileSync(staleFile, 'old')

    const result = await context.service.syncOnce()

    expect(result).toBe('applied')
    expect(context.db.playlists).toHaveLength(1)
    expect(context.db.playlists[0]).toMatchObject({ version_hash: 'new-version', is_active: 1 })
    expect(context.db.items.map((item) => item.download_status)).toEqual(['READY', 'FAILED'])
    expect(context.logs).toEqual([
      { playlist_version_hash: 'new-version', status: 'partial', bytes_downloaded: 5 }
    ])
    expect(existsSync(staleFile)).toBe(false)
    await context.cache.close()
  })

  it('preserves the active playlist and its cache when every item download fails', async () => {
    const context = setup(
      {
        status: 200,
        json: response([dto(1, 'https://cdn.example.test/failed.mp4')])
      },
      async () => ({ statusCode: 500, body: Readable.from([]) })
    )
    context.db.seedActive('old-version')
    const oldCache = `${context.cacheDir}/content_old.mp4`
    writeFileSync(oldCache, 'old content')

    const result = await context.service.syncOnce()

    expect(result).toBe('download-failed')
    expect(context.db.playlists).toEqual([
      expect.objectContaining({ version_hash: 'old-version', is_active: 1 })
    ])
    expect(context.db.items).toEqual([])
    expect(context.logs).toEqual([
      { playlist_version_hash: 'new-version', status: 'failed', bytes_downloaded: 0 }
    ])
    expect(existsSync(oldCache)).toBe(true)
    await context.cache.close()
  })

  it('does not erase the playlist on an empty-snapshot 404 response', async () => {
    const context = setup({ status: 404, isApiMessage: true }, async () => ({
      statusCode: 200,
      body: Readable.from([])
    }))
    context.db.seedActive('old-version')
    const oldCache = `${context.cacheDir}/old.mp4`
    mkdirSync(context.cacheDir, { recursive: true })
    writeFileSync(oldCache, 'old content')

    const result = await context.service.syncOnce()

    expect(result).toBe('no-playlist')
    expect(context.db.playlists[0]).toMatchObject({ version_hash: 'old-version', is_active: 1 })
    expect(existsSync(oldCache)).toBe(true)
    await context.cache.close()
  })

  it('skips registration validation and playlist requests while offline', async () => {
    const context = setup(
      { status: 200, json: response([dto(1, 'https://cdn.example.test/video.mp4')]) },
      async () => ({ statusCode: 200, body: Readable.from([Buffer.from('content')]) }),
      false
    )

    const result = await context.service.syncOnce()

    expect(result).toBe('offline')
    expect(context.device.validateRegistration).not.toHaveBeenCalled()
    expect(context.api.playlist).not.toHaveBeenCalled()
    await context.cache.close()
  })

  it('does not resurrect the playlist or cache when the device is released mid-sync', async () => {
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const context = setup(
      { status: 200, json: response([dto(1, 'https://cdn.example.test/a.mp4')]) },
      async () => {
        markStarted()
        await gate
        return { statusCode: 200, body: Readable.from([Buffer.from('bytes')]) }
      }
    )

    const pending = context.service.syncOnce()
    await started
    context.service.clearLocalData() // pengguna melepas device saat unduhan masih berjalan
    openGate()
    const result = await pending

    expect(result).toBe('aborted')
    expect(context.db.playlists).toEqual([])
    expect(context.db.items).toEqual([])
    expect(readdirSync(context.cacheDir)).toEqual([])
    expect(context.logs).toEqual([]) // tidak ada sync-log untuk sync yang dibatalkan
    await context.cache.close()
  })
})
