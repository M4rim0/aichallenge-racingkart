import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { closeAppDatabase, openAppDatabase } from './db/app-database'
import { createAppContext } from './app-context'
import { applySessionSecurity, disableExternalOpen, hardenWebContents } from './security'
import { registerIpcHandlers } from './ipc/register'

// オフライン運用（仕様 §1.2, §17「不要なオンライン通信」禁止）：
// Chromium のコンポーネント更新・バックグラウンド通信を無効化する
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-domain-reliability')

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
    let db
    try {
      db = openAppDatabase(app.getPath('userData')).db
    } catch (e) {
      // DB を開けない状態で記録操作を受け付けると記録が失われるため、起動を中止する
      dialog.showErrorBox('データベースを開けませんでした', String(e))
      app.exit(1)
      return
    }
    // TODO(段階4): 時刻関数をマスタークロックに差し替える
    registerIpcHandlers(createAppContext(db, () => Date.now()))
    createMainWindow()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('will-quit', () => {
    closeAppDatabase()
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
