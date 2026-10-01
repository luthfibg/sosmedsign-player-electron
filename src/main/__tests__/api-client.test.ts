import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import { ApiClient, ApiNetworkError } from '../services/api-client'

interface Seen {
  method?: string
  url?: string
  headers: IncomingMessage['headers']
  body: string
}

let server: Server
let baseUrl = ''
let last: Seen
let handler: (req: IncomingMessage, res: ServerResponse) => void

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      last = { method: req.method, url: req.url, headers: req.headers, body }
      handler(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const client = (hostHeader?: string): ApiClient =>
  new ApiClient(createConfig({ baseUrl, hostHeader }))

describe('ApiClient', () => {
  it('activate: kirim JSON body yang benar dan parse respons 200', async () => {
    handler = (_req, res) =>
      json(res, 200, { api_token: 'tok', venue_id: 3, registration_status: 'registered' })
    const r = await client().activate('ABCD2345', 'dev-uuid')
    expect(r.status).toBe(200)
    expect(r.json?.api_token).toBe('tok')
    expect(last.method).toBe('POST')
    expect(last.url).toBe('/api/devices/activate')
    expect(JSON.parse(last.body)).toEqual({ activation_code: 'ABCD2345', device_code: 'dev-uuid' })
    expect(last.headers['content-type']).toBe('application/json')
    expect(last.headers.authorization).toBeUndefined()
  })

  it('mengganti header Host kalau dikonfigurasi (Herd virtual host)', async () => {
    handler = (_req, res) => json(res, 200, { registration_status: 'registered' })
    await client('sosmedsign.test').registrationStatus('dev-uuid')
    expect(last.headers.host).toBe('sosmedsign.test')
  })

  it('tanpa host header: Host mengikuti URL', async () => {
    handler = (_req, res) => json(res, 200, { registration_status: 'registered' })
    await client().registrationStatus('dev-uuid')
    expect(last.headers.host).toBe(new URL(baseUrl).host)
  })

  it('playlist: Bearer token, current_version ter-encode, 204 tanpa body', async () => {
    handler = (_req, res) => {
      res.writeHead(204)
      res.end()
    }
    const r = await client().playlist('dev uuid', 'tok', 'abc/123+=')
    expect(r.status).toBe(204)
    expect(r.json).toBeNull()
    expect(last.url).toBe('/api/devices/dev%20uuid/playlist?current_version=abc%2F123%2B%3D')
    expect(last.headers.authorization).toBe('Bearer tok')
  })

  it('playlist tanpa versi: tidak ada query string', async () => {
    handler = (_req, res) => json(res, 200, { playlist: [] })
    await client().playlist('dev', 'tok', null)
    expect(last.url).toBe('/api/devices/dev/playlist')
  })

  it('error JSON API (422 dengan message) dikenali sebagai pesan API', async () => {
    handler = (_req, res) => json(res, 422, { message: 'Kode aktivasi sudah kadaluarsa.' })
    const r = await client().activate('ABCD2345', 'd')
    expect(r.status).toBe(422)
    expect(r.isApiMessage).toBe(true)
    expect(r.message).toBe('Kode aktivasi sudah kadaluarsa.')
  })

  it('401 berbentuk HTML (captive portal/proxy) TIDAK dianggap pesan API', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'text/html' })
      res.end('<html><body>Login WiFi dulu</body></html>')
    }
    const r = await client().playlist('d', 't', null)
    expect(r.status).toBe(401)
    expect(r.isApiMessage).toBe(false)
    expect(r.json).toBeNull()
  })

  it('JSON tanpa field message string bukan pesan API', async () => {
    handler = (_req, res) => json(res, 404, { error: 'x' })
    const r = await client().registrationStatus('d')
    expect(r.isApiMessage).toBe(false)
  })

  it('body JSON array / primitif ditolak sebagai json', async () => {
    handler = (_req, res) => json(res, 200, [1, 2, 3])
    const r = await client().registrationStatus('d')
    expect(r.json).toBeNull()
  })

  it('postPlaybackLogs membungkus entri dalam { logs }', async () => {
    handler = (_req, res) => json(res, 200, { inserted: 1 })
    const entry = {
      content_id: 1,
      content_label: 'x',
      played_at: '2026-09-30T00:00:00Z',
      duration_seconds: 15,
      was_offline: false
    }
    const r = await client().postPlaybackLogs('d', 't', [entry])
    expect(JSON.parse(last.body)).toEqual({ logs: [entry] })
    expect(r.json?.inserted).toBe(1)
  })

  it('release memakai DELETE', async () => {
    handler = (_req, res) => json(res, 200, { registration_status: 'pending' })
    await client().release('d', 't')
    expect(last.method).toBe('DELETE')
    expect(last.url).toBe('/api/devices/d/release')
  })

  it('koneksi gagal dilempar sebagai ApiNetworkError', async () => {
    const dead = new ApiClient(createConfig({ baseUrl: 'http://127.0.0.1:1' }))
    await expect(dead.registrationStatus('d')).rejects.toBeInstanceOf(ApiNetworkError)
  })
})
