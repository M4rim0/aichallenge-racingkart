import { join } from 'node:path'
import { app, BrowserWindow, dialog, powerMonitor, powerSaveBlocker } from 'electron'
import { closeAppDatabase, DatabaseIntegrityError, openAppDatabase } from './db/app-database'
import { createAppContext, type AppContext } from './app-context'
import { MasterClock } from './clock/master-clock'
import { registerBootSession } from './clock/session-registry'
import { createRepositories } from './repositories'
import { applySessionSecurity, disableExternalOpen, hardenWebContents } from './security'
import { registerIpcHandlers } from './ipc/register'
import { appClosingGate } from './lifecycle/closing-gate'
import { appendCleanShutdownRecord, ShutdownSequence } from './lifecycle/shutdown'
import { SuspendTracker } from './lifecycle/suspend-tracker'
import { ReloadLimiter } from './lifecycle/reload-limiter'
import { formatJst } from '@shared/time/jst'

// オフライン運用（仕様 §1.2, §17「不要なオンライン通信」禁止）：
// Chromium のコンポーネント更新・バックグラウンド通信を無効化する
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-domain-reliability')

// マスタークロックはできるだけ早く（プロセス開始直後に）アンカーを取得する
const masterClock = new MasterClock()

const devServerUrl = process.env['ELECTRON_RENDERER_URL'] ?? null
const isDev = !app.isPackaged && devServerUrl !== null

/** Windows のシャットダウン・ログオフ中（確認ダイアログを出さない、D-067） */
let osSessionEnding = false
/** レース中の終了をユーザーが確認済み（D-067） */
let quitConfirmed = false
let ctx: AppContext | null = null
let shutdown: ShutdownSequence | null = null

// メインプロセスの想定外のエラーは記録して表示する（記録済みのデータは DB にあり失われない）
process.on('uncaughtException', (e) => {
  console.error('[main] uncaughtException', e)
  if (!appClosingGate.isClosing()) dialog.showErrorBox('予期しないエラーが発生しました', `${String(e)}\n\n記録済みのデータは保存されています。`)
})
process.on('unhandledRejection', (e) => console.error('[main] unhandledRejection', e))

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
    let opened
    try {
      opened = openAppDatabase(app.getPath('userData'))
    } catch (e) {
      // DB を開けない・整合性に異常がある状態で記録操作を受け付けると記録が失われるため、起動を中止する（D-065）
      // 整合性に異常がある場合、DB は書き込み可能な状態では開いておらず、元のファイル・WAL は変更していない
      if (e instanceof DatabaseIntegrityError) {
        dialog.showErrorBox('データベースに異常があるため起動を中止しました', e.message)
      } else {
        dialog.showErrorBox('データベースを開けませんでした', String(e))
      }
      app.exit(1)
      return
    }
    const { db, status } = opened
    const session = registerBootSession(
      db,
      createRepositories(db, () => masterClock.now(), masterClock.bootSessionId),
      masterClock,
      app.getVersion()
    )
    ctx = createAppContext(db, masterClock, session, { powerBlocker: powerSaveBlocker })
    const context = ctx
    registerIpcHandlers(context)

    // 正常終了の手順（D-066）：電源解除 → DB クローズ → クローズできた場合のみ正常終了を記録
    shutdown = new ShutdownSequence({
      gate: appClosingGate,
      releasePower: () => context.power.release(),
      closeAppDb: () => closeAppDatabase(),
      writeCleanShutdown: () =>
        appendCleanShutdownRecord(status.path, {
          bootSessionId: masterClock.bootSessionId,
          at: masterClock.now(),
          wallAt: masterClock.wallNow(),
          monoMs: masterClock.monoNow()
        }),
      log: (m, e) => console.error(`[shutdown] ${m}`, e)
    })

    // 異常終了後の再起動では、進行中だった大会を復旧確認待ちにする（D-070）。正常終了後は何もしない。
    // 大会の状態・時計の操作記録は変更しない（時計は実際の経過時間に合わせて進み続ける）
    context.recovery.holdAfterUncleanShutdown(context.previousShutdown)

    // 異常終了後の再起動でも、進行中のレースがあれば電源の抑制を復元する（D-063）。復旧確認待ちの間も維持する
    context.power.reconcile()

    // スリープ・休止からの復帰（D-064）：警告と記録のみ。時計・レース時間は補正しない
    const suspend = new SuspendTracker(masterClock, context.repos.lifecycle, appClosingGate)
    powerMonitor.on('suspend', () => {
      try {
        suspend.onSuspend()
      } catch (e) {
        console.error('[suspend] record failed', e)
      }
    })
    powerMonitor.on('resume', () => {
      try {
        const ev = suspend.onResume()
        const win = BrowserWindow.getAllWindows()[0]
        if (ev?.anomaly && win) {
          void dialog.showMessageBox(win, {
            type: 'warning',
            title: 'スリープ・休止からの復帰で時刻のずれを検出しました',
            message: 'PCの実日時とマスタークロックのずれが 5 秒を超えて変化しました。',
            detail: `${ev.detail ?? ''}\n\nレース時間・記録の日時は自動補正しません。復帰後の記録は時刻異常の可能性があるものとして識別できます。`
          })
        }
      } catch (e) {
        console.error('[resume] record failed', e)
      }
    })

    const win = createMainWindow(context)
    if (session.clockAnomaly) {
      // D-013：警告のみ。保存済みの日時は書き換えない
      void dialog.showMessageBox(win, {
        type: 'warning',
        title: 'PCの時刻に異常があります',
        message: 'PCの時刻が、保存済みの記録より過去になっています。',
        detail: `${session.anomalyDetail ?? ''}\n\n記録の日時は自動補正しません。PCの時刻設定を確認してください。この起動中の記録は異常のあったセッションとして識別できます。`
      })
    }
    if (context.previousShutdown && !context.previousShutdown.clean) {
      // D-066：前回の異常終了を通知（確定済みの記録は保存されている）
      void dialog.showMessageBox(win, {
        type: 'warning',
        title: '前回は正常に終了しませんでした',
        message: '前回の起動は、正常終了の記録がないまま終了しています（異常終了・強制終了・電源断の可能性）。',
        detail: `前回の起動：${formatJst(context.previousShutdown.startedWallAt)}\n\n確定済みの記録は保存されています。時計は停止していた時間も含めて実際の経過時間で進んでいます（一時停止中だった大会は一時停止のままです）。\n\n${
          context.recovery.listPending().length > 0
            ? `次の大会は「復旧確認待ち」です。復旧を確認するまで、ラップ登録・通過登録・時計操作などは受け付けません：\n${context.recovery
                .listPending()
                .map((h) => `・${h.eventName}（${h.eventStatus === 'RUNNING' ? '走行中' : '一時停止中'}）`)
                .join('\n')}`
            : '進行中だった大会はありません。'
        }`
      })
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('will-quit', () => {
    shutdown?.run()
  })
}

