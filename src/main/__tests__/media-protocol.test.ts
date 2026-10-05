import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  fileNameFromMediaUrl,
  mediaUrlFor,
  mimeTypeFor,
  parseRange,
  serveMediaRequest
} from '../services/media-protocol'
import { makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

const NAME = `content_1_${'a'.repeat(20)}.mp4`
const CONTENT = '0123456789abcdefghij' // 20 byte

function setup(): (name: string) => string | null {
  const dir = makeTempDir()
  writeFileSync(join(dir, NAME), CONTENT)
  return (name) => (name === NAME ? join(dir, NAME) : null)
}

const get = (url: string, headers: Record<string, string> = {}, method = 'GET'): Request =>
  new Request(url, { headers, method })

describe('media URL helpers', () => {
  it('round-trips a file name through the media URL', () => {
    expect(fileNameFromMediaUrl(mediaUrlFor(NAME))).toBe(NAME)
  })

  it('rejects other schemes, hosts, empty names, and path separators', () => {
    expect(fileNameFromMediaUrl('https://media/x.mp4')).toBeNull()
    expect(fileNameFromMediaUrl('sosmedsign-media://lain/x.mp4')).toBeNull()
    expect(fileNameFromMediaUrl('sosmedsign-media://media/')).toBeNull()
    expect(fileNameFromMediaUrl('sosmedsign-media://media/..%2Fsecret.txt')).toBeNull()
    expect(fileNameFromMediaUrl('sosmedsign-media://media/a%5Cb.mp4')).toBeNull()
    expect(fileNameFromMediaUrl('bukan url')).toBeNull()
  })

  it('maps extensions to MIME types', () => {
    expect(mimeTypeFor('a.MP4')).toBe('video/mp4')
    expect(mimeTypeFor('a.webm')).toBe('video/webm')
    expect(mimeTypeFor('a.jpg')).toBe('image/jpeg')
    expect(mimeTypeFor('a.xyz')).toBe('application/octet-stream')
  })
})

describe('parseRange', () => {
  it('parses open, closed, suffix, and clamped ranges', () => {
    expect(parseRange(null, 20)).toBeNull()
    expect(parseRange('bytes=2-5', 20)).toEqual({ start: 2, end: 5 })
    expect(parseRange('bytes=10-', 20)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=-4', 20)).toEqual({ start: 16, end: 19 })
    expect(parseRange('bytes=-100', 20)).toEqual({ start: 0, end: 19 })
    expect(parseRange('bytes=15-999', 20)).toEqual({ start: 15, end: 19 })
  })

  it('flags unsatisfiable or malformed ranges', () => {
    expect(parseRange('bytes=20-30', 20)).toBe('invalid')
    expect(parseRange('bytes=5-2', 20)).toBe('invalid')
    expect(parseRange('bytes=-', 20)).toBe('invalid')
    expect(parseRange('bytes=0-1,5-6', 20)).toBe('invalid')
    expect(parseRange('items=0-1', 20)).toBe('invalid')
    expect(parseRange('bytes=-0', 20)).toBe('invalid')
  })
})

describe('serveMediaRequest', () => {
  it('serves the whole file with 200 and advertises range support', async () => {
    const res = await serveMediaRequest(get(mediaUrlFor(NAME)), setup())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('20')
    expect(await res.text()).toBe(CONTENT)
  })

  it('serves partial content with 206 and a correct Content-Range', async () => {
    const res = await serveMediaRequest(get(mediaUrlFor(NAME), { Range: 'bytes=2-5' }), setup())
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/20')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('2345')
  })

  it('serves open-ended and suffix ranges', async () => {
    const resolve = setup()
    const open = await serveMediaRequest(get(mediaUrlFor(NAME), { Range: 'bytes=15-' }), resolve)
    expect(await open.text()).toBe('fghij')
    const suffix = await serveMediaRequest(get(mediaUrlFor(NAME), { Range: 'bytes=-3' }), resolve)
    expect(await suffix.text()).toBe('hij')
  })

  it('answers 416 for unsatisfiable ranges', async () => {
    const res = await serveMediaRequest(get(mediaUrlFor(NAME), { Range: 'bytes=50-60' }), setup())
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */20')
  })

  it('answers HEAD without a body', async () => {
    const res = await serveMediaRequest(get(mediaUrlFor(NAME), {}, 'HEAD'), setup())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('20')
    expect(await res.text()).toBe('')
  })

  it('answers 404 for unknown files and refuses path traversal', async () => {
    const resolve = setup()
    expect((await serveMediaRequest(get(mediaUrlFor('content_2_x.mp4')), resolve)).status).toBe(404)
    expect(
      (await serveMediaRequest(get('sosmedsign-media://media/..%2Fsecret'), resolve)).status
    ).toBe(404)
    expect((await serveMediaRequest(get('https://media/x.mp4'), resolve)).status).toBe(404)
  })
})
