/**
 * Penyimpanan playlist lokal (antarmuka). Implementasi SQLite ada di sqlite-playlist-store.ts;
 * tes memakai implementasi in-memory supaya logika sync bisa diuji tanpa modul native.
 */

export type DownloadStatus = 'PENDING' | 'READY' | 'FAILED'
export type MediaType = 'video' | 'image'

export interface ItemSchedule {
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

export interface NewPlaylistItem {
  slotNumber: number
  slotsUsed: number[]
  contentId: number
  contentLabel: string | null
  contentUrl: string
  mediaType: MediaType
  durationSeconds: number
  fileSize: number | null
  checksumSha256: string | null
  /** Nama file di direktori cache (bukan path penuh), null kalau belum/gagal diunduh. */
  localFile: string | null
  downloadStatus: DownloadStatus
  schedule: ItemSchedule | null
}

export interface StoredPlaylistItem extends NewPlaylistItem {
  id: number
}

export interface PlaylistMeta {
  versionHash: string
  generatedAt: string
  slotDurationSeconds: number
}

export interface StoredPlaylist extends PlaylistMeta {
  id: number
  items: StoredPlaylistItem[]
}

export interface PlaylistStore {
  getActivePlaylist(): StoredPlaylist | null
  /** Hanya version_hash playlist aktif (murah; dipakai tiap siklus sync). */
  getActiveVersion(): string | null
  /**
   * Menjadikan playlist baru satu-satunya yang aktif, ATOMIK (satu transaksi): tidak pernah ada kondisi
   * tanpa playlist aktif maupun dua playlist aktif. Playlist lama dihapus.
   */
  activatePlaylist(meta: PlaylistMeta, items: NewPlaylistItem[]): StoredPlaylist
  updateItem(
    itemId: number,
    patch: { localFile: string | null; downloadStatus: DownloadStatus }
  ): void
  /** Menghapus semua playlist dan item. TIDAK menyentuh antrean statistik tayang. */
  clearPlaylists(): void

  getState(key: string): string | null
  setState(key: string, value: string): void
  deleteState(key: string): void
}
