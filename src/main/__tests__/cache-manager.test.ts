import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { Readable } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../config'
import type { PlaylistItemDto } from '../services/api-types'
import { CacheManager } from '../services/cache-manager'
import { makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

const config: AppConfig = {
  baseUrl: 'https://cms.example.test/',
  hostHeader: null,
  connectTimeoutMs: 20_000,
  requestTimeoutMs: 30_000
}

function item(overrides: Partial<PlaylistItemDto> = {}): PlaylistItemDto {
  return {
    slot_number: 1,
    content_id: 17,
    content_label: 'Test video',
    content_url: 'https://cdn.example.test/media/video.mp4',
    media_type: 'video',
    duration_seconds: 15,
    ...overrides
  }
}

function checksum(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

describe('CacheManager', () => {
  it('verifies file size and SHA-256, then serves a valid cache hit without downloading', async () => {
    const data = Buffer.from('video bytes')
    const requester = vi.fn(async () => ({ statusCode: 200, body: Readable.from([data]) }))
    const cache = new CacheManager(makeTempDir(), config, requester)
    const media = item({ file_size: data.length, checksum_sha256: checksum(data) })

    const downloaded = await cache.download(media)
    const cached = await cache.download(media)

    expect(downloaded.ok).toBe(true)
    expect(downloaded.bytesDownloaded).toBe(data.length)
    expect(readFileSync(downloaded.path!, 'utf8')).toBe('video bytes')
    expect(cached).toMatchObject({ ok: true, path: downloaded.path, bytesDownloaded: 0 })
    expect(requester).toHaveBeenCalledTimes(1)
    await cache.close()
  })

  it('retries and leaves no temporary file when the checksum never matches', async () => {
    const payload = Buffer.from('incorrect')
    const requester = vi.fn(async () => ({
      statusCode: 200,
      body: Readable.from([payload])
    }))
    const cacheDir = makeTempDir()
    const cache = new CacheManager(cacheDir, config, requester)

    const result = await cache.download(item({ checksum_sha256: 'a'.repeat(64) }))

    expect(result).toMatchObject({
      ok: false,
      path: null,
      released: false,
      bytesDownloaded: payload.length * 3
    })
    expect(requester).toHaveBeenCalledTimes(3)
    expect(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    await cache.close()
  })

  it('does not reuse the same cache entry after the URL version changes', async () => {
    const data = Buffer.from('same size')
    const requester = vi.fn(async () => ({ statusCode: 200, body: Readable.from([data]) }))
    const cache = new CacheManager(makeTempDir(), config, requester)

    const first = await cache.download(item({ file_size: data.length }))
    const second = await cache.download(
      item({ content_url: 'https://cdn.example.test/media/replaced.mp4', file_size: data.length })
    )

    expect(first.path).not.toBe(second.path)
    expect(requester).toHaveBeenCalledTimes(2)
    await cache.close()
  })

  it('replaces a corrupt same-version cache file after verifying the new download', async () => {
    const data = Buffer.from('verified bytes')
    const requester = vi.fn(async () => ({ statusCode: 200, body: Readable.from([data]) }))
    const cache = new CacheManager(makeTempDir(), config, requester)
    const media = item({ file_size: data.length, checksum_sha256: checksum(data) })
    const first = await cache.download(media)
    writeFileSync(first.path!, 'corrupt')

    const repaired = await cache.download(media)

    expect(repaired.ok).toBe(true)
    expect(readFileSync(repaired.path!, 'utf8')).toBe('verified bytes')
    expect(requester).toHaveBeenCalledTimes(2)
    await cache.close()
  })

  it('preserves referenced files and temporary files during unused-cache cleanup', async () => {
    const data = Buffer.from('video bytes')
    const cacheDir = makeTempDir()
    const cache = new CacheManager(cacheDir, config, async () => ({
      statusCode: 200,
      body: Readable.from([data])
    }))
    const downloaded = await cache.download(item())
    const stale = `${cacheDir}/content_99_${'c'.repeat(20)}.mp4`
    const temporary = `${cacheDir}/unfinished.tmp`
    writeFileSync(stale, 'stale')
    writeFileSync(temporary, 'partial')

    cache.cleanupUnused([downloaded.path!])

    expect(existsSync(downloaded.path!)).toBe(true)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(temporary)).toBe(true)
    await cache.close()
  })

  it('returns an authorization failure immediately without retrying', async () => {
    const requester = vi.fn(async () => ({
      statusCode: 403,
      body: Readable.from([Buffer.from('{"message":"unauthorized"}')])
    }))
    const cache = new CacheManager(makeTempDir(), config, requester)

    const result = await cache.download(item())

    expect(result).toMatchObject({ ok: false, released: true, error: 'HTTP 403' })
    expect(requester).toHaveBeenCalledTimes(1)
    await cache.close()
  })

  it('does not treat an HTML 403 response as a device release', async () => {
    const requester = vi.fn(async () => ({
      statusCode: 403,
      body: Readable.from([Buffer.from('<html>blocked by proxy</html>')])
    }))
    const cache = new CacheManager(makeTempDir(), config, requester)

    const result = await cache.download(item())

    expect(result).toMatchObject({ ok: false, released: false, error: 'HTTP 403' })
    expect(requester).toHaveBeenCalledTimes(3)
    await cache.close()
  })

  it('rewrites local media URLs in dev and avoids overriding CDN Host headers', async () => {
    const calls: { url: URL; headers: Record<string, string> }[] = []
    const requester = vi.fn(async (url: URL, headers: Record<string, string>) => {
      calls.push({ url, headers })
      return { statusCode: 200, body: Readable.from([Buffer.from('content')]) }
    })
    const devConfig = { ...config, baseUrl: 'http://127.0.0.1:8000/', hostHeader: 'cms.test' }
    const cache = new CacheManager(makeTempDir(), devConfig, requester)

    await cache.download(item({ content_url: 'http://localhost/storage/local.mp4' }))
    await cache.download(item({ content_url: 'https://cdn.example.test/content.mp4' }))

    expect(calls[0].url.origin).toBe('http://127.0.0.1:8000')
    expect(calls[0].headers.host).toBe('cms.test')
    expect(calls[1].url.origin).toBe('https://cdn.example.test')
    expect(calls[1].headers).not.toHaveProperty('host')
    await cache.close()
  })
})

describe('CacheManager review fixes', () => {
  it('keeps the cache entry when the backend starts sending checksum and file_size for the same URL', async () => {
    const data = Buffer.from('video bytes')
    const requester = vi.fn(async () => ({ statusCode: 200, body: Readable.from([data]) }))
    const cache = new CacheManager(makeTempDir(), config, requester)

    const legacy = await cache.download(item()) // playlist lama: tanpa checksum dan file_size
    const upgraded = await cache.download(
      item({ file_size: data.length, checksum_sha256: checksum(data) })
    )

    expect(upgraded).toMatchObject({ ok: true, path: legacy.path, bytesDownloaded: 0 })
    expect(requester).toHaveBeenCalledTimes(1)
    await cache.close()
  })

  it('removes interrupted downloads (.tmp) left behind by a crash when the cache starts', async () => {
    const dir = makeTempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/content_17_${'a'.repeat(20)}.mp4.1234.tmp`, 'setengah')
    const cache = new CacheManager(dir, config)
    expect(readdirSync(dir)).toEqual([])
    await cache.close()
  })

  it('only deletes files it created, never foreign files in the cache folder', async () => {
    const dir = makeTempDir()
    const ours = `content_17_${'b'.repeat(20)}.mp4`
    writeFileSync(`${dir}/notes.txt`, 'milik pengguna')
    writeFileSync(`${dir}/${ours}`, 'cache')
    const cache = new CacheManager(dir, config)

    cache.cleanupUnused([])
    expect(readdirSync(dir)).toEqual(['notes.txt'])

    writeFileSync(`${dir}/${ours}`, 'cache lagi')
    cache.clear()
    expect(readdirSync(dir)).toEqual(['notes.txt'])
    await cache.close()
  })
})
