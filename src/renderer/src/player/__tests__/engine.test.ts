// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackEngine, type EngineCallbacks, type EngineOptions } from '../engine'

/** Image palsu: onload dipicu otomatis (microtask), kecuali URL memuat "bad". */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private _src = ''
  get src(): string {
    return this._src
  }
  set src(value: string) {
    this._src = value
    queueMicrotask(() => (value.includes('bad') ? this.onerror?.() : this.onload?.()))
  }
}

type Els = { videos: [HTMLVideoElement, HTMLVideoElement]; image: HTMLImageElement }

function makeVideo(): HTMLVideoElement {
  const video = document.createElement('video')
  video.play = vi.fn(() => Promise.resolve())
  video.pause = vi.fn()
  video.load = vi.fn()
  Object.defineProperty(video, 'duration', { value: 10, configurable: true })
  return video
}

function item(id: number, overrides: Partial<PlayerItemDto> = {}): PlayerItemDto {
  return {
    id,
    contentId: id,
    label: `Item ${id}`,
    mediaType: 'video',
    durationSeconds: 10,
    mediaUrl: `m://media/v${id}.mp4`,
    schedule: null,
    ...overrides
  }
}

const image = (id: number, seconds = 5): PlayerItemDto =>
  item(id, { mediaType: 'image', durationSeconds: seconds, mediaUrl: `m://media/i${id}.png` })

const playlist = (...items: PlayerItemDto[]): PlayerPlaylistDto => ({
  versionHash: 'v',
  slotDurationSeconds: 15,
  items
})

const emit = (el: HTMLElement, type: string): void => {
  el.dispatchEvent(new Event(type))
}
const src = (video: HTMLVideoElement): string | null => video.getAttribute('src')
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

interface Rig {
  els: Els
  engine: PlaybackEngine
  states: string[]
  started: number[]
  completed: number[]
  logs: string[]
  clock: { t: number }
}

function setup(options: EngineOptions = {}): Rig {
  const els: Els = { videos: [makeVideo(), makeVideo()], image: document.createElement('img') }
  const states: string[] = []
  const started: number[] = []
  const completed: number[] = []
  const logs: string[] = []
  const clock = { t: Date.parse('2026-10-05T03:00:00Z') }
  const callbacks: EngineCallbacks = {
    onStateChange: (s) => states.push(s),
    onItemStarted: (i) => started.push(i.id),
    onItemCompleted: (i) => completed.push(i.id),
    onLog: (m) => logs.push(m)
  }
  const engine = new PlaybackEngine(els, callbacks, { now: () => new Date(clock.t), ...options })
  return { els, engine, states, started, completed, logs, clock }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Image', FakeImage)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PlaybackEngine states', () => {
  it('stays "waiting" until a playlist is known, and goes idle for an empty one', async () => {
    const { engine, states } = setup()
    engine.setPlaylist(null)
    expect(states).toEqual([])
    engine.setPlaylist(playlist())
    expect(states).toEqual(['idle'])
    engine.destroy()
  })

  it('reaches "playing" only after the first video actually starts', async () => {
    const { engine, els, states, started } = setup()
    engine.setPlaylist(playlist(item(1), item(2)))
    expect(states).toEqual([])
    expect(src(els.videos[1])).toBe('m://media/v1.mp4')
    expect(els.videos[1].play).toHaveBeenCalledTimes(1)

    emit(els.videos[1], 'playing')
    expect(states).toEqual(['playing'])
    expect(started).toEqual([1])
    expect(els.videos[1].style.opacity).toBe('1')
    engine.destroy()
  })
})

