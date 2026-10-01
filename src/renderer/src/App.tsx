import { useCallback, useEffect, useState } from 'react'
import ActivationScreen from './screens/ActivationScreen'
import DiagnosticsOverlay from './screens/DiagnosticsOverlay'
import PlayerScreen from './screens/PlayerScreen'

function App(): React.JSX.Element {
  const [state, setState] = useState<DeviceStateDto | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.getDeviceState().then((s) => {
      if (!cancelled) setState(s)
    })
    const unsubscribe = window.api.onDeviceStateChanged(setState)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Pintasan keyboard pengganti tombol INFO/MENU di remote Android: Ctrl+Shift+D.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setDiagnosticsOpen((open) => !open)
      } else if (event.key === 'Escape') {
        setDiagnosticsOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const closeDiagnostics = useCallback(() => setDiagnosticsOpen(false), [])

  if (!state) return <div className="screen" />

  return (
    <>
      {state.registered ? <PlayerScreen state={state} /> : <ActivationScreen state={state} />}
      {diagnosticsOpen && <DiagnosticsOverlay onClose={closeDiagnostics} />}
    </>
  )
}

export default App
