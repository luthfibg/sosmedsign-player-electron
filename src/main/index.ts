import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { loadConfig } from './config'
import { openDatabase, type Db } from './db/database'
import { registerIpc } from './ipc/register-ipc'
import { ApiClient } from './services/api-client'
import { CredentialStore } from './services/credential-store'
import { DeviceService } from './services/device-service'
import { Diagnostics } from './services/diagnostics'
import { createSafeStorageCipher } from './services/electron-cipher'

// Video/gambar harus bisa autoplay tanpa interaksi pengguna (signage tanpa keyboard/mouse).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow: BrowserWindow | null = null
let db: Db | null = null
let apiClient: ApiClient | null = null
let disposeIpc: (() => void) | null = null

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
    disposeIpc = registerIpc({ deviceService, diagnostics })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    disposeIpc?.()
    void apiClient?.close()
    db?.close()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
