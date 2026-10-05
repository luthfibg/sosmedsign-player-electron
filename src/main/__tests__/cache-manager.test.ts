import { join } from 'path'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
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

    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, longAgo, longAgo) // sudah lama tidak dipakai playlist mana pun

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

    cache.cleanupUnused([], { ignoreGrace: true })
    expect(readdirSync(dir)).toEqual(['notes.txt'])

    writeFileSync(`${dir}/${ours}`, 'cache lagi')
    cache.clear()
    expect(readdirSync(dir)).toEqual(['notes.txt'])
    await cache.close()
  })
})

describe('CacheManager orphan grace period', () => {
  const ORPHAN = `content_5_${'d'.repeat(20)}.mp4`

  function make(clock: { t: number }): { dir: string; cache: CacheManager } {
    const dir = makeTempDir()
    const cache = new CacheManager(dir, config, undefined, undefined, {
      now: () => clock.t,
      orphanGraceMs: 30 * 60_000
    })
    writeFileSync(`${dir}/${ORPHAN}`, 'data')
    const when = new Date(clock.t)
    utimesSync(`${dir}/${ORPHAN}`, when, when)
    return { dir, cache }
  }

  it('keeps recent orphans until the grace period passes', async () => {
    const clock = { t: Date.now() }
    const { dir, cache } = make(clock)

    cache.cleanupUnused([])
    expect(existsSync(`${dir}/${ORPHAN}`)).toBe(true)

    clock.t += 29 * 60_000
    cache.cleanupUnused([])
    expect(existsSync(`${dir}/${ORPHAN}`)).toBe(true)

    clock.t += 2 * 60_000
    cache.cleanupUnused([])
    expect(existsSync(`${dir}/${ORPHAN}`)).toBe(false)
    await cache.close()
  })

  it('ignoreGrace removes orphans immediately (low disk space, manual purge)', async () => {
    const { dir, cache } = make({ t: Date.now() })
    cache.cleanupUnused([], { ignoreGrace: true })
    expect(existsSync(`${dir}/${ORPHAN}`)).toBe(false)
    await cache.close()
  })

  it('touch restarts the grace period for files that were just used', async () => {
    const clock = { t: Date.now() }
    const { dir, cache } = make(clock)
    clock.t += 3 * 60 * 60_000 // 3 jam kemudian file sudah "kadaluarsa"
    cache.touch([`${dir}/${ORPHAN}`]) // ...tetapi baru saja dipakai playlist
    cache.cleanupUnused([])
    expect(existsSync(`${dir}/${ORPHAN}`)).toBe(true)
    await cache.close()
  })

  it('resolveCachedFile only resolves existing cache-pattern names (no path tricks)', async () => {
    const { dir, cache } = make({ t: Date.now() })
    expect(cache.resolveCachedFile(ORPHAN)).toBe(join(dir, ORPHAN))
    expect(cache.resolveCachedFile('../secret.txt')).toBeNull()
    expect(cache.resolveCachedFile(`content_6_${'e'.repeat(20)}.mp4`)).toBeNull()
    expect(cache.resolveCachedFile('notes.txt')).toBeNull()
    await cache.close()
  })
})

