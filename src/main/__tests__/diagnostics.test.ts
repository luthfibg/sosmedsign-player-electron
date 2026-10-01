import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DIAGNOSTICS_MAX_ENTRIES } from '../config'
import { Diagnostics } from '../services/diagnostics'
import { makeTempDir, registerTempDirCleanup } from './helpers'

registerTempDirCleanup()

describe('Diagnostics', () => {
  it('memformat entri HH:mm:ss  pesan', () => {
    const d = new Diagnostics(null, () => new Date(2026, 8, 30, 7, 5, 9))
    d.log('halo')
    expect(d.snapshot()).toEqual(['07:05:09  halo'])
  })

  it('membatasi ring buffer dan membuang entri terlama', () => {
    const d = new Diagnostics(null)
    for (let i = 0; i < DIAGNOSTICS_MAX_ENTRIES + 30; i++) d.log(`baris ${i}`)
    const snap = d.snapshot()
    expect(snap).toHaveLength(DIAGNOSTICS_MAX_ENTRIES)
    expect(snap[0]).toContain('baris 30')
    expect(snap.at(-1)).toContain(`baris ${DIAGNOSTICS_MAX_ENTRIES + 29}`)
  })

  it('clear() mengosongkan buffer', () => {
    const d = new Diagnostics(null)
    d.log('x')
    d.clear()
    expect(d.snapshot()).toEqual([])
  })

  it('menulis ke file log', () => {
    const dir = makeTempDir()
    const d = new Diagnostics(dir)
    d.log('tercatat')
    expect(readFileSync(join(dir, 'player.log'), 'utf8')).toContain('tercatat')
  })
})
