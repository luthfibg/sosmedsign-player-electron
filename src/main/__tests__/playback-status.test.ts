import { describe, expect, it } from 'vitest'
import { PlaybackStatus } from '../services/playback-status'

function setup(): { status: PlaybackStatus; clock: { t: number } } {
  const clock = { t: 1_000_000 }
  return { status: new PlaybackStatus(() => clock.t, 10 * 60_000), clock }
}

describe('PlaybackStatus', () => {
  it('is unknown until the player reports something', () => {
    expect(setup().status.getIndicator()).toMatchObject({ state: 'unknown' })
  })

  it('maps engine states to indicator states', () => {
    const { status } = setup()
    status.update('waiting')
    expect(status.getIndicator()).toMatchObject({
      state: 'unknown',
      detail: 'Menunggu playlist dari server'
    })
    status.update('idle')
    expect(status.getIndicator().state).toBe('warning')
    status.update('playing', 'Promo Oktober')
    expect(status.getIndicator()).toEqual({ state: 'active', detail: 'Memutar: Promo Oktober' })
  })

  it('keeps the last label when playing is re-reported without one, and clears it otherwise', () => {
    const { status } = setup()
    status.update('playing', 'A')
    status.update('playing')
    expect(status.getIndicator().detail).toBe('Memutar: A')
    status.update('idle')
    status.update('playing')
    expect(status.getIndicator().detail).toBe('Sedang memutar')
  })

  it('warns when "playing" has shown no activity for too long (renderer may be hung)', () => {
    const { status, clock } = setup()
    status.update('playing', 'A')
    clock.t += 9 * 60_000
    expect(status.getIndicator().state).toBe('active')
    clock.t += 2 * 60_000
    expect(status.getIndicator()).toMatchObject({ state: 'warning' })
  })

  it('completed plays count as activity', () => {
    const { status, clock } = setup()
    status.update('playing', 'A')
    clock.t += 9 * 60_000
    status.noteActivity()
    clock.t += 9 * 60_000
    expect(status.getIndicator().state).toBe('active')
  })

  it('reset returns to unknown', () => {
    const { status } = setup()
    status.update('playing', 'A')
    status.reset()
    expect(status.getIndicator().state).toBe('unknown')
  })
})
