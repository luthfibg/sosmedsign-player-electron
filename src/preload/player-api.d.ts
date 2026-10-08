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

  interface SettingsOverviewDto {
    device: {
      registered: boolean
      deviceCode: string
      deviceName: string | null
      venueId: number | null
    }
    app: { version: string; electron: string; backendUrl: string }
    system: { appBytes: number; systemTotalBytes: number; systemFreeBytes: number }
    storage: {
      cacheDir: string
      cacheFiles: number
      cacheBytes: number
      orphanFiles: number
      orphanBytes: number
      diskFreeBytes: number | null
      diskTotalBytes: number | null
      dbBytes: number
      itemsTotal: number
      itemsReady: number
      itemsFailed: number
      pendingPlaybackLogs: number
    }
    sync: DiagnosticIndicatorDto
    settings: {
      keepScreenOn: boolean
      /** Folder cache khusus yang diatur pengguna (null = bawaan). */
      customCacheDir: string | null
      defaultCacheDir: string
      /** Folder khusus tidak bisa dipakai saat startup, jadi sesi ini memakai folder bawaan. */
      cacheDirFallbackReason: string | null
    }
  }

  interface CacheDirPreviewDto {
    ok: boolean
    reason: string | null
    isNew: boolean
    existingCacheFiles: number
    currentFiles: number
    currentBytes: number
  }

  interface SettingsActionResultDto {
    ok: boolean
    message: string
  }

  type CacheDirModeDto = 'move' | 'fresh'

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
    getSettingsOverview(): Promise<SettingsOverviewDto>
    /** Dialog pilih folder (null = dibatalkan). */
    chooseCacheDir(defaultPath: string | null): Promise<string | null>
    previewCacheDir(path: string): Promise<CacheDirPreviewDto>
    changeCacheDir(path: string, mode: CacheDirModeDto): Promise<SettingsActionResultDto>
    cleanCache(): Promise<SettingsActionResultDto>
    verifyCache(): Promise<SettingsActionResultDto>
    forceSync(): Promise<SettingsActionResultDto>
    setKeepScreenOn(on: boolean): Promise<void>
    releaseDevice(): Promise<SettingsActionResultDto>
    onPlaylistChanged(callback: (playlist: PlayerPlaylistDto | null) => void): () => void
    /** Mengembalikan fungsi untuk berhenti berlangganan. */
    onDeviceStateChanged(callback: (state: DeviceStateDto) => void): () => void
  }

  interface Window {
    api: PlayerApi
  }
}
