import { useEffect, useState } from 'react'

interface Props {
  onClose: () => void
}

function DiagnosticsOverlay({ onClose }: Props): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      window.api.getDiagnostics().then((l) => {
        if (!cancelled) setLines(l)
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
      <pre className="log">{lines.length === 0 ? '(belum ada log)' : lines.join('\n')}</pre>
    </div>
  )
}

export default DiagnosticsOverlay