function hasActiveRace(context: AppContext): boolean {
  if (appClosingGate.isClosing()) return false
  return context.power.status().eventIds.length > 0 || context.repos.events.listAll().some((e) => e.status === 'RUNNING' || e.status === 'PAUSED')
}

function createMainWindow(context: AppContext): BrowserWindow {
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

  // Windows のシャットダウン・ログオフ（D-067）：確認ダイアログを出さず、正常終了の手順で閉じる
  win.on('query-session-end', () => {
    osSessionEnding = true
  })
  win.on('session-end', () => {
    osSessionEnding = true
    shutdown?.run()
  })

  // レース中・一時停止中にウィンドウを閉じる場合は確認する（D-067）
  win.on('close', (e) => {
    if (osSessionEnding || quitConfirmed || !hasActiveRace(context)) return
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['キャンセル', '終了する'],
      defaultId: 0,
      cancelId: 0,
      title: 'レース中です',
      message: '進行中（走行中または一時停止中）のレースがあります。アプリを終了しますか？',
      detail: '記録済みのデータは保存されています。終了している間は通過を記録できません。'
    })
    if (choice === 1) {
      quitConfirmed = true
      win.close()
    }
  })

  // Renderer の異常終了（D-068）：Main と DB 接続は維持し、Renderer だけを再読み込みする。60 秒以内に最大 3 回
  const limiter = new ReloadLimiter()
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || appClosingGate.isClosing()) return
    console.error('[renderer] process gone', details)
    if (limiter.tryAcquire(Date.now())) {
      loadRenderer(win)
    } else {
      dialog.showErrorBox(
        '画面を復旧できませんでした',
        `画面の処理が短時間に繰り返し停止したため、自動再読み込みを停止しました（${details.reason}）。\n\n記録済みのデータは保存されています。アプリを再起動してください。`
      )
    }
  })

  loadRenderer(win)
  return win
}

function loadRenderer(win: BrowserWindow): void {
  if (isDev && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
