interface Props {
  state: DeviceStateDto
}

/** Placeholder M1. Pemutar video/gambar dibuat di M3. */
function PlayerScreen({ state }: Props): React.JSX.Element {
  return (
    <div className="screen center">
      <div className="card">
        <h1>Perangkat terdaftar ✓</h1>
        <p className="muted">
          {state.deviceName ?? 'Tanpa nama'} · Venue {state.venueId ?? '-'}
        </p>
        <p className="footnote">Pemutar konten akan tersedia di milestone M3.</p>
      </div>
    </div>
  )
}

export default PlayerScreen
