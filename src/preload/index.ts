import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipc/channels'

const api: PlayerApi = {
  getDeviceState: () => ipcRenderer.invoke(IPC.getDeviceState),
  activate: (activationCode) => ipcRenderer.invoke(IPC.activate, activationCode),
  resetIdentity: () => ipcRenderer.invoke(IPC.resetIdentity),
  getDiagnostics: () => ipcRenderer.invoke(IPC.getDiagnostics),
  getDiagnosticIndicators: () => ipcRenderer.invoke(IPC.getDiagnosticIndicators),
  onDeviceStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DeviceStateDto): void =>
      callback(state)
    ipcRenderer.on(IPC.deviceStateChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.deviceStateChanged, listener)
    }
  }
}

// Hanya `api` yang diekspos (bukan ipcRenderer mentah) supaya renderer tidak bisa memanggil kanal sembarang.
contextBridge.exposeInMainWorld('api', api)
