export {}

/**
 * Tipe API yang diekspos preload ke renderer (window.api). Dideklarasikan global supaya bisa
 * dipakai bersama oleh main, preload, dan renderer tanpa mengubah tsconfig.
 */
declare global {
  interface DeviceStateDto {
    registered: boolean
    /** UUID permanen perangkat (bukan rahasia). */
    deviceCode: string
    venueId: number | null
    deviceName: string | null
  }

  interface PlayerScheduleDto {
    /** CSV hari: "mon,tue,wed". */
    days: string | null
    /** "HH:mm" atau "HH:mm:ss". */
    start: string | null
    end: string | null
    timezone: string | null
    /** "YYYY-MM-DD". */
    startDate: string | null
    endDate: string | null
  }

  interface PlayerItemDto {
    id: number
    contentId: number
    label: string
    mediaType: 'video' | 'image'
    durationSeconds: number
    /** URL sosmedsign-media://media/<file>; hanya item yang file cache-nya siap yang dikirim. */
    mediaUrl: string
    schedule: PlayerScheduleDto | null
  }

  interface PlayerPlaylistDto {
    versionHash: string
    slotDurationSeconds: number
    items: PlayerItemDto[]
  }

  /** Satu tayang yang selesai wajar (video ended / timer gambar habis); dilaporkan renderer ke main. */
  interface PlaybackEventDto {
    contentId: number
    label: string | null
    /** ISO-8601 waktu mulai tayang. */
    startedAt: string
    playedSeconds: number
  }

  interface PlayerStatusDto {
    state: 'waiting' | 'playing' | 'idle'
    label?: string | null
  }

  type ActivationResultDto = { ok: true } | { ok: false; message: string }

  type DiagnosticIndicatorState =
    'active' | 'inactive' | 'warning' | 'error' | 'working' | 'unknown'

  interface DiagnosticIndicatorDto {
    state: DiagnosticIndicatorState
    detail: string
  }

  interface DiagnosticsIndicatorsDto {
    online: DiagnosticIndicatorDto
    connected: DiagnosticIndicatorDto
    sync: DiagnosticIndicatorDto
    playback: DiagnosticIndicatorDto
  }

  interface PlayerApi {
    getDeviceState(): Promise<DeviceStateDto>
    activate(activationCode: string): Promise<ActivationResultDto>
    resetIdentity(): Promise<void>
    getDiagnostics(): Promise<string[]>
    getDiagnosticIndicators(): Promise<DiagnosticsIndicatorsDto>
    /** Playlist yang siap diputar; null kalau belum pernah ada playlist dari server. */
    getPlaylist(): Promise<PlayerPlaylistDto | null>
    /** Mengirim satu baris log pemutar ke log diagnostik main process. */
    logPlayer(message: string): Promise<void>
    /** Melaporkan tayang yang selesai (untuk statistik; diantrekan lokal lalu diunggah saat sync). */
    reportItemCompleted(event: PlaybackEventDto): Promise<void>
    /** Melaporkan status mesin pemutar (untuk lampu Playback di panel diagnostik). */
    reportPlayerStatus(status: PlayerStatusDto): Promise<void>
    onPlaylistChanged(callback: (playlist: PlayerPlaylistDto | null) => void): () => void
    /** Mengembalikan fungsi untuk berhenti berlangganan. */
    onDeviceStateChanged(callback: (state: DeviceStateDto) => void): () => void
  }

  interface Window {
    api: PlayerApi
  }
}
