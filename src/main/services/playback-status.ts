export type PlayerEngineState = 'waiting' | 'playing' | 'idle'

const DEFAULT_STALE_MS = 10 * 60 * 1000

/**
 * Status pemutar yang dilaporkan renderer (engine ada di renderer, jadi main hanya bisa tahu lewat laporan).
 * Dipakai untuk lampu Playback di panel diagnostik.
 */
export class PlaybackStatus {
  private state: PlayerEngineState | null = null
  private label: string | null = null
  private lastActivityAt = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly staleMs: number = DEFAULT_STALE_MS
  ) {}

  update(state: PlayerEngineState, label?: string | null): void {
    this.state = state
    if (state === 'playing') this.label = label ?? this.label
    else this.label = null
    this.lastActivityAt = this.now()
  }

  /** Dipanggil saat satu tayang selesai (bukti pemutar masih hidup walau state tidak berubah). */
  noteActivity(): void {
    this.lastActivityAt = this.now()
  }

  reset(): void {
    this.state = null
    this.label = null
    this.lastActivityAt = 0
  }

  getIndicator(): DiagnosticIndicatorDto {
    switch (this.state) {
      case null:
        return { state: 'unknown', detail: 'Pemutar belum melaporkan status' }
      case 'waiting':
        return { state: 'unknown', detail: 'Menunggu playlist dari server' }
      case 'idle':
        return {
          state: 'warning',
          detail: 'Tidak ada konten yang bisa diputar (kosong, di luar jadwal, atau gagal)'
        }
      case 'playing':
        if (this.now() - this.lastActivityAt > this.staleMs) {
          return {
            state: 'warning',
            detail: `Tidak ada aktivitas pemutaran lebih dari ${Math.round(this.staleMs / 60_000)} menit`
          }
        }
        return { state: 'active', detail: this.label ? `Memutar: ${this.label}` : 'Sedang memutar' }
    }
  }
}
