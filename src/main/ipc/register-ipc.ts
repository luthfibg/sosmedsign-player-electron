import { BrowserWindow, ipcMain } from 'electron'
import type { DeviceService } from '../services/device-service'
import type { Diagnostics } from '../services/diagnostics'
import type { SyncService } from '../services/sync-service'
import { IPC } from './channels'
import { isPlaybackEvent, isPlayerStatus } from './validators'

interface IpcDeps {
  deviceService: DeviceService
  diagnostics: Diagnostics
  syncService: SyncService
  isOnline: () => boolean
  /** Playlist yang siap diputar (null = belum ada playlist sama sekali). */
  getPlayerPlaylist: () => PlayerPlaylistDto | null
  onPlaylistChanged: (listener: () => void) => () => void
  /** Mencatat satu tayang selesai ke antrean statistik. */
  recordPlayback: (event: PlaybackEventDto) => void
  updatePlayerStatus: (status: PlayerStatusDto) => void
  getPlaybackIndicator: () => DiagnosticIndicatorDto
}

/** Mendaftarkan handler IPC dan meneruskan perubahan state device ke semua jendela. Mengembalikan fungsi dispose. */
export function registerIpc({
  deviceService,
  diagnostics,
  syncService,
  isOnline,
  getPlayerPlaylist,
  onPlaylistChanged,
  recordPlayback,
  updatePlayerStatus,
  getPlaybackIndicator
}: IpcDeps): () => void {
  ipcMain.handle(IPC.getDeviceState, (): DeviceStateDto => deviceService.getState())

  ipcMain.handle(IPC.activate, async (_event, code: unknown): Promise<ActivationResultDto> => {
    if (typeof code !== 'string') return { ok: false, message: 'Kode aktivasi tidak valid.' }
    const outcome = await deviceService.activate(code)
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message }
  })

  ipcMain.handle(IPC.resetIdentity, (): void => deviceService.resetIdentity())
  ipcMain.handle(IPC.getDiagnostics, (): string[] => diagnostics.snapshot())
  ipcMain.handle(IPC.getDiagnosticIndicators, (): DiagnosticsIndicatorsDto => {
    const online = isOnline()
    return {
      online: {
        state: online ? 'active' : 'inactive',
        detail: online ? 'Jaringan terdeteksi' : 'Jaringan tidak terdeteksi'
      },
      ...syncService.getDiagnosticIndicators(online, deviceService.getState().registered),
      playback: getPlaybackIndicator()
    }
  })
  ipcMain.handle(IPC.getPlaylist, (): PlayerPlaylistDto | null => getPlayerPlaylist())
  ipcMain.handle(IPC.itemCompleted, (_event, event: unknown): void => {
    if (isPlaybackEvent(event)) recordPlayback(event)
  })
  ipcMain.handle(IPC.playerStatus, (_event, status: unknown): void => {
    if (isPlayerStatus(status)) updatePlayerStatus(status)
  })
  ipcMain.handle(IPC.logPlayer, (_event, message: unknown): void => {
    if (typeof message === 'string') diagnostics.log(`Player: ${message.slice(0, 300)}`)
  })

  const unsubscribe = deviceService.onStateChange((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.deviceStateChanged, state)
    }
  })

  const unsubscribePlaylist = onPlaylistChanged(() => {
    const playlist = getPlayerPlaylist()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.playlistChanged, playlist)
    }
  })

  return () => {
    unsubscribe()
    unsubscribePlaylist()
    ipcMain.removeHandler(IPC.getDeviceState)
    ipcMain.removeHandler(IPC.activate)
    ipcMain.removeHandler(IPC.resetIdentity)
    ipcMain.removeHandler(IPC.getDiagnostics)
    ipcMain.removeHandler(IPC.getDiagnosticIndicators)
    ipcMain.removeHandler(IPC.getPlaylist)
    ipcMain.removeHandler(IPC.logPlayer)
    ipcMain.removeHandler(IPC.itemCompleted)
    ipcMain.removeHandler(IPC.playerStatus)
  }
}
