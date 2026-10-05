import type { StoredPlaylist } from '../db/playlist-store'

/**
 * Playlist untuk renderer: hanya item yang bisa diputar (READY dan punya file cache), tanpa path disk.
 * Urutan mengikuti slot_number dari server. Penyaringan jadwal dilakukan di renderer (jam berjalan terus).
 */
export function toPlayerPlaylist(
  playlist: StoredPlaylist | null,
  mediaUrlOf: (fileName: string) => string
): PlayerPlaylistDto | null {
  if (!playlist) return null
  const items: PlayerItemDto[] = []
  for (const item of playlist.items) {
    if (item.downloadStatus !== 'READY' || !item.localFile) continue
    items.push({
      id: item.id,
      contentId: item.contentId,
      label: item.contentLabel ?? `Konten ${item.contentId}`,
      mediaType: item.mediaType,
      durationSeconds:
        item.durationSeconds > 0 ? item.durationSeconds : playlist.slotDurationSeconds,
      mediaUrl: mediaUrlOf(item.localFile),
      schedule: item.schedule
    })
  }
  return {
    versionHash: playlist.versionHash,
    slotDurationSeconds: playlist.slotDurationSeconds,
    items
  }
}
