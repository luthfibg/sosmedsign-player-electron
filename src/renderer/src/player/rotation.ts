import { isPlayableNow, type ScheduleLike } from './schedule'

interface Rotatable {
  schedule: ScheduleLike | null
}

/**
 * Item berikutnya yang boleh tayang setelah `afterIndex`, berputar kembali ke awal (item `afterIndex` sendiri
 * dicek terakhir, jadi satu-satunya item yang tayang akan berulang). -1 kalau tidak ada yang boleh tayang.
 * `afterIndex = -1` berarti mulai dari item pertama.
 */
export function findNextPlayable(
  items: readonly Rotatable[],
  afterIndex: number,
  now: Date
): number {
  const count = items.length
  for (let step = 1; step <= count; step++) {
    const index = (((afterIndex + step) % count) + count) % count
    if (isPlayableNow(items[index].schedule, now)) return index
  }
  return -1
}

export function countPlayable(items: readonly Rotatable[], now: Date): number {
  return items.filter((item) => isPlayableNow(item.schedule, now)).length
}