describe('PlaybackEngine video rotation (gapless A/B)', () => {
  it('preloads the next video into the standby element while the current one plays', () => {
    const { engine, els } = setup()
    engine.setPlaylist(playlist(item(1), item(2)))
    emit(els.videos[1], 'playing')
    expect(src(els.videos[0])).toBe('m://media/v2.mp4')
    expect(els.videos[0].load).toHaveBeenCalledTimes(1)
    engine.destroy()
  })

  it('starts the preloaded standby on "ended" without reloading it, then swaps and unloads the old one', () => {
    const { engine, els, completed, started } = setup()
    engine.setPlaylist(playlist(item(1), item(2), item(3)))
    emit(els.videos[1], 'playing')

    emit(els.videos[1], 'ended')
    expect(completed).toEqual([1])
    expect(els.videos[0].play).toHaveBeenCalledTimes(1)
    expect(els.videos[0].load).toHaveBeenCalledTimes(1) // tidak dimuat ulang

    emit(els.videos[0], 'playing')
    expect(started).toEqual([1, 2])
    expect(els.videos[0].style.opacity).toBe('1')
    expect(els.videos[1].style.opacity).toBe('0')
    expect(src(els.videos[1])).toBe('m://media/v3.mp4') // bekas slot lama sudah dipakai menyiapkan item 3
    engine.destroy()
  })

  it('wraps around the playlist', () => {
    const { engine, els, started } = setup()
    engine.setPlaylist(playlist(item(1), item(2)))
    emit(els.videos[1], 'playing')
    emit(els.videos[1], 'ended')
    emit(els.videos[0], 'playing')
    emit(els.videos[0], 'ended')
    emit(els.videos[1], 'playing')
    expect(started).toEqual([1, 2, 1])
    engine.destroy()
  })

  it('repeats a playlist that has a single video', () => {
    const { engine, els, started, completed } = setup()
    engine.setPlaylist(playlist(item(1)))
    emit(els.videos[1], 'playing')
    emit(els.videos[1], 'ended')
    expect(completed).toEqual([1])
    emit(els.videos[0], 'playing')
    expect(started).toEqual([1, 1])
    engine.destroy()
  })

  it('ignores events from the standby element', () => {
    const { engine, els, completed } = setup()
    engine.setPlaylist(playlist(item(1), item(2)))
    emit(els.videos[1], 'playing')
    emit(els.videos[0], 'ended') // elemen standby
    expect(completed).toEqual([])
    engine.destroy()
  })
})

