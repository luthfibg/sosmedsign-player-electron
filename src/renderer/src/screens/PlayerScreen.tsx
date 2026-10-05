import { useEffect, useRef, useState } from 'react'
import { PlaybackEngine, type EngineState } from '../player/engine'

/** Laporan ke main bersifat best-effort: kegagalan IPC tidak boleh mengganggu pemutaran. */
const ignore = (): void => {}

interface Props {
  state: DeviceStateDto
}

/** Layar pemutar: tiga lapisan bertumpuk (video A, video B, gambar) yang diatur penuh oleh PlaybackEngine. */
function PlayerScreen({ state }: Props): React.JSX.Element {
  const videoA = useRef<HTMLVideoElement>(null)
  const videoB = useRef<HTMLVideoElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const [engineState, setEngineState] = useState<EngineState>('waiting')

  useEffect(() => {
    if (!videoA.current || !videoB.current || !image.current) return
    const engine = new PlaybackEngine(
      { videos: [videoA.current, videoB.current], image: image.current },
      {
        onStateChange: (state) => {
          setEngineState(state)
          void window.api.reportPlayerStatus({ state }).catch(ignore)
        },
        onItemStarted: (item) => {
          void window.api.reportPlayerStatus({ state: 'playing', label: item.label }).catch(ignore)
        },
        onItemCompleted: (item, info) => {
          void window.api
            .reportItemCompleted({
              contentId: item.contentId,
              label: item.label,
              startedAt: info.startedAt.toISOString(),
              playedSeconds: info.playedSeconds
            })
            .catch(ignore)
        },
        onLog: (message) => void window.api.logPlayer(message)
      }
    )

    let cancelled = false
    window.api.getPlaylist().then((playlist) => {
      if (!cancelled) engine.setPlaylist(playlist)
    })
    const unsubscribe = window.api.onPlaylistChanged((playlist) => engine.setPlaylist(playlist))

    return () => {
      cancelled = true
      unsubscribe()
      engine.destroy()
      void window.api.reportPlayerStatus({ state: 'waiting' }).catch(ignore)
    }
  }, [])

  return (
    <div className="player">
      <video ref={videoA} className="layer" />
      <video ref={videoB} className="layer" />
      <img ref={image} className="layer" alt="" />
      {engineState === 'waiting' && (
        <div className="splash">
          <div className="splash-title">SosmedSign</div>
          <div className="splash-sub">
            {state.deviceName ?? 'Perangkat terdaftar'} · Menunggu konten dari server…
          </div>
        </div>
      )}
    </div>
  )
}

export default PlayerScreen
