/** Nama kanal IPC. Dipakai bersama oleh main (handler) dan preload (pemanggil). */
export const IPC = {
  getDeviceState: 'device:get-state',
  activate: 'device:activate',
  resetIdentity: 'device:reset-identity',
  deviceStateChanged: 'device:state-changed',
  getDiagnostics: 'diagnostics:get',
  getDiagnosticIndicators: 'diagnostics:get-indicators',
  getPlaylist: 'player:get-playlist',
  playlistChanged: 'player:playlist-changed',
  itemCompleted: 'player:item-completed',
  settingsOverview: 'settings:overview',
  chooseCacheDir: 'settings:choose-cache-dir',
  previewCacheDir: 'settings:preview-cache-dir',
  changeCacheDir: 'settings:change-cache-dir',
  cleanCache: 'settings:clean-cache',
  verifyCache: 'settings:verify-cache',
  forceSync: 'settings:force-sync',
  setKeepScreenOn: 'settings:set-keep-screen-on',
  releaseDevice: 'device:release',
  playerStatus: 'player:status',
  logPlayer: 'player:log'
} as const
