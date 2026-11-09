import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { applySessionSecurity, disableExternalOpen, hardenWebContents } from './security'
import { registerIpcHandlers } from './ipc/register'

const devServerUrl = process.env['ELECTRON_RENDERER_URL'] ?? null
const isDev = !app.isPackaged && devServerUrl !== null

// 二重起動による DB の同時書き込みを防ぐ
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    disableExternalOpen()
    applySessionSecurity(isDev)
    registerIpcHandlers()
    createMainWindow()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // レース中にウィンドウが背面・最小化されても時計表示・処理を止めない（仕様 §16）
      backgroundThrottling: false
    }
  })

  hardenWebContents(win.webContents, isDev ? devServerUrl : null)
  win.once('ready-to-show', () => win.show())

  if (isDev && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
