/** DTO sesuai kontrak API backend (lihat docs/ANDROID_PLAYER_LOGIC.md bagian 2). Nama field = nama JSON. */

export interface ActivateResponse {
  device_code: string
  name: string | null
  venue_id: number | null
  slot_capacity: number
  slot_duration_seconds: number
  registration_status: 'registered' | 'pending'
  api_token: string
}

export interface RegistrationStatusResponse {
  registration_status: 'registered' | 'pending'
  venue_id: number | null
  slot_capacity: number
  slot_duration_seconds: number
}

/** Backend mengirim dua versi nama field (days/daysOfWeek, start/startTime, end/endTime). Baca keduanya. */
export interface PlaylistScheduleDto {
  days?: string | null
  daysOfWeek?: string | null
  start?: string | null
  startTime?: string | null
  end?: string | null
  endTime?: string | null
  timezone?: string | null
  startDate?: string | null
  endDate?: string | null
}

export interface PlaylistItemDto {
  slot_number: number
  slots_used?: number[]
  content_id: number
  content_label?: string | null
  content_url: string
  /** Bisa tidak ada di playlist lama; perlakukan sebagai 'video'. */
  media_type?: 'video' | 'image' | null
  duration_seconds: number
  /** Ditambahkan oleh patch backend (opsional sampai patch terpasang). */
  file_size?: number | null
  checksum_sha256?: string | null
  schedule?: PlaylistScheduleDto | null
}

export interface PlaylistResponse {
  device_id: string
  slot_duration_seconds: number
  playlist: PlaylistItemDto[]
  version_hash: string
  generated_at: string
}

export interface SyncLogRequest {
  playlist_version_hash: string
  status: 'success' | 'failed' | 'partial'
  bytes_downloaded: number
}

export interface PlaybackLogEntryDto {
  content_id: number
  content_label: string | null
  played_at: string
  duration_seconds: number
  was_offline: boolean
}
