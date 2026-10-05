import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, HttpResult } from '../services/api-client'
import { PlaybackReporter } from '../services/playback-reporter'
import { MemoryPlaybackLogStore } from './memory-playback-log-store'

function reply(status: number, apiMessage = false): HttpResult<{ inserted: number }> {
  return {
    status,
    json: apiMessage ? ({ message: 'x' } as never) : null,
    isApiMessage: apiMessage,
    message: apiMessage ? 'x' : null
  }
}

function setup(
  options: {
    online?: boolean
    batchSize?: number
    responses?: (HttpResult<{ inserted: number }> | Error)[]
  } = {}
): {
  store: MemoryPlaybackLogStore
  reporter: PlaybackReporter
  post: ReturnType<typeof vi.fn>
  logs: string[]
  online: { value: boolean }
} {
  const store = new MemoryPlaybackLogStore()
  const online = { value: options.online ?? true }
  const logs: string[] = []
  const queue = [...(options.responses ?? [])]
  const post = vi.fn(async () => {
    const next = queue.length > 0 ? queue.shift()! : reply(200)
    if (next instanceof Error) throw next
    return next
  })
  const reporter = new PlaybackReporter({
    store,
    api: { postPlaybackLogs: post } as unknown as Pick<ApiClient, 'postPlaybackLogs'>,
    isOnline: () => online.value,
    log: (m) => logs.push(m),
    batchSize: options.batchSize
  })
  return { store, reporter, post, logs, online }
}

const event = (overrides = {}): Parameters<PlaybackReporter['record']>[0] => ({
  contentId: 7,
  label: 'Promo',
  startedAt: new Date('2026-10-05T03:00:00Z'),
  playedSeconds: 15.4,
  ...overrides
})

describe('PlaybackReporter.record', () => {
  it('stores a completed play with rounded duration, UTC start time and offline flag', () => {
    const { reporter, store, online } = setup()
    expect(reporter.record(event())).toBe(true)
    online.value = false
    reporter.record(event({ playedSeconds: 14.6, label: '  Dua  ' }))

    expect(store.rows).toMatchObject([
      {
        contentId: 7,
        contentLabel: 'Promo',
        playedAt: '2026-10-05T03:00:00.000Z',
        durationSeconds: 15,
        wasOffline: false
      },
      { contentLabel: 'Dua', durationSeconds: 15, wasOffline: true }
    ])
  })

  it('ignores plays shorter than one second and invalid events', () => {
    const { reporter, store } = setup()
    expect(reporter.record(event({ playedSeconds: 0.4 }))).toBe(false)
    expect(reporter.record(event({ playedSeconds: Number.NaN }))).toBe(false)
    expect(reporter.record(event({ contentId: 1.5 }))).toBe(false)
    expect(reporter.record(event({ startedAt: 'bukan tanggal' }))).toBe(false)
    expect(store.rows).toEqual([])
  })

  it('accepts ISO strings from the renderer, trims blank labels to null and truncates long ones', () => {
    const { reporter, store } = setup()
    reporter.record(event({ startedAt: '2026-10-05T03:00:00.000Z', label: '   ' }))
    reporter.record(event({ label: 'x'.repeat(400) }))
    expect(store.rows[0].contentLabel).toBeNull()
    expect(store.rows[1].contentLabel).toHaveLength(255)
  })

  it('caps absurd durations at 24 hours', () => {
    const { reporter, store } = setup()
    reporter.record(event({ playedSeconds: 10_000_000 }))
    expect(store.rows[0].durationSeconds).toBe(86_400)
  })
})

