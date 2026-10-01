import { useEffect, useState } from 'react'

interface Props {
  onClose: () => void
}

function DiagnosticsOverlay({ onClose }: Props): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [indicators, setIndicators] = useState<DiagnosticsIndicatorsDto>({
    online: { state: 'unknown', detail: 'Memuat status jaringan' },
    connected: { state: 'unknown', detail: 'Memuat status CMS' },
    sync: { state: 'unknown', detail: 'Memuat status sync' },
    playback: { state: 'unknown', detail: 'Memuat status playback' }
  })
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      window.api.getDiagnostics().then((l) => {
        if (!cancelled) setLines(l)
      })
      window.api
        .getDiagnosticIndicators()
        .then((status) => {
          if (!cancelled) setIndicators(status)
        })
        .catch(() => {
          if (cancelled) return
          setIndicators({
            online: { state: 'unknown', detail: 'Status jaringan tidak tersedia' },
            connected: { state: 'unknown', detail: 'Status CMS tidak tersedia' },
            sync: { state: 'unknown', detail: 'Status sync tidak tersedia' },
            playback: { state: 'unknown', detail: 'Status playback tidak tersedia' }
          })
        })
    }
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const reset = async (): Promise<void> => {
    await window.api.resetIdentity()
    setConfirmReset(false)
  }

  const indicatorItems = [
    { label: 'Connected', status: indicators.connected },
    { label: 'Online', status: indicators.online },
    { label: 'Sync', status: indicators.sync },
    { label: 'Playback', status: indicators.playback }
  ]

  return (
    <div className="overlay">
      <div className="overlay-header">
        <h2>Log diagnostik</h2>
        <div className="row">
          {confirmReset ? (
            <>
              <span className="muted">Device akan jadi perangkat baru. Yakin?</span>
              <button className="danger" onClick={() => void reset()}>
                Ya, reset
              </button>
              <button onClick={() => setConfirmReset(false)}>Batal</button>
            </>
          ) : (
            <button className="danger" onClick={() => setConfirmReset(true)}>
              Reset identitas device
            </button>
          )}
          <button onClick={onClose}>Tutup (Esc)</button>
        </div>
      </div>
      <div className="diagnostic-output">
        <div className="diagnostic-indicators" role="status" aria-label="Status perangkat">
          {indicatorItems.map(({ label, status }) => (
            <div
              className="diagnostic-indicator"
              key={label}
              title={status.detail}
              aria-label={`${label}: ${status.detail}`}
            >
              <span className={`indicator-lamp ${status.state}`} aria-hidden="true" />
              <span>{label}</span>
            </div>
          ))}
        </div>
        <pre className="log">{lines.length === 0 ? '(belum ada log)' : lines.join('\n')}</pre>
      </div>
    </div>
  )
}

export default DiagnosticsOverlay
