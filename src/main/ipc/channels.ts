/** Nama kanal IPC. Dipakai bersama oleh main (handler) dan preload (pemanggil). */
export const IPC = {
  getDeviceState: 'device:get-state',
  activate: 'device:activate',
  resetIdentity: 'device:reset-identity',
  deviceStateChanged: 'device:state-changed',
  getDiagnostics: 'diagnostics:get'
} as const
