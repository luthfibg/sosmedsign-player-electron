/** Data dari renderer tidak dipercaya begitu saja: bentuknya divalidasi sebelum masuk ke antrean/penampung status. */
export function isPlaybackEvent(value: unknown): value is PlaybackEventDto {
  if (!value || typeof value !== 'object') return false
  const e = value as Partial<PlaybackEventDto>
  return (
    Number.isInteger(e.contentId) &&
    (e.label === null || typeof e.label === 'string') &&
    typeof e.startedAt === 'string' &&
    typeof e.playedSeconds === 'number'
  )
}

export function isPlayerStatus(value: unknown): value is PlayerStatusDto {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<PlayerStatusDto>
  return (
    (s.state === 'waiting' || s.state === 'playing' || s.state === 'idle') &&
    (s.label === undefined || s.label === null || typeof s.label === 'string')
  )
}
