import { BrowserWindow, ipcMain } from 'electron'
import type { DeviceService } from '../services/device-service'
import type { Diagnostics } from '../services/diagnostics'
import type { SyncService } from '../services/sync-service'
import { IPC } from './channels'
import type { MaintenanceService } from '../services/maintenance-service'
import { isCacheDirMode, isPathInput, isPlaybackEvent, isPlayerStatus } from './validators'

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
  maintenance: MaintenanceService
  /** Dialog pilih folder (null = dibatalkan). */
  chooseDirectory: (defaultPath: string | null) => Promise<string | null>
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
  getPlaybackIndicator,
  maintenance,
  chooseDirectory
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
  ipcMain.handle(IPC.settingsOverview, (): Promise<SettingsOverviewDto> =>
    maintenance.getOverview()
  )
  ipcMain.handle(IPC.chooseCacheDir, (_event, defaultPath: unknown): Promise<string | null> =>
    chooseDirectory(isPathInput(defaultPath) ? defaultPath : null)
  )
  ipcMain.handle(IPC.previewCacheDir, (_event, path: unknown): CacheDirPreviewDto => {
    if (!isPathInput(path)) {
      return {
        ok: false,
        reason: 'Path folder tidak valid.',
        isNew: false,
        existingCacheFiles: 0,
        currentFiles: 0,
        currentBytes: 0
      }
    }
    return maintenance.previewCacheDir(path)
  })
  ipcMain.handle(
    IPC.changeCacheDir,
    (
      _event,
      path: unknown,
      mode: unknown
    ): Promise<SettingsActionResultDto> | SettingsActionResultDto =>
      isPathInput(path) && isCacheDirMode(mode)
        ? maintenance.changeCacheDir(path, mode)
        : { ok: false, message: 'Permintaan tidak valid.' }
  )
  ipcMain.handle(IPC.cleanCache, (): Promise<SettingsActionResultDto> => maintenance.cleanCache())
  ipcMain.handle(IPC.verifyCache, (): Promise<SettingsActionResultDto> => maintenance.verifyCache())
  ipcMain.handle(IPC.forceSync, (): Promise<SettingsActionResultDto> => maintenance.forceSync())
  ipcMain.handle(IPC.setKeepScreenOn, (_event, on: unknown): void => {
    if (typeof on === 'boolean') maintenance.setKeepScreenOn(on)
  })
  ipcMain.handle(IPC.releaseDevice, (): Promise<SettingsActionResultDto> =>
    maintenance.releaseDevice()
  )
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
    for (const channel of [
      IPC.settingsOverview,
      IPC.chooseCacheDir,
      IPC.previewCacheDir,
      IPC.changeCacheDir,
      IPC.cleanCache,
      IPC.verifyCache,
      IPC.forceSync,
      IPC.setKeepScreenOn,
      IPC.releaseDevice
    ]) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.removeHandler(IPC.playerStatus)
  }
}
