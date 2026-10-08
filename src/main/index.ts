import { app, shell, BrowserWindow, dialog, net, powerSaveBlocker, protocol } from 'electron'
import { totalmem, freemem } from 'os'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { loadConfig } from './config'
import { openDatabase, type Db } from './db/database'
import { SqlitePlaybackLogStore } from './db/playback-log-store'
import { SqlitePlaylistStore } from './db/sqlite-playlist-store'
import { registerIpc } from './ipc/register-ipc'
import { ApiClient } from './services/api-client'
import { CredentialStore } from './services/credential-store'
import { DeviceService } from './services/device-service'
import { Diagnostics } from './services/diagnostics'
import { createSafeStorageCipher } from './services/electron-cipher'
import { chooseCacheDir } from './services/cache-dir'
import { CacheManager } from './services/cache-manager'
import { MaintenanceService } from './services/maintenance-service'
import { SettingsStore } from './services/settings-store'
import { StorageStats } from './services/storage-stats'
import { PlaybackReporter } from './services/playback-reporter'
import { PlaybackStatus } from './services/playback-status'
import { SyncService } from './services/sync-service'
import { MEDIA_SCHEME, mediaUrlFor, serveMediaRequest } from './services/media-protocol'
import { toPlayerPlaylist } from './services/playlist-presenter'

// Protokol media harus didaftarkan SEBELUM app ready. Renderer memutar file cache lewat sosmedsign-media://media/<file>.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// Video/gambar harus bisa autoplay tanpa interaksi pengguna (signage tanpa keyboard/mouse).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow: BrowserWindow | null = null
let db: Db | null = null
let apiClient: ApiClient | null = null
let disposeIpc: (() => void) | null = null
let syncService: SyncService | null = null
let unsubscribeDeviceState: (() => void) | null = null
let unsubscribeCleared: (() => void) | null = null
let powerSaveBlockerId: number | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    // Produksi: kiosk layar penuh. Dev: jendela biasa supaya DevTools mudah dipakai.
    fullscreen: !is.dev,
    kiosk: !is.dev,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // Pemutaran tidak boleh melambat saat jendela dianggap tersembunyi/tertutup.
      backgroundThrottling: false,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Player hanya menampilkan UI lokal: tolak semua navigasi dan window baru.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (is.dev) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Satu instance saja: MiniPC tidak boleh menjalankan dua player sekaligus.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.solusimediakarya.sosmedsignplayer')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const userData = app.getPath('userData')
    const diagnostics = new Diagnostics(join(userData, 'logs'))
    diagnostics.log(`Player mulai (v${app.getVersion()}, Electron ${process.versions.electron})`)

    const config = loadConfig()
    diagnostics.log(
      `Backend: ${config.baseUrl}${config.hostHeader ? ` (Host ${config.hostHeader})` : ''}`
    )

    db = openDatabase(join(userData, 'player.db'))
    const credentials = new CredentialStore(
      userData,
      createSafeStorageCipher(),
      undefined,
      (message) => diagnostics.log(`Kredensial: ${message}`)
    )
    apiClient = new ApiClient(config)
    const deviceService = new DeviceService(apiClient, credentials, diagnostics)
    const settings = new SettingsStore(join(userData, 'settings.json'), (message) =>
      diagnostics.log(message)
    )
    const defaultCacheDir = join(userData, 'content_cache')
    const chosenCacheDir = chooseCacheDir(settings.get().cacheDir, defaultCacheDir)
    if (chosenCacheDir.fallbackReason) {
      diagnostics.log(
        `Folder cache khusus tidak bisa dipakai (${chosenCacheDir.fallbackReason}); memakai folder bawaan`
      )
    }
    const cacheManager = new CacheManager(chosenCacheDir.dir, config, undefined, (message) =>
      diagnostics.log(message)
    )
    const playlistStore = new SqlitePlaylistStore(db)
    const playbackStatus = new PlaybackStatus()
    const playbackReporter = new PlaybackReporter({
      store: new SqlitePlaybackLogStore(db),
      api: apiClient,
      isOnline: () => net.isOnline(),
      log: (message) => diagnostics.log(message)
    })
    syncService = new SyncService(
      playlistStore,
      apiClient,
      deviceService,
      credentials,
      cacheManager,
      diagnostics,
      { isOnline: () => net.isOnline(), reporter: playbackReporter }
    )
    const wasRegistered = deviceService.getState().registered
    // Registrasi dihapus: hentikan sync; data lokal dihapus atau dipertahankan sesuai alasannya.
    unsubscribeCleared = deviceService.onRegistrationCleared((reason) => {
      syncService?.handleRegistrationCleared(reason)
      playbackStatus.reset()
    })
    // Aktivasi berhasil: mulai sync tanpa perlu restart.
    unsubscribeDeviceState = deviceService.onStateChange((state) => {
      if (state.registered) syncService?.start()
    })
    if (wasRegistered) syncService.start()
    protocol.handle(MEDIA_SCHEME, (request) =>
      serveMediaRequest(request, (name) => cacheManager.resolveCachedFile(name))
    )
    // Layar tidak boleh mati/redup saat menayangkan konten (setara "Keep screen on" di Android); bisa dimatikan di Pengaturan.
    const applyKeepScreenOn = (on: boolean): void => {
      if (on && powerSaveBlockerId === null) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      } else if (!on && powerSaveBlockerId !== null) {
        powerSaveBlocker.stop(powerSaveBlockerId)
        powerSaveBlockerId = null
      }
    }
    applyKeepScreenOn(settings.get().keepScreenOn)

    const sync = syncService
    const maintenance = new MaintenanceService({
      cache: cacheManager,
      store: playlistStore,
      settings,
      storageStats: new StorageStats({
        cache: cacheManager,
        store: playlistStore,
        dbFile: join(userData, 'player.db'),
        pendingPlaybackLogs: () => playbackReporter.pendingCount()
      }),
      sync,
      device: deviceService,
      diagnostics,
      defaultCacheDir,
      cacheDirFallbackReason: chosenCacheDir.fallbackReason,
      backendUrl: config.baseUrl,
      isOnline: () => net.isOnline(),
      appInfo: () => ({ version: app.getVersion(), electron: process.versions.electron }),
      memory: () => ({
        appBytes: app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0),
        systemTotalBytes: totalmem(),
        systemFreeBytes: freemem()
      }),
      applyKeepScreenOn
    })
    disposeIpc = registerIpc({
      deviceService,
      diagnostics,
      syncService: sync,
      isOnline: () => net.isOnline(),
      getPlayerPlaylist: () => toPlayerPlaylist(playlistStore.getActivePlaylist(), mediaUrlFor),
      onPlaylistChanged: (listener) => sync.onPlaylistChanged(listener),
      maintenance,
      chooseDirectory: async (defaultPath) => {
        const options = {
          title: 'Pilih folder cache konten',
          defaultPath: defaultPath ?? undefined,
          properties: ['openDirectory', 'createDirectory'] as (
            'openDirectory' | 'createDirectory'
          )[]
        }
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
      },
      recordPlayback: (event) => {
        playbackReporter.record(event)
        playbackStatus.noteActivity()
      },
      updatePlayerStatus: (status) => playbackStatus.update(status.state, status.label),
      getPlaybackIndicator: () => playbackStatus.getIndicator()
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    disposeIpc?.()
    unsubscribeDeviceState?.()
    unsubscribeCleared?.()
    if (powerSaveBlockerId !== null) powerSaveBlocker.stop(powerSaveBlockerId)
    void syncService?.close()
    void apiClient?.close()
    db?.close()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
