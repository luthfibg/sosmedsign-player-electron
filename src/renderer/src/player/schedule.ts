/**
 * Jadwal tayang. Perilaku mengikuti player Android (docs/ANDROID_PLAYER_LOGIC.md bagian 7) dengan tiga perbaikan:
 *  1. startDate/endDate dihormati (Android mengabaikannya).
 *  2. Jendela lintas tengah malam (mis. 22:00-02:00) milik HARI DIMULAINYA: bagian setelah tengah malam
 *     dicek terhadap hari dan tanggal sebelumnya.
 *  3. Dievaluasi ulang secara berkala oleh engine, bukan hanya saat item berganti.
 * Format tak terduga (zona waktu, jam, atau hari tidak valid) = BOLEH TAYANG, supaya konten tidak hilang diam-diam.
 */

export type ScheduleLike = PlayerScheduleDto

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface LocalTime {
  /** "YYYY-MM-DD" di zona waktu jadwal. */
  date: string
  /** 0 = Minggu ... 6 = Sabtu. */
  day: number
  secondsOfDay: number
}

const formatters = new Map<string, Intl.DateTimeFormat | null>()

function formatterFor(timeZone: string | null): Intl.DateTimeFormat | null {
  const key = timeZone ?? ''
  if (formatters.has(key)) return formatters.get(key) ?? null
  let formatter: Intl.DateTimeFormat | null = null
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23'
    })
  } catch {
    formatter = null // zona waktu tidak dikenal
  }
  formatters.set(key, formatter)
  return formatter
}

function localTime(now: Date, timeZone: string | null): LocalTime | null {
  const formatter = formatterFor(timeZone)
  if (!formatter) return null
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value
  const day = DAY_KEYS.indexOf((parts.weekday ?? '').slice(0, 3).toLowerCase())
  if (day < 0) return null
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day,
    secondsOfDay: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)
  }
}

function parseTime(value: string | null): number | null {
  if (!value) return null
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!match) return null
  const [h, m, s] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  if (h > 23 || m > 59 || s > 59) return null
  return h * 3600 + m * 60 + s
}

/** null = semua hari (kosong atau tidak ada token valid). */
function parseDays(value: string | null): Set<number> | null {
  if (!value) return null
  const days = new Set<number>()
  for (const token of value.split(',')) {
    const index = DAY_KEYS.indexOf(token.trim().slice(0, 3).toLowerCase())
    if (index >= 0) days.add(index)
  }
  return days.size > 0 ? days : null
}

function validDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null
}

function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

export function isPlayableNow(schedule: ScheduleLike | null | undefined, now: Date): boolean {
  if (!schedule) return true
  const local = localTime(now, schedule.timezone)
  if (!local) return true

  let windowDate = local.date
  let windowDay = local.day

  const start = parseTime(schedule.start)
  const end = parseTime(schedule.end)
  if (start !== null && end !== null) {
    if (start <= end) {
      if (local.secondsOfDay < start || local.secondsOfDay > end) return false
    } else if (local.secondsOfDay >= start) {
      // bagian malam: milik hari ini
    } else if (local.secondsOfDay <= end) {
      // bagian setelah tengah malam: milik hari sebelumnya
      windowDate = previousDate(local.date)
      windowDay = (local.day + 6) % 7
    } else {
      return false
    }
  }

  const days = parseDays(schedule.days)
  if (days && !days.has(windowDay)) return false

  const startDate = validDate(schedule.startDate)
  if (startDate && windowDate < startDate) return false
  const endDate = validDate(schedule.endDate)
  if (endDate && windowDate > endDate) return false
  return true
}
