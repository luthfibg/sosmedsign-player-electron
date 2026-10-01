import { BrowserWindow, ipcMain } from 'electron'
import type { DeviceService } from '../services/device-service'
import type { Diagnostics } from '../services/diagnostics'
import type { SyncService } from '../services/sync-service'
import { IPC } from './channels'

interface IpcDeps {
  deviceService: DeviceService
  diagnostics: Diagnostics
  syncService: SyncService
  isOnline: () => boolean
}

/** Mendaftarkan handler IPC dan meneruskan perubahan state device ke semua jendela. Mengembalikan fungsi dispose. */
export function registerIpc({
  deviceService,
  diagnostics,
  syncService,
  isOnline
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
      playback: { state: 'unknown', detail: 'Indikator playback tersedia setelah M3' }
    }
  })

  const unsubscribe = deviceService.onStateChange((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.deviceStateChanged, state)
    }
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.getDeviceState)
    ipcMain.removeHandler(IPC.activate)
    ipcMain.removeHandler(IPC.resetIdentity)
    ipcMain.removeHandler(IPC.getDiagnostics)
    ipcMain.removeHandler(IPC.getDiagnosticIndicators)
  }
}
