import { describe, expect, it } from 'vitest'
import { countPlayable, findNextPlayable } from '../rotation'
import { isPlayableNow, type ScheduleLike } from '../schedule'

/** Jakarta = UTC+7 tanpa DST. 2026-10-05 adalah hari Senin. */
const jakarta = (isoLocal: string): Date => new Date(`${isoLocal}+07:00`)

function schedule(overrides: Partial<ScheduleLike>): ScheduleLike {
  return {
    days: null,
    start: null,
    end: null,
    timezone: 'Asia/Jakarta',
    startDate: null,
    endDate: null,
    ...overrides
  }
}

describe('isPlayableNow', () => {
  it('no schedule means always playable', () => {
    expect(isPlayableNow(null, new Date())).toBe(true)
    expect(isPlayableNow(undefined, new Date())).toBe(true)
  })

  it('checks days and time window in the schedule timezone', () => {
    const s = schedule({ days: 'mon,tue,wed,thu,fri', start: '08:00', end: '18:00' })
    expect(isPlayableNow(s, jakarta('2026-10-05T10:00:00'))).toBe(true) // Senin
    expect(isPlayableNow(s, jakarta('2026-10-05T19:00:00'))).toBe(false)
    expect(isPlayableNow(s, jakarta('2026-10-10T10:00:00'))).toBe(false) // Sabtu
  })

  it('uses the schedule timezone, not the machine timezone', () => {
    const s = schedule({ start: '08:00', end: '18:00', timezone: 'Asia/Jakarta' })
    const instant = new Date('2026-10-05T03:00:00Z') // 10:00 Jakarta, 12:00 Tokyo, 03:00 UTC
    expect(isPlayableNow(s, instant)).toBe(true)
    expect(isPlayableNow({ ...s, timezone: 'UTC' }, instant)).toBe(false)
    expect(isPlayableNow({ ...s, timezone: 'Asia/Tokyo' }, instant)).toBe(true)
  })

  it('window boundaries are inclusive to the second', () => {
    const s = schedule({ start: '08:00', end: '18:00' })
    expect(isPlayableNow(s, jakarta('2026-10-05T08:00:00'))).toBe(true)
    expect(isPlayableNow(s, jakarta('2026-10-05T07:59:59'))).toBe(false)
    expect(isPlayableNow(s, jakarta('2026-10-05T18:00:00'))).toBe(true)
    expect(isPlayableNow(s, jakarta('2026-10-05T18:00:01'))).toBe(false)
  })

  it('accepts HH:mm:ss times', () => {
    const s = schedule({ start: '08:00:30', end: '08:01:30' })
    expect(isPlayableNow(s, jakarta('2026-10-05T08:00:29'))).toBe(false)
    expect(isPlayableNow(s, jakarta('2026-10-05T08:01:00'))).toBe(true)
  })

  it('an overnight window belongs to the day it starts', () => {
    const s = schedule({ days: 'mon', start: '22:00', end: '02:00' })
    expect(isPlayableNow(s, jakarta('2026-10-05T23:00:00'))).toBe(true) // Senin malam
    expect(isPlayableNow(s, jakarta('2026-10-06T01:00:00'))).toBe(true) // Selasa dini hari = lanjutan Senin
    expect(isPlayableNow(s, jakarta('2026-10-06T23:00:00'))).toBe(false) // Selasa malam
    expect(isPlayableNow(s, jakarta('2026-10-05T01:00:00'))).toBe(false) // Senin dini hari = lanjutan Minggu
    expect(isPlayableNow(s, jakarta('2026-10-05T12:00:00'))).toBe(false) // di luar jendela
  })

  it('honors startDate and endDate (inclusive, in the schedule timezone)', () => {
    const s = schedule({ startDate: '2026-10-10', endDate: '2026-10-12' })
    expect(isPlayableNow(s, jakarta('2026-10-09T23:59:59'))).toBe(false)
    expect(isPlayableNow(s, jakarta('2026-10-10T00:00:00'))).toBe(true)
    expect(isPlayableNow(s, jakarta('2026-10-12T23:59:59'))).toBe(true)
    expect(isPlayableNow(s, jakarta('2026-10-13T00:00:00'))).toBe(false)
  })

  it('date range is checked against the date the overnight window started', () => {
    const s = schedule({ start: '22:00', end: '02:00', endDate: '2026-10-12' })
    expect(isPlayableNow(s, jakarta('2026-10-13T01:00:00'))).toBe(true) // jendela 12 Okt
    expect(isPlayableNow(s, jakarta('2026-10-13T23:00:00'))).toBe(false) // jendela 13 Okt
  })

  it('unexpected formats default to playable instead of hiding content', () => {
    const now = jakarta('2026-10-05T10:00:00')
    expect(
      isPlayableNow(schedule({ timezone: 'Mars/Olympus', start: '23:00', end: '23:30' }), now)
    ).toBe(true)
    expect(isPlayableNow(schedule({ start: 'pagi', end: 'sore' }), now)).toBe(true)
    expect(isPlayableNow(schedule({ start: '08:00' }), now)).toBe(true) // hanya satu sisi jendela
    expect(isPlayableNow(schedule({ days: 'xyz' }), now)).toBe(true)
    expect(isPlayableNow(schedule({ startDate: 'kemarin' }), now)).toBe(true)
    expect(isPlayableNow(schedule({ start: '25:00', end: '26:00' }), now)).toBe(true)
  })

  it('accepts full and mixed-case day names', () => {
    const s = schedule({ days: 'Monday, TUE' })
    expect(isPlayableNow(s, jakarta('2026-10-05T10:00:00'))).toBe(true)
    expect(isPlayableNow(s, jakarta('2026-10-07T10:00:00'))).toBe(false) // Rabu
  })

  it('falls back to the machine timezone when the schedule has none', () => {
    const s = schedule({ timezone: null, startDate: '2000-01-01', endDate: '2999-12-31' })
    expect(isPlayableNow(s, new Date())).toBe(true)
  })
})

describe('findNextPlayable', () => {
  const always = { schedule: null }
  const never = { schedule: schedule({ startDate: '2999-01-01' }) }
  const now = jakarta('2026-10-05T10:00:00')

  it('moves to the next item and wraps around', () => {
    expect(findNextPlayable([always, always, always], 0, now)).toBe(1)
    expect(findNextPlayable([always, always, always], 2, now)).toBe(0)
  })

  it('starts from the first item when afterIndex is -1', () => {
    expect(findNextPlayable([always, always], -1, now)).toBe(0)
    expect(findNextPlayable([never, always], -1, now)).toBe(1)
  })

  it('skips items outside their schedule (they stay in the playlist)', () => {
    expect(findNextPlayable([always, never, always], 0, now)).toBe(2)
  })

  it('repeats the only playable item', () => {
    expect(findNextPlayable([never, always, never], 1, now)).toBe(1)
  })

  it('returns -1 when nothing can play, or the list is empty', () => {
    expect(findNextPlayable([never, never], 0, now)).toBe(-1)
    expect(findNextPlayable([], -1, now)).toBe(-1)
  })

  it('countPlayable counts items that can play right now', () => {
    expect(countPlayable([always, never, always], now)).toBe(2)
  })
})
