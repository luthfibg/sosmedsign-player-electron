import type { NewPlaybackLog, PendingPlaybackLog, PlaybackLogStore } from '../db/playback-log-store'

/** Implementasi PlaybackLogStore di memori untuk menguji reporter tanpa modul native SQLite. */
export class MemoryPlaybackLogStore implements PlaybackLogStore {
  rows: PendingPlaybackLog[] = []
  private nextId = 1

  add(log: NewPlaybackLog): void {
    this.rows.push({ ...log, id: this.nextId++ })
  }

  peek(limit: number): PendingPlaybackLog[] {
    return this.rows.slice(0, limit).map((row) => ({ ...row }))
  }

  removeUpTo(maxId: number): void {
    this.rows = this.rows.filter((row) => row.id > maxId)
  }

  count(): number {
    return this.rows.length
  }
}
