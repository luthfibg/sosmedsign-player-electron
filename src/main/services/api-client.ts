import { Agent, request } from 'undici'
import type { AppConfig } from '../config'
import type {
  ActivateResponse,
  PlaybackLogEntryDto,
  PlaylistResponse,
  RegistrationStatusResponse,
  SyncLogRequest
} from './api-types'

/** Dilempar kalau request gagal SEBELUM ada respons HTTP (DNS, timeout, koneksi putus, dst). */
export class ApiNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ApiNetworkError'
    this.cause = cause
  }
}

export interface HttpResult<T> {
  status: number
  /** Body yang berhasil di-parse sebagai JSON object, selain itu null. */
  json: T | null
  /**
   * true hanya kalau body adalah JSON object dengan field `message` string (format error API Laravel kita).
   * Respons HTML (captive portal, proxy, halaman error nginx) TIDAK dipercaya walau status-nya 401/403/404.
   */
  isApiMessage: boolean
  /** Isi `message` kalau isApiMessage. */
  message: string | null
}

export class ApiClient {
  private readonly agent: Agent

  constructor(private readonly config: AppConfig) {
    this.agent = new Agent({ connect: { timeout: config.connectTimeoutMs } })
  }

  activate(activationCode: string, deviceCode: string): Promise<HttpResult<ActivateResponse>> {
    return this.send('POST', 'api/devices/activate', null, {
      activation_code: activationCode,
      device_code: deviceCode
    })
  }

  registrationStatus(deviceCode: string): Promise<HttpResult<RegistrationStatusResponse>> {
    return this.send('GET', `api/devices/${enc(deviceCode)}/registration-status`, null)
  }

  /** 200 = playlist baru, 204 = tidak berubah (json null), 404 = belum ada snapshot. */
  playlist(
    deviceCode: string,
    token: string,
    currentVersion: string | null
  ): Promise<HttpResult<PlaylistResponse>> {
    const query = currentVersion ? `?current_version=${encodeURIComponent(currentVersion)}` : ''
    return this.send('GET', `api/devices/${enc(deviceCode)}/playlist${query}`, token)
  }

  postSyncLog(
    deviceCode: string,
    token: string,
    body: SyncLogRequest
  ): Promise<HttpResult<unknown>> {
    return this.send('POST', `api/devices/${enc(deviceCode)}/sync-log`, token, body)
  }

  /** Maksimum 500 entri per request (validasi backend). */
  postPlaybackLogs(
    deviceCode: string,
    token: string,
    logs: PlaybackLogEntryDto[]
  ): Promise<HttpResult<{ inserted: number }>> {
    return this.send('POST', `api/devices/${enc(deviceCode)}/playback-logs`, token, { logs })
  }

  release(deviceCode: string, token: string): Promise<HttpResult<unknown>> {
    return this.send('DELETE', `api/devices/${enc(deviceCode)}/release`, token)
  }

  async close(): Promise<void> {
    await this.agent.close()
  }

  // ---- internal ----

  private async send<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string | null,
    body?: unknown
  ): Promise<HttpResult<T>> {
    const url = new URL(path, this.config.baseUrl)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.config.hostHeader) headers.host = this.config.hostHeader
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'

    try {
      const res = await request(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        dispatcher: this.agent,
        headersTimeout: this.config.requestTimeoutMs,
        bodyTimeout: this.config.requestTimeoutMs
      })
      const text = await res.body.text()
      return { status: res.statusCode, ...parseBody<T>(text) }
    } catch (error) {
      throw new ApiNetworkError(describeNetworkError(error), error)
    }
  }
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

function parseBody<T>(text: string): Omit<HttpResult<T>, 'status'> {
  if (text.trim().length === 0) return { json: null, isApiMessage: false, message: null }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { json: null, isApiMessage: false, message: null }
    }
    const message = (parsed as { message?: unknown }).message
    const isApiMessage = typeof message === 'string'
    return { json: parsed as T, isApiMessage, message: isApiMessage ? message : null }
  } catch {
    return { json: null, isApiMessage: false, message: null }
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code
    return code ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}