describe('PlaybackEngine images', () => {
  it('shows an image for its server-provided duration, then moves on', async () => {
    const { engine, els, started, completed } = setup()
    engine.setPlaylist(playlist(image(1, 5), item(2)))
    await flush()
    expect(started).toEqual([1])
    expect(els.image.getAttribute('src')).toBe('m://media/i1.png')
    expect(els.image.style.opacity).toBe('1')

    await vi.advanceTimersByTimeAsync(4_999)
    expect(completed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(completed).toEqual([1])
    expect(els.videos[1].play).toHaveBeenCalledTimes(1)
    engine.destroy()
  })

  it('shows images for at least one second', async () => {
    const { engine, completed } = setup()
    engine.setPlaylist(playlist(image(1, 0.2), item(2)))
    await flush()
    await vi.advanceTimersByTimeAsync(999)
    expect(completed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(completed).toEqual([1])
    engine.destroy()
  })

  it('hides the image when a video follows', async () => {
    const { engine, els } = setup()
    engine.setPlaylist(playlist(image(1, 1), item(2)))
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    emit(els.videos[1], 'playing')
    expect(els.image.style.opacity).toBe('0')
    engine.destroy()
  })

  it('skips an image that fails to load', async () => {
    const { engine, logs, els } = setup()
    const bad = { ...image(1), mediaUrl: 'm://media/bad.png' }
    engine.setPlaylist(playlist(bad, item(2)))
    await flush()
    expect(logs[0]).toContain('Lewati "Item 1"')
    expect(els.videos[1].play).toHaveBeenCalledTimes(1)
    engine.destroy()
  })
})

describe('PlaybackEngine schedule', () => {
  const future = {
    days: null,
    start: null,
    end: null,
    timezone: 'Asia/Jakarta',
    startDate: '2026-10-10',
    endDate: null
  }

  it('skips items outside their schedule', () => {
    const { engine, els, started } = setup()
    engine.setPlaylist(playlist(item(1, { schedule: future }), item(2)))
    emit(els.videos[1], 'playing')
    expect(started).toEqual([2])
    engine.destroy()
  })

  it('goes idle when nothing is playable and starts by itself when a window opens', () => {
    const { engine, els, states, started, clock } = setup({ idleRecheckMs: 30_000 })
    engine.setPlaylist(playlist(item(1, { schedule: future })))
    expect(states).toEqual(['idle'])

    clock.t = Date.parse('2026-10-10T01:00:00Z')
    vi.advanceTimersByTime(30_000)
    expect(els.videos[1].play).toHaveBeenCalledTimes(1)
    emit(els.videos[1], 'playing')
    expect(started).toEqual([1])
    expect(states).toEqual(['idle', 'playing'])
    engine.destroy()
  })
})

describe('PlaybackEngine errors', () => {
  it('skips an item whose video errors, without counting it as played', () => {
    const { engine, els, logs, completed, started } = setup()
    engine.setPlaylist(playlist(item(1), item(2)))
    emit(els.videos[1], 'error')
    expect(logs[0]).toContain('Lewati "Item 1"')
    expect(completed).toEqual([])
    // Item 1 belum pernah tampil, jadi item 2 memakai slot yang sama.
    expect(src(els.videos[1])).toBe('m://media/v2.mp4')
    expect(els.videos[1].play).toHaveBeenCalledTimes(2)
    emit(els.videos[1], 'playing')
    expect(started).toEqual([2])
    engine.destroy()
  })

  it('skips an item when play() is rejected', async () => {
    const { engine, els, logs } = setup()
    els.videos[1].play = vi
      .fn()
      .mockRejectedValueOnce(new Error('NotAllowedError'))
      .mockResolvedValue(undefined)
    engine.setPlaylist(playlist(item(1), item(2)))
    await flush()
    expect(logs[0]).toContain('NotAllowedError')
    expect(src(els.videos[1])).toBe('m://media/v2.mp4')
    expect(els.videos[1].play).toHaveBeenCalledTimes(2)
    engine.destroy()
  })

  it('backs off instead of spinning when every item fails, then retries', () => {
    const { engine, els, states } = setup({ retryBackoffMs: 5_000 })
    engine.setPlaylist(playlist(item(1), item(2)))
    const plays = (): number =>
      (els.videos[0].play as ReturnType<typeof vi.fn>).mock.calls.length +
      (els.videos[1].play as ReturnType<typeof vi.fn>).mock.calls.length

    emit(els.videos[1], 'error') // item 1 gagal -> item 2 dicoba (slot yang sama, belum pernah tampil)
    emit(els.videos[1], 'error') // item 2 gagal -> semua item sudah gagal
    expect(states).toEqual(['idle'])
    expect(plays()).toBe(2)

    vi.advanceTimersByTime(4_999)
    expect(plays()).toBe(2) // tidak berputar cepat
    vi.advanceTimersByTime(1)
    expect(plays()).toBe(3) // mencoba lagi dari awal
    engine.destroy()
  })

  it('reuses the already-preloaded next video when the active one errors mid-play', () => {
    const { engine, els, started } = setup()
    engine.setPlaylist(playlist(item(1), item(2)))
    emit(els.videos[1], 'playing')
    expect(els.videos[0].load).toHaveBeenCalledTimes(1) // item 2 dipersiapkan

    emit(els.videos[1], 'error') // item 1 rusak di tengah putar
    expect(els.videos[0].load).toHaveBeenCalledTimes(1) // tidak dimuat ulang
    expect(els.videos[0].play).toHaveBeenCalledTimes(1)
    emit(els.videos[0], 'playing')
    expect(started).toEqual([1, 2])
    engine.destroy()
  })

  it('gives up on a video that never starts after the load timeout', () => {
    const { engine, els, logs } = setup({ loadTimeoutMs: 20_000 })
    engine.setPlaylist(playlist(item(1), item(2)))
    vi.advanceTimersByTime(20_000)
    expect(logs[0]).toContain('tidak mulai tampil')
    expect(src(els.videos[1])).toBe('m://media/v2.mp4')
    expect(els.videos[1].play).toHaveBeenCalledTimes(2)
    engine.destroy()
  })

  it('moves on when a playing video hangs past its duration (watchdog)', () => {
    const { engine, els, logs } = setup({ watchdogSlackMs: 10_000 })
    engine.setPlaylist(playlist(item(1, { durationSeconds: 10 }), item(2)))
    emit(els.videos[1], 'playing')
    vi.advanceTimersByTime(19_999)
    expect(logs).toEqual([])
    vi.advanceTimersByTime(1)
    expect(logs[0]).toContain('macet')
    expect(els.videos[0].play).toHaveBeenCalledTimes(1)
    engine.destroy()
  })

  it('uses the real video duration for the watchdog once metadata is known', () => {
    const { engine, els, logs } = setup({ watchdogSlackMs: 10_000 })
    Object.defineProperty(els.videos[1], 'duration', { value: 60, configurable: true })
    engine.setPlaylist(playlist(item(1, { durationSeconds: 10 }), item(2)))
    emit(els.videos[1], 'playing')
    emit(els.videos[1], 'loadedmetadata')
    vi.advanceTimersByTime(30_000)
    expect(logs).toEqual([]) // video 60 dtk tidak dipotong oleh perkiraan 10 dtk
    vi.advanceTimersByTime(40_000)
    expect(logs[0]).toContain('macet')
    engine.destroy()
  })
})

describe('PlaybackEngine playlist changes', () => {
  it('finishes the current item, then restarts from the beginning of the new playlist', () => {
    const { engine, els, started } = setup()
    engine.setPlaylist(playlist(item(1), item(2), item(3)))
    emit(els.videos[1], 'playing')

    engine.setPlaylist(playlist(item(8), item(9)))
    expect(els.videos[1].style.opacity).toBe('1') // item 1 masih tayang
    expect(src(els.videos[0])).toBe('m://media/v8.mp4') // item berikutnya sudah dipersiapkan dari playlist baru

    emit(els.videos[1], 'ended')
    emit(els.videos[0], 'playing')
    expect(started).toEqual([1, 8])
    engine.destroy()
  })

  it('starts immediately when a playlist arrives while idle', () => {
    const { engine, els, states } = setup()
    engine.setPlaylist(playlist())
    engine.setPlaylist(playlist(item(1)))
    expect(els.videos[1].play).toHaveBeenCalledTimes(1)
    emit(els.videos[1], 'playing')
    expect(states).toEqual(['idle', 'playing'])
    engine.destroy()
  })

  it('goes idle after the current item when the new playlist is empty', () => {
    const { engine, els, states } = setup()
    engine.setPlaylist(playlist(item(1)))
    emit(els.videos[1], 'playing')
    engine.setPlaylist(playlist())
    emit(els.videos[1], 'ended')
    expect(states).toEqual(['playing', 'idle'])
    expect(els.videos[1].style.opacity).toBe('0')
    engine.destroy()
  })
})

describe('PlaybackEngine destroy', () => {
  it('stops reacting to events and timers', () => {
    const { engine, els, completed } = setup()
    engine.setPlaylist(playlist(item(1), item(2)))
    emit(els.videos[1], 'playing')
    engine.destroy()
    emit(els.videos[1], 'ended')
    vi.advanceTimersByTime(120_000)
    expect(completed).toEqual([])
    expect(els.videos[0].play).not.toHaveBeenCalled()
  })
})
