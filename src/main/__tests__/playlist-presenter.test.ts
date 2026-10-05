import { describe, expect, it } from 'vitest'
import type { StoredPlaylist, StoredPlaylistItem } from '../db/playlist-store'
import { toPlayerPlaylist } from '../services/playlist-presenter'

function item(overrides: Partial<StoredPlaylistItem>): StoredPlaylistItem {
  return {
    id: 1,
    slotNumber: 1,
    slotsUsed: [1],
    contentId: 10,
    contentLabel: 'Promo',
    contentUrl: 'https://cdn/x.mp4',
    mediaType: 'video',
    durationSeconds: 15,
    fileSize: null,
    checksumSha256: null,
    localFile: 'content_10_aaaaaaaaaaaaaaaaaaaa.mp4',
    downloadStatus: 'READY',
    schedule: null,
    ...overrides
  }
}

const playlist = (items: StoredPlaylistItem[]): StoredPlaylist => ({
  id: 1,
  versionHash: 'v1',
  generatedAt: 'x',
  slotDurationSeconds: 12,
  items
})

const urlOf = (name: string): string => `media://${name}`

describe('toPlayerPlaylist', () => {
  it('returns null when there is no playlist at all', () => {
    expect(toPlayerPlaylist(null, urlOf)).toBeNull()
  })

  it('keeps only READY items with a local file and never exposes disk paths', () => {
    const result = toPlayerPlaylist(
      playlist([
        item({ id: 1 }),
        item({ id: 2, downloadStatus: 'FAILED', localFile: null }),
        item({ id: 3, downloadStatus: 'PENDING', localFile: 'content_3_bbbbbbbbbbbbbbbbbbbb.mp4' }),
        item({ id: 4, localFile: null })
      ]),
      urlOf
    )
    expect(result?.items.map((i) => i.id)).toEqual([1])
    expect(result?.items[0].mediaUrl).toBe('media://content_10_aaaaaaaaaaaaaaaaaaaa.mp4')
  })

  it('falls back to the slot duration and a generated label', () => {
    const result = toPlayerPlaylist(
      playlist([item({ durationSeconds: 0, contentLabel: null, contentId: 77 })]),
      urlOf
    )
    expect(result?.items[0]).toMatchObject({ durationSeconds: 12, label: 'Konten 77' })
  })

  it('an empty playlist is still a known playlist (not null)', () => {
    expect(toPlayerPlaylist(playlist([]), urlOf)).toEqual({
      versionHash: 'v1',
      slotDurationSeconds: 12,
      items: []
    })
  })
})