describe('PlaybackReporter.flush', () => {
  it('is idle when nothing is queued', async () => {
    const { reporter, post } = setup()
    expect(await reporter.flush('dev', 'tok')).toEqual({ kind: 'idle' })
    expect(post).not.toHaveBeenCalled()
  })

  it('uploads the oldest rows first in the API format and removes them only after success', async () => {
    const { reporter, store, post } = setup()
    reporter.record(event({ contentId: 1 }))
    reporter.record(event({ contentId: 2 }))

    const result = await reporter.flush('dev-1', 'tok')

    expect(result).toEqual({ kind: 'sent', sent: 2, pending: 0 })
    expect(post).toHaveBeenCalledWith('dev-1', 'tok', [
      {
        content_id: 1,
        content_label: 'Promo',
        played_at: '2026-10-05T03:00:00.000Z',
        duration_seconds: 15,
        was_offline: false
      },
      {
        content_id: 2,
        content_label: 'Promo',
        played_at: '2026-10-05T03:00:00.000Z',
        duration_seconds: 15,
        was_offline: false
      }
    ])
    expect(store.rows).toEqual([])
  })

  it('splits large queues into batches of at most 500', async () => {
    const { reporter, store, post } = setup()
    for (let i = 0; i < 1_200; i++) reporter.record(event({ contentId: i + 1 }))
    const result = await reporter.flush('dev', 'tok')
    expect(result).toMatchObject({ kind: 'sent', sent: 1_200, pending: 0 })
    expect(post.mock.calls.map((call) => (call[2] as unknown[]).length)).toEqual([500, 500, 200])
    expect(store.count()).toBe(0)
  })

  it('stops at the first failed batch and keeps that batch and everything after it', async () => {
    const { reporter, store, post } = setup({ batchSize: 2, responses: [reply(200), reply(503)] })
    for (let i = 1; i <= 6; i++) reporter.record(event({ contentId: i }))

    const result = await reporter.flush('dev', 'tok')

    expect(result).toEqual({ kind: 'error', sent: 2, message: 'HTTP 503' })
    expect(post).toHaveBeenCalledTimes(2)
    expect(store.rows.map((r) => r.contentId)).toEqual([3, 4, 5, 6])
  })

  it('keeps the queue and reports an error on network failures', async () => {
    const { reporter, store } = setup({ responses: [new Error('ECONNRESET')] })
    reporter.record(event())
    expect(await reporter.flush('dev', 'tok')).toMatchObject({ kind: 'error', sent: 0 })
    expect(store.count()).toBe(1)
  })

  it('never sends the same rows twice (next flush continues from what is left)', async () => {
    const { reporter, post } = setup({ batchSize: 2, responses: [reply(200), reply(500)] })
    for (let i = 1; i <= 4; i++) reporter.record(event({ contentId: i }))
    await reporter.flush('dev', 'tok')
    await reporter.flush('dev', 'tok')
    const sentIds = post.mock.calls.flatMap((call) =>
      (call[2] as { content_id: number }[]).map((l) => l.content_id)
    )
    expect(sentIds).toEqual([1, 2, 3, 4, 3, 4]) // 3 dan 4 diulang karena batch itu gagal, bukan karena terkirim
  })

  it('reports auth rejection for API JSON 401/403 and keeps the queue', async () => {
    const { reporter, store } = setup({ responses: [reply(403, true)] })
    reporter.record(event())
    expect(await reporter.flush('dev', 'tok')).toEqual({ kind: 'auth-rejected', sent: 0 })
    expect(store.count()).toBe(1)
  })

  it('does not trust 401/403 that are not API JSON (proxy / captive portal)', async () => {
    const { reporter, store } = setup({ responses: [reply(403, false)] })
    reporter.record(event())
    expect(await reporter.flush('dev', 'tok')).toMatchObject({ kind: 'error', message: 'HTTP 403' })
    expect(store.count()).toBe(1)
  })

  it('drops a batch the server rejects as invalid (422) so the queue is never blocked forever', async () => {
    const { reporter, store, logs } = setup({
      batchSize: 2,
      responses: [reply(422, true), reply(200)]
    })
    for (let i = 1; i <= 4; i++) reporter.record(event({ contentId: i }))

    const result = await reporter.flush('dev', 'tok')

    expect(result).toMatchObject({ kind: 'sent', sent: 2 })
    expect(store.count()).toBe(0)
    expect(logs.some((m) => m.includes('ditolak server'))).toBe(true)
  })

  it('does not drop data on throttling or timeouts (429/408)', async () => {
    const { reporter, store } = setup({ responses: [reply(429, true)] })
    reporter.record(event())
    expect(await reporter.flush('dev', 'tok')).toMatchObject({ kind: 'error' })
    expect(store.count()).toBe(1)
  })

  it('ignores a flush that starts while another one is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const store = new MemoryPlaybackLogStore()
    const post = vi.fn(async () => {
      await gate
      return reply(200)
    })
    const reporter = new PlaybackReporter({
      store,
      api: { postPlaybackLogs: post } as unknown as Pick<ApiClient, 'postPlaybackLogs'>,
      isOnline: () => true
    })
    reporter.record(event())
    const first = reporter.flush('dev', 'tok')
    expect(await reporter.flush('dev', 'tok')).toEqual({ kind: 'idle' })
    release()
    await first
    expect(post).toHaveBeenCalledTimes(1)
  })
})