describe('CacheManager disk space and verification', () => {
  const disk = (
    free: number,
    minFreeBytes = 1_000
  ): ConstructorParameters<typeof CacheManager>[4] => ({
    minFreeBytes,
    diskSpaceFn: async () => ({ free, total: 100_000 })
  })

  it('refuses to download when the file would eat into the free-space reserve, without retrying', async () => {
    const requester = vi.fn(async () => ({
      statusCode: 200,
      body: Readable.from([Buffer.alloc(10)])
    }))
    const dir = makeTempDir()
    const cache = new CacheManager(dir, config, requester, undefined, disk(5_000))

    const result = await cache.download(item({ file_size: 4_500 })) // 5.000 - 4.500 < cadangan 1.000

    expect(result).toMatchObject({ ok: false, diskFull: true, released: false })
    expect(result.error).toMatch(/ruang disk tidak cukup/)
    expect(requester).toHaveBeenCalledTimes(1)
    expect(readdirSync(dir)).toEqual([])
    await cache.close()
  })

  it('uses Content-Length when the server did not announce file_size', async () => {
    const requester = vi.fn(async () => ({
      statusCode: 200,
      body: Readable.from([Buffer.alloc(10)]),
      headers: { 'content-length': '4500' }
    }))
    const cache = new CacheManager(makeTempDir(), config, requester, undefined, disk(5_000))
    expect(await cache.download(item())).toMatchObject({ ok: false, diskFull: true })
    await cache.close()
  })

  it('downloads normally when there is enough room', async () => {
    const requester = vi.fn(async () => ({
      statusCode: 200,
      body: Readable.from([Buffer.from('ok')])
    }))
    const cache = new CacheManager(makeTempDir(), config, requester, undefined, disk(5_000))
    expect(await cache.download(item({ file_size: 2 }))).toMatchObject({ ok: true })
    await cache.close()
  })

  it('treats a write failure with ENOSPC as disk full, cleans the temp file, and does not retry', async () => {
    const dir = makeTempDir()
    const requester = vi.fn(async () => ({
      statusCode: 200,
      body: new Readable({
        read() {
          this.destroy(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
        }
      })
    }))
    const cache = new CacheManager(dir, config, requester, undefined, disk(1_000_000, 0))

    const result = await cache.download(item())

    expect(result).toMatchObject({ ok: false, diskFull: true })
    expect(requester).toHaveBeenCalledTimes(1)
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    await cache.close()
  })

  it('hasRoomFor honors the reserve; an unmeasurable disk counts as enough', async () => {
    const cache = new CacheManager(makeTempDir(), config, undefined, undefined, disk(10_000, 3_000))
    expect(await cache.hasRoomFor(7_000)).toBe(true)
    expect(await cache.hasRoomFor(7_001)).toBe(false)
    const unknown = new CacheManager(makeTempDir(), config, undefined, undefined, {
      diskSpaceFn: async () => null
    })
    expect(await unknown.hasRoomFor(1e15)).toBe(true)
    await cache.close()
    await unknown.close()
  })

  it('verifyFile reports ok, missing, and corrupt (size or checksum)', async () => {
    const dir = makeTempDir()
    const cache = new CacheManager(dir, config)
    const data = Buffer.from('isi file')
    const path = join(dir, `content_1_${'a'.repeat(20)}.mp4`)
    writeFileSync(path, data)

    expect(await cache.verifyFile(path, { size: null, checksum: null })).toBe('ok')
    expect(await cache.verifyFile(path, { size: data.length, checksum: checksum(data) })).toBe('ok')
    expect(await cache.verifyFile(path, { size: data.length + 1, checksum: null })).toBe('corrupt')
    expect(
      await cache.verifyFile(path, { size: null, checksum: checksum(Buffer.from('lain')) })
    ).toBe('corrupt')
    expect(await cache.verifyFile(`${path}.hilang`, { size: null, checksum: null })).toBe('missing')
    writeFileSync(path, '')
    expect(await cache.verifyFile(path, { size: null, checksum: null })).toBe('corrupt')
    await cache.close()
  })

  it('verifyFile cannot judge an invalid server checksum, so it does not condemn the file', async () => {
    const dir = makeTempDir()
    const cache = new CacheManager(dir, config)
    const path = join(dir, `content_1_${'a'.repeat(20)}.mp4`)
    writeFileSync(path, 'x')
    expect(await cache.verifyFile(path, { size: null, checksum: 'bukan-hex' })).toBe('ok')
    await cache.close()
  })

  it('stats counts only cache files (not temp or foreign files) and exposes the directory', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, `content_1_${'a'.repeat(20)}.mp4`), 'aaaa')
    writeFileSync(join(dir, `content_2_${'b'.repeat(20)}.png`), 'bb')
    writeFileSync(join(dir, 'catatan.txt'), 'xxxxxxxxxx')
    writeFileSync(join(dir, `content_3_${'c'.repeat(20)}.mp4.1234.tmp`), 'cccccc')
    const cache = new CacheManager(dir, config)
    const stats = cache.stats()
    expect(stats.fileCount).toBe(2)
    expect(stats.totalBytes).toBe(6)
    expect(stats.files.map((f) => f.name).sort()).toEqual([
      `content_1_${'a'.repeat(20)}.mp4`,
      `content_2_${'b'.repeat(20)}.png`
    ])
    expect(cache.directory).toBe(dir)
    await cache.close()
  })

  it('plannedPath matches the path the download uses, and isCachedBySize checks existence and size', async () => {
    const data = Buffer.from('video')
    const requester = vi.fn(async () => ({ statusCode: 200, body: Readable.from([data]) }))
    const cache = new CacheManager(makeTempDir(), config, requester, undefined, {
      minFreeBytes: 0,
      diskSpaceFn: async () => null
    })
    const media = item({ file_size: data.length })
    expect(cache.isCachedBySize(media)).toBe(false)
    const result = await cache.download(media)
    expect(cache.plannedPath(media)).toBe(result.path)
    expect(cache.isCachedBySize(media)).toBe(true)
    expect(cache.isCachedBySize(item({ file_size: data.length + 1 }))).toBe(false)
    expect(cache.plannedPath(item({ content_url: 'http://[bad' }))).toBeNull()
    await cache.close()
  })
})
