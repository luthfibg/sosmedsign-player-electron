import { useState } from 'react'

const CODE_LENGTH = 8

function sanitize(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH)
}

interface Props {
  state: DeviceStateDto
}

function ActivationScreen({ state }: Props): React.JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (busy) return
    if (code.length !== CODE_LENGTH) {
      setError(`Kode aktivasi harus ${CODE_LENGTH} karakter.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.activate(code)
      if (!result.ok) setError(result.message)
      // Kalau sukses, main process mengirim state baru dan App berpindah ke layar player.
    } catch {
      setError('Terjadi kesalahan tak terduga. Coba lagi.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen center">
      <div className="card">
        <h1>SosmedSign Player</h1>
        <p className="muted">Masukkan kode aktivasi dari CMS untuk mendaftarkan perangkat ini.</p>

        <input
          className="code-input"
          value={code}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          maxLength={CODE_LENGTH}
          placeholder="••••••••"
          disabled={busy}
          onChange={(e) => setCode(sanitize(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />

        <button
          className="primary"
          disabled={busy || code.length !== CODE_LENGTH}
          onClick={() => void submit()}
        >
          {busy ? 'Mengaktifkan…' : 'Aktifkan'}
        </button>

        {error && <p className="error">{error}</p>}

        <p className="footnote">
          ID perangkat: <code>{state.deviceCode.slice(0, 8)}</code> · Diagnostik: Ctrl+Shift+D
        </p>
      </div>
    </div>
  )
}

export default ActivationScreen
