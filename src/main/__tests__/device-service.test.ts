import { describe, expect, it, vi } from 'vitest'
import { ApiNetworkError, type ApiClient, type HttpResult } from '../services/api-client'
import { CredentialStore } from '../services/credential-store'
import {
  DeviceService,
  normalizeActivationCode,
  type RegistrationValidation
} from '../services/device-service'
import { Diagnostics } from '../services/diagnostics'
import { fakeCipher, makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

function res<T>(
  status: number,
  json: unknown = null,
  message: string | null = null
): HttpResult<T> {
  return { status, json: json as T | null, isApiMessage: message !== null, message }
}

function setup(api: Partial<ApiClient>): {
  service: DeviceService
  credentials: CredentialStore
  diagnostics: Diagnostics
} {
  const dir = makeTempDir()
  const credentials = new CredentialStore(dir, fakeCipher(), () => 'device-uuid-1')
  const diagnostics = new Diagnostics(null)
  const service = new DeviceService(api as ApiClient, credentials, diagnostics)
  return { service, credentials, diagnostics }
}

describe('normalizeActivationCode', () => {
  it('trim + uppercase', () => expect(normalizeActivationCode('  ab2c  ')).toBe('AB2C'))
})

describe('DeviceService.activate', () => {
  it('menolak format salah tanpa memanggil server', async () => {
    const activate = vi.fn()
    const { service } = setup({ activate })
    for (const bad of ['', 'ABC', 'ABCDEFGHI', 'ABCD-234']) {
      const r = await service.activate(bad)
      expect(r).toMatchObject({ ok: false, reason: 'invalid-format' })
    }
    expect(activate).not.toHaveBeenCalled()
  })

  it('sukses: simpan kredensial, pancarkan state, kode dinormalkan & token tidak masuk log', async () => {
    const activate = vi.fn().mockResolvedValue(
      res(200, {
        api_token: 'TOKEN-XYZ',
        venue_id: 5,
        name: 'Lobby',
        slot_capacity: 10,
        slot_duration_seconds: 20
      })
    )
    const { service, credentials, diagnostics } = setup({ activate })
    const states: DeviceStateDto[] = []
    service.onStateChange((s) => states.push(s))

    const r = await service.activate(' abcd2345 ')
    expect(r).toEqual({ ok: true })
    expect(activate).toHaveBeenCalledWith('ABCD2345', 'device-uuid-1')
    expect(credentials.load()).toEqual({
      apiToken: 'TOKEN-XYZ',
      venueId: 5,
      name: 'Lobby',
      slotCapacity: 10,
      slotDurationSeconds: 20
    })
    expect(states).toEqual([
      { registered: true, deviceCode: 'device-uuid-1', venueId: 5, deviceName: 'Lobby' }
    ])
    const log = diagnostics.snapshot().join('\n')
    expect(log).not.toContain('TOKEN-XYZ')
    expect(log).not.toContain('ABCD2345')
  })

  it('422 dengan pesan API: tampilkan pesan server, tidak terdaftar', async () => {
    const activate = vi
      .fn()
      .mockResolvedValue(
        res(
          422,
          { message: 'Kode aktivasi sudah pernah dipakai.' },
          'Kode aktivasi sudah pernah dipakai.'
        )
      )
    const { service, credentials } = setup({ activate })
    const r = await service.activate('ABCD2345')
    expect(r).toEqual({
      ok: false,
      reason: 'rejected',
      message: 'Kode aktivasi sudah pernah dipakai.'
    })
    expect(credentials.isRegistered()).toBe(false)
  })

  it('jaringan gagal: pesan ramah, tidak terdaftar', async () => {
    const activate = vi.fn().mockRejectedValue(new ApiNetworkError('ECONNREFUSED'))
    const { service, credentials } = setup({ activate })
    const r = await service.activate('ABCD2345')
    expect(r).toMatchObject({ ok: false, reason: 'network' })
    expect(credentials.isRegistered()).toBe(false)
  })

  it('200 tanpa api_token ditolak', async () => {
    const activate = vi.fn().mockResolvedValue(res(200, { venue_id: 1 }))
    const { service, credentials } = setup({ activate })
    expect(await service.activate('ABCD2345')).toMatchObject({ ok: false, reason: 'server' })
    expect(credentials.isRegistered()).toBe(false)
  })

  it('status tak terduga (502 HTML) dilaporkan sebagai error server', async () => {
    const activate = vi.fn().mockResolvedValue(res(502))
    const { service } = setup({ activate })
    const r = await service.activate('ABCD2345')
    expect(r).toMatchObject({ ok: false, reason: 'server' })
  })
})

describe('DeviceService.validateRegistration (masa tenggang offline)', () => {
  const run = async (result: HttpResult<unknown> | Error): Promise<RegistrationValidation> => {
    const registrationStatus = vi.fn()
    if (result instanceof Error) registrationStatus.mockRejectedValue(result)
    else registrationStatus.mockResolvedValue(result)
    return setup({ registrationStatus }).service.validateRegistration()
  }

  it('registered', async () => {
    expect(await run(res(200, { registration_status: 'registered' }))).toEqual({
      kind: 'registered'
    })
  })
  it('pending (status di body)', async () => {
    expect(await run(res(200, { registration_status: 'pending' }))).toEqual({ kind: 'pending' })
  })
  it('404 JSON milik API = pending', async () => {
    expect(
      await run(res(404, { message: 'Device tidak ditemukan' }, 'Device tidak ditemukan'))
    ).toEqual({ kind: 'pending' })
  })
  it('404 HTML (bukan API kita) = unavailable, BUKAN dilepas', async () => {
    expect(await run(res(404))).toMatchObject({ kind: 'unavailable' })
  })
  it('401/403 = unavailable', async () => {
    expect(await run(res(401))).toMatchObject({ kind: 'unavailable' })
    expect(await run(res(403, { message: 'x' }, 'x'))).toMatchObject({ kind: 'unavailable' })
  })
  it('error jaringan = unavailable', async () => {
    expect(await run(new ApiNetworkError('timeout'))).toMatchObject({ kind: 'unavailable' })
  })
})

describe('DeviceService.release', () => {
  async function registered(api: Partial<ApiClient>): Promise<ReturnType<typeof setup>> {
    const ctx = setup({
      activate: vi.fn().mockResolvedValue(
        res(200, {
          api_token: 'T',
          venue_id: 1,
          name: 'N',
          slot_capacity: 20,
          slot_duration_seconds: 15
        })
      ),
      ...api
    })
    await ctx.service.activate('ABCD2345')
    return ctx
  }

  it('tanpa kredensial: langsung sukses', async () => {
    const release = vi.fn()
    const { service } = setup({ release })
    expect(await service.release()).toEqual({ ok: true })
    expect(release).not.toHaveBeenCalled()
  })

  it.each([200, 401, 403, 404])(
    'HTTP %i dianggap sukses (idempoten); device_code dipertahankan',
    async (status) => {
      const { service, credentials } = await registered({
        release: vi.fn().mockResolvedValue(res(status))
      })
      expect(await service.release()).toEqual({ ok: true })
      expect(credentials.isRegistered()).toBe(false)
      expect(credentials.getOrCreateDeviceCode()).toBe('device-uuid-1')
    }
  )

  it('jaringan gagal: kredensial TIDAK dihapus', async () => {
    const { service, credentials } = await registered({
      release: vi.fn().mockRejectedValue(new ApiNetworkError('ECONNRESET'))
    })
    expect(await service.release()).toMatchObject({ ok: false })
    expect(credentials.isRegistered()).toBe(true)
  })

  it('422 (masih punya booking aktif): tampilkan pesan server, kredensial utuh', async () => {
    const { service, credentials } = await registered({
      release: vi
        .fn()
        .mockResolvedValue(
          res(
            422,
            { message: 'Device masih punya booking aktif.' },
            'Device masih punya booking aktif.'
          )
        )
    })
    expect(await service.release()).toEqual({
      ok: false,
      message: 'Device masih punya booking aktif.'
    })
    expect(credentials.isRegistered()).toBe(true)
  })
})

describe('DeviceService.resetIdentity', () => {
  it('menghapus registrasi, membersihkan log, memancarkan state', async () => {
    const { service, credentials, diagnostics } = setup({
      activate: vi.fn().mockResolvedValue(
        res(200, {
          api_token: 'T',
          venue_id: 1,
          name: 'N',
          slot_capacity: 20,
          slot_duration_seconds: 15
        })
      )
    })
    await service.activate('ABCD2345')
    const states: DeviceStateDto[] = []
    service.onStateChange((s) => states.push(s))
    service.resetIdentity()
    expect(credentials.isRegistered()).toBe(false)
    expect(states.at(-1)?.registered).toBe(false)
    expect(diagnostics.snapshot()).toHaveLength(1) // hanya baris "Identitas device direset"
  })
})

describe('DeviceService.onRegistrationCleared', () => {
  async function registered(
    api: Partial<ApiClient>
  ): Promise<ReturnType<typeof setup> & { reasons: string[] }> {
    const ctx = setup({
      activate: vi.fn().mockResolvedValue(
        res(200, {
          api_token: 'T',
          venue_id: 1,
          name: 'N',
          slot_capacity: 20,
          slot_duration_seconds: 15
        })
      ),
      ...api
    })
    await ctx.service.activate('ABCD2345')
    const reasons: string[] = []
    ctx.service.onRegistrationCleared((reason) => reasons.push(reason))
    return { ...ctx, reasons }
  }

  it('reports "released" after a confirmed release', async () => {
    const ctx = await registered({ release: vi.fn().mockResolvedValue(res(200)) })
    await ctx.service.release()
    expect(ctx.reasons).toEqual(['released'])
  })

  it('reports "identity-reset" on identity reset', async () => {
    const ctx = await registered({})
    ctx.service.resetIdentity()
    expect(ctx.reasons).toEqual(['identity-reset'])
  })

  it('reports the given reason when the sync service forgets the registration', async () => {
    const ctx = await registered({})
    ctx.service.forgetRegistration('credentials-invalid', 'token ditolak')
    expect(ctx.reasons).toEqual(['credentials-invalid'])
    expect(ctx.credentials.isRegistered()).toBe(false)
    expect(ctx.credentials.getOrCreateDeviceCode()).toBe('device-uuid-1')
  })
})
