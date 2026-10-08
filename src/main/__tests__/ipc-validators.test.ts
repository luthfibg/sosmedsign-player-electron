import { describe, expect, it } from 'vitest'
import { isCacheDirMode, isPathInput, isPlaybackEvent, isPlayerStatus } from '../ipc/validators'

const valid = {
  contentId: 7,
  label: 'Promo',
  startedAt: '2026-10-05T03:00:00.000Z',
  playedSeconds: 15
}

describe('isPlaybackEvent', () => {
  it('accepts a well-formed event, with or without a label', () => {
    expect(isPlaybackEvent(valid)).toBe(true)
    expect(isPlaybackEvent({ ...valid, label: null })).toBe(true)
  })

  it('rejects anything the renderer should never send', () => {
    for (const bad of [
      null,
      undefined,
      'teks',
      42,
      [],
      {},
      { ...valid, contentId: 1.5 },
      { ...valid, contentId: '7' },
      { ...valid, label: 123 },
      { ...valid, startedAt: 1_700_000_000 },
      { ...valid, playedSeconds: '15' }
    ]) {
      expect(isPlaybackEvent(bad)).toBe(false)
    }
  })
})

describe('isPlayerStatus', () => {
  it('accepts the three engine states with an optional label', () => {
    expect(isPlayerStatus({ state: 'waiting' })).toBe(true)
    expect(isPlayerStatus({ state: 'idle', label: null })).toBe(true)
    expect(isPlayerStatus({ state: 'playing', label: 'Promo' })).toBe(true)
  })

  it('rejects unknown states and wrong label types', () => {
    for (const bad of [null, 'playing', {}, { state: 'paused' }, { state: 'playing', label: 5 }]) {
      expect(isPlayerStatus(bad)).toBe(false)
    }
  })
})

describe('isCacheDirMode', () => {
  it('accepts only the two supported modes', () => {
    expect(isCacheDirMode('move')).toBe(true)
    expect(isCacheDirMode('fresh')).toBe(true)
    for (const bad of ['MOVE', 'copy', '', null, undefined, 1, {}])
      expect(isCacheDirMode(bad)).toBe(false)
  })
})

describe('isPathInput', () => {
  it('accepts ordinary non-empty paths', () => {
    expect(isPathInput('D:\\SosmedSignCache')).toBe(true)
    expect(isPathInput('/mnt/media/cache')).toBe(true)
  })

  it('rejects blank, oversized, NUL-containing, and non-string input', () => {
    for (const bad of [
      '',
      '   ',
      'x'.repeat(1025),
      'D:\\cache\0evil',
      null,
      undefined,
      42,
      {},
      []
    ]) {
      expect(isPathInput(bad)).toBe(false)
    }
  })
})
