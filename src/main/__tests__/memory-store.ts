import type {
  DownloadStatus,
  NewPlaylistItem,
  PlaylistMeta,
  PlaylistStore,
  StoredPlaylist,
  StoredPlaylistItem
} from '../db/playlist-store'

/** Implementasi PlaylistStore di memori, untuk menguji logika sync tanpa modul native SQLite. */
export class MemoryPlaylistStore implements PlaylistStore {
  playlist: StoredPlaylist | null = null
  state = new Map<string, string>()
  activations = 0
  private nextId = 1

  getActivePlaylist(): StoredPlaylist | null {
    return this.playlist ? structuredClone(this.playlist) : null
  }

  getActiveVersion(): string | null {
    return this.playlist?.versionHash ?? null
  }

  activatePlaylist(meta: PlaylistMeta, items: NewPlaylistItem[]): StoredPlaylist {
    this.activations++
    const stored: StoredPlaylistItem[] = items.map((item) => ({ ...item, id: this.nextId++ }))
    this.playlist = { id: this.nextId++, ...meta, items: stored }
    return structuredClone(this.playlist)
  }

  updateItem(
    itemId: number,
    patch: { localFile: string | null; downloadStatus: DownloadStatus }
  ): void {
    const item = this.playlist?.items.find((i) => i.id === itemId)
    if (item) {
      item.localFile = patch.localFile
      item.downloadStatus = patch.downloadStatus
    }
  }

  clearPlaylists(): void {
    this.playlist = null
  }

  getState(key: string): string | null {
    return this.state.get(key) ?? null
  }

  setState(key: string, value: string): void {
    this.state.set(key, value)
  }

  deleteState(key: string): void {
    this.state.delete(key)
  }
}
