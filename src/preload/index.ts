import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipc/channels'

const api: PlayerApi = {
  getDeviceState: () => ipcRenderer.invoke(IPC.getDeviceState),
  activate: (activationCode) => ipcRenderer.invoke(IPC.activate, activationCode),
  resetIdentity: () => ipcRenderer.invoke(IPC.resetIdentity),
  getDiagnostics: () => ipcRenderer.invoke(IPC.getDiagnostics),
  getDiagnosticIndicators: () => ipcRenderer.invoke(IPC.getDiagnosticIndicators),
  getPlaylist: () => ipcRenderer.invoke(IPC.getPlaylist),
  logPlayer: (message) => ipcRenderer.invoke(IPC.logPlayer, message),
  getSettingsOverview: () => ipcRenderer.invoke(IPC.settingsOverview),
  chooseCacheDir: (defaultPath) => ipcRenderer.invoke(IPC.chooseCacheDir, defaultPath),
  previewCacheDir: (path) => ipcRenderer.invoke(IPC.previewCacheDir, path),
  changeCacheDir: (path, mode) => ipcRenderer.invoke(IPC.changeCacheDir, path, mode),
  cleanCache: () => ipcRenderer.invoke(IPC.cleanCache),
  verifyCache: () => ipcRenderer.invoke(IPC.verifyCache),
  forceSync: () => ipcRenderer.invoke(IPC.forceSync),
  setKeepScreenOn: (on) => ipcRenderer.invoke(IPC.setKeepScreenOn, on),
  releaseDevice: () => ipcRenderer.invoke(IPC.releaseDevice),
  reportItemCompleted: (event) => ipcRenderer.invoke(IPC.itemCompleted, event),
  reportPlayerStatus: (status) => ipcRenderer.invoke(IPC.playerStatus, status),
  onPlaylistChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      playlist: PlayerPlaylistDto | null
    ): void => callback(playlist)
    ipcRenderer.on(IPC.playlistChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.playlistChanged, listener)
    }
  },
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
