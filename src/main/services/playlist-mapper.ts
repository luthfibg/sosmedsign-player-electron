import { basename } from 'path'
import type { DownloadStatus, ItemSchedule, MediaType, NewPlaylistItem } from '../db/playlist-store'
import type { PlaylistItemDto, PlaylistScheduleDto } from './api-types'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp'])

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function inferMediaType(url: string, declared?: string | null): MediaType {
  if (declared === 'image' || declared === 'video') return declared
  try {
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''
    return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'video'
  } catch {
    return 'video'
  }
}

/** Backend mengirim dua nama field (days/daysOfWeek, start/startTime, end/endTime); keduanya dibaca. */
export function mapSchedule(dto: PlaylistScheduleDto | null | undefined): ItemSchedule | null {
  if (!dto || typeof dto !== 'object') return null
  const schedule: ItemSchedule = {
    days: str(dto.days) ?? str(dto.daysOfWeek),
    start: str(dto.start) ?? str(dto.startTime),
    end: str(dto.end) ?? str(dto.endTime),
    timezone: str(dto.timezone),
    startDate: str(dto.startDate),
    endDate: str(dto.endDate)
  }
  return Object.values(schedule).every((v) => v === null) ? null : schedule
}

/** Item playlist yang cukup valid untuk diproses; item rusak dilewati satu per satu, bukan menggagalkan seluruh sync. */
export function isPlaylistItem(value: unknown): value is PlaylistItemDto {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PlaylistItemDto>
  return (
    Number.isInteger(item.slot_number) &&
    Number.isInteger(item.content_id) &&
    typeof item.content_url === 'string' &&
    item.content_url.length > 0 &&
    typeof item.duration_seconds === 'number' &&
    Number.isFinite(item.duration_seconds)
  )
}

export function labelFromUrl(contentUrl: string): string {
  try {
    return decodeURIComponent(basename(new URL(contentUrl).pathname)) || contentUrl
  } catch {
    return basename(contentUrl) || contentUrl
  }
}

/** DTO server -> baris siap simpan. `localFile` = NAMA file di folder cache (bukan path penuh). */
export function toNewItem(
  dto: PlaylistItemDto,
  localFile: string | null,
  status: DownloadStatus
): NewPlaylistItem {
  return {
    slotNumber: dto.slot_number,
    slotsUsed: Array.isArray(dto.slots_used) ? dto.slots_used.filter(Number.isInteger) : [],
    contentId: dto.content_id,
    contentLabel: str(dto.content_label) ?? labelFromUrl(dto.content_url),
    contentUrl: dto.content_url,
    mediaType: inferMediaType(dto.content_url, dto.media_type),
    durationSeconds: dto.duration_seconds,
    fileSize:
      typeof dto.file_size === 'number' && dto.file_size > 0 ? Math.trunc(dto.file_size) : null,
    checksumSha256: str(dto.checksum_sha256)?.toLowerCase() ?? null,
    localFile,
    downloadStatus: status,
    schedule: mapSchedule(dto.schedule)
  }
}
