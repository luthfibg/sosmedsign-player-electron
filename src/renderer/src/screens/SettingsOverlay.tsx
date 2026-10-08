import { useCallback, useEffect, useState } from 'react'

interface Props {
  onClose: () => void
}

type Outcome = { ok: boolean; message: string }

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="settings-row">
      <span className="muted">{label}</span>
      <span className="settings-value">{children}</span>
    </div>
  )
}

/** Menu Pengaturan (Ctrl+Shift+S): status perangkat, penyimpanan, folder cache, dan tindakan manual. */
function SettingsOverlay({ onClose }: Props): React.JSX.Element {
  const [overview, setOverview] = useState<SettingsOverviewDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [preview, setPreview] = useState<CacheDirPreviewDto | null>(null)
  const [mode, setMode] = useState<CacheDirModeDto>('move')
  const [confirmRelease, setConfirmRelease] = useState(false)

  const refresh = useCallback(() => {
    window.api
      .getSettingsOverview()
      .then((value) => {
        setOverview(value)
        setLoadError(null)
      })
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : String(error))
      )
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [refresh])

  const run = async (name: string, action: () => Promise<Outcome>): Promise<void> => {
    if (busy) return
    setBusy(name)
    setOutcome(null)
    try {
      setOutcome(await action())
    } catch (error) {
      setOutcome({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const checkPath = async (path: string): Promise<void> => {
    setPathInput(path)
    setPreview(null)
    if (path.trim().length === 0) return
    try {
      setPreview(await window.api.previewCacheDir(path.trim()))
    } catch (error) {
      setOutcome({ ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const choose = async (): Promise<void> => {
    const picked = await window.api.chooseCacheDir(
      pathInput.trim() || overview?.storage.cacheDir || null
    )
    if (picked) await checkPath(picked)
  }

  const apply = (path: string): Promise<void> =>
    run('folder', async () => {
      const result = await window.api.changeCacheDir(path, mode)
      if (result.ok) {
        setPreview(null)
        setPathInput('')
      }
      return result
    })

  const storage = overview?.storage
  const diskUsedPercent =
    storage && storage.diskTotalBytes && storage.diskFreeBytes !== null
      ? Math.round(
          ((storage.diskTotalBytes - storage.diskFreeBytes) / storage.diskTotalBytes) * 100
        )
      : null
  const usingCustom = overview ? overview.settings.customCacheDir !== null : false

  return (
    <div className="overlay settings-overlay">
      <div className="overlay-header">
        <h2>Pengaturan</h2>
        <div className="row">
          <button onClick={onClose}>Tutup (Esc)</button>
        </div>
      </div>

      {loadError && <p className="error">Gagal memuat data: {loadError}</p>}
      {!overview && !loadError && <p className="muted">Memuat…</p>}

      {overview && storage && (
        <div className="settings-body">
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Perangkat</h3>
              <Row label="Status">
                {overview.device.registered ? 'Terdaftar' : 'Belum terdaftar'}
              </Row>
              <Row label="Nama">{overview.device.deviceName ?? '-'}</Row>
              <Row label="Venue">{overview.device.venueId ?? '-'}</Row>
              <Row label="ID perangkat">
                <code title={overview.device.deviceCode}>
                  {overview.device.deviceCode.slice(0, 8)}
                </code>
              </Row>
              <Row label="Versi">
                {overview.app.version} (Electron {overview.app.electron})
              </Row>
              <Row label="Server">
                <code>{overview.app.backendUrl}</code>
              </Row>
              <Row label="Sinkronisasi">{overview.sync.detail}</Row>
            </section>

            <section className="settings-card">
              <h3>Sistem</h3>
              <Row label="Memori aplikasi">{formatBytes(overview.system.appBytes)}</Row>
              <Row label="Memori sistem">
                {formatBytes(overview.system.systemTotalBytes - overview.system.systemFreeBytes)}{' '}
                dari {formatBytes(overview.system.systemTotalBytes)}
              </Row>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={overview.settings.keepScreenOn}
                  onChange={(event) =>
                    void window.api.setKeepScreenOn(event.target.checked).then(refresh)
                  }
                />
                Jaga layar tetap menyala (keep screen on)
              </label>
            </section>

            <section className="settings-card">
              <h3>Penyimpanan</h3>
              <Row label="Cache konten">
                {storage.cacheFiles} file, {formatBytes(storage.cacheBytes)}
              </Row>
              <Row label="Tidak terpakai">
                {storage.orphanFiles} file, {formatBytes(storage.orphanBytes)}
              </Row>
              <Row label="Disk kosong">
                {formatBytes(storage.diskFreeBytes)} dari {formatBytes(storage.diskTotalBytes)}
              </Row>
              {diskUsedPercent !== null && (
                <div className="bar" aria-label={`Disk terpakai ${diskUsedPercent}%`}>
                  <div
                    className={`bar-fill${diskUsedPercent >= 90 ? ' bar-danger' : ''}`}
                    style={{ width: `${diskUsedPercent}%` }}
                  />
                </div>
              )}
              <Row label="Playlist">
                {storage.itemsTotal} item ({storage.itemsReady} siap, {storage.itemsFailed} gagal)
              </Row>
              <Row label="Database">{formatBytes(storage.dbBytes)}</Row>
              <Row label="Statistik antre">{storage.pendingPlaybackLogs} baris</Row>
            </section>

            <section className="settings-card">
              <h3>Tindakan</h3>
              <div className="settings-actions">
                <button
                  disabled={busy !== null}
                  onClick={() => void run('sync', () => window.api.forceSync())}
                >
                  {busy === 'sync' ? 'Menyinkronkan…' : 'Sync ulang paksa'}
                </button>
                <button
                  disabled={busy !== null}
                  onClick={() => void run('clean', () => window.api.cleanCache())}
                >
                  {busy === 'clean' ? 'Membersihkan…' : 'Bersihkan cache sekarang'}
                </button>
                <button
                  disabled={busy !== null}
                  onClick={() => void run('verify', () => window.api.verifyCache())}
                >
                  {busy === 'verify' ? 'Memeriksa…' : 'Verifikasi file cache'}
                </button>
              </div>
              {overview.device.registered &&
                (confirmRelease ? (
                  <div className="settings-confirm">
                    <span className="muted">
                      Device dilepas dari CMS dan konten lokal dihapus. Yakin?
                    </span>
                    <div className="row">
                      <button
                        className="danger"
                        disabled={busy !== null}
                        onClick={() =>
                          void run('release', async () => {
                            const result = await window.api.releaseDevice()
                            setConfirmRelease(false)
                            if (result.ok) onClose()
                            return result
                          })
                        }
                      >
                        {busy === 'release' ? 'Melepas…' : 'Ya, lepaskan'}
                      </button>
                      <button onClick={() => setConfirmRelease(false)}>Batal</button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="danger"
                    disabled={busy !== null}
                    onClick={() => setConfirmRelease(true)}
                  >
                    Lepaskan device
                  </button>
                ))}
            </section>

            <section className="settings-card settings-wide">
              <h3>Folder cache</h3>
              <Row label="Folder saat ini">
                <code>{storage.cacheDir}</code> {usingCustom ? '(khusus)' : '(bawaan)'}
              </Row>
              {overview.settings.cacheDirFallbackReason && (
                <p className="notice">
                  Folder khusus <code>{overview.settings.customCacheDir}</code> tidak bisa dipakai:{' '}
                  {overview.settings.cacheDirFallbackReason}. Sesi ini memakai folder bawaan.
                </p>
              )}
              <div className="settings-path">
                <input
                  value={pathInput}
                  placeholder="Contoh: D:\SosmedSignCache"
                  spellCheck={false}
                  disabled={busy !== null}
                  onChange={(event) => {
                    setPathInput(event.target.value)
                    setPreview(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void checkPath(pathInput)
                  }}
                />
                <button disabled={busy !== null} onClick={() => void choose()}>
                  Pilih folder…
                </button>
                <button
                  disabled={busy !== null || pathInput.trim().length === 0}
                  onClick={() => void checkPath(pathInput)}
                >
                  Periksa
                </button>
              </div>

              {preview && !preview.ok && <p className="error">{preview.reason}</p>}
              {preview?.ok && (
                <div className="settings-preview">
                  <p>
                    {preview.isNew
                      ? 'Folder baru/kosong dan bisa dipakai.'
                      : `Folder cache SosmedSign (${preview.existingCacheFiles} file sudah ada).`}
                  </p>
                  <label className="settings-check">
                    <input
                      type="radio"
                      name="cache-mode"
                      checked={mode === 'move'}
                      onChange={() => setMode('move')}
                    />
                    Pindahkan {preview.currentFiles} file cache saat ini (
                    {formatBytes(preview.currentBytes)})
                  </label>
                  <label className="settings-check">
                    <input
                      type="radio"
                      name="cache-mode"
                      checked={mode === 'fresh'}
                      onChange={() => setMode('fresh')}
                    />
                    Mulai kosong: hapus file cache lama dan unduh ulang dari server
                  </label>
                  <button
                    className="primary-inline"
                    disabled={busy !== null}
                    onClick={() => void apply(pathInput.trim())}
                  >
                    {busy === 'folder' ? 'Memindahkan…' : 'Terapkan folder ini'}
                  </button>
                </div>
              )}
              {usingCustom && (
                <button
                  disabled={busy !== null}
                  onClick={() => void apply(overview.settings.defaultCacheDir)}
                >
                  Kembalikan ke folder bawaan
                </button>
              )}
            </section>
          </div>

          {outcome && (
            <p className={outcome.ok ? 'settings-ok' : 'error'} role="status">
              {outcome.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default SettingsOverlay
