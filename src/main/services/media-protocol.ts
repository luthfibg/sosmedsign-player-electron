import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'

/**
 * Protokol khusus untuk memutar file cache di renderer: sosmedsign-media://media/<nama-file>.
 * Renderer tidak pernah tahu path disk, dan hanya nama file cache yang valid (lihat CacheManager.resolveCachedFile)
 * yang bisa dilayani. Dukungan Range wajib agar <video> bisa membaca metadata dan seek.
 */
export const MEDIA_SCHEME = 'sosmedsign-media'
const MEDIA_HOST = 'media'

const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
}

export function mediaUrlFor(fileName: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(fileName)}`
}

/** Mengambil nama file dari URL media; null kalau bukan URL media atau mengandung pemisah path. */
export function fileNameFromMediaUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== MEDIA_HOST) return null
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (name.length === 0 || /[/\\]/.test(name) || name.includes('\0')) return null
    return name
  } catch {
    return null
  }
}

export function mimeTypeFor(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

export type ByteRange = { start: number; end: number }

/** null = tanpa Range; 'invalid' = tidak dapat dipenuhi (416). Hanya satu rentang yang didukung. */
export function parseRange(header: string | null, size: number): ByteRange | 'invalid' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'

  if (rawStart === '') {
    // bytes=-N: N byte terakhir
    const suffix = Number(rawEnd)
    if (suffix <= 0 || size === 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

export async function serveMediaRequest(
  request: Request,
  resolveFile: (fileName: string) => string | null
): Promise<Response> {
  const notFound = (): Response => new Response('Not found', { status: 404 })

  const name = fileNameFromMediaUrl(request.url)
  if (!name) return notFound()
  const file = resolveFile(name)
  if (!file) return notFound()

  let size: number
  try {
    size = (await stat(file)).size
  } catch {
    return notFound()
  }

  const headers: Record<string, string> = {
    'Content-Type': mimeTypeFor(name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  }

  const range = parseRange(request.headers.get('range'), size)
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` }
    })
  }

  const status = range ? 206 : 200
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

  if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers })

  const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as BodyInit
  return new Response(body, { status, headers })
}
