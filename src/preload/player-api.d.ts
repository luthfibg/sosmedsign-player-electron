export {}

/**
 * Tipe API yang diekspos preload ke renderer (window.api). Dideklarasikan global supaya bisa
 * dipakai bersama oleh main, preload, dan renderer tanpa mengubah tsconfig.
 */
declare global {
  interface DeviceStateDto {
    registered: boolean
    /** UUID permanen perangkat (bukan rahasia). */
    deviceCode: string
    venueId: number | null
    deviceName: string | null
  }

  type ActivationResultDto = { ok: true } | { ok: false; message: string }

  interface PlayerApi {
    getDeviceState(): Promise<DeviceStateDto>
    activate(activationCode: string): Promise<ActivationResultDto>
    resetIdentity(): Promise<void>
    getDiagnostics(): Promise<string[]>
    /** Mengembalikan fungsi untuk berhenti berlangganan. */
    onDeviceStateChanged(callback: (state: DeviceStateDto) => void): () => void
  }

  interface Window {
    api: PlayerApi
  }
}
