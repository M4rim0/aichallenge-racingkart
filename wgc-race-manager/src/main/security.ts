import { app, session, shell, type WebContents } from 'electron'

/**
 * オフライン運用（仕様 §1.2）と Renderer 隔離（§2.1）のためのセキュリティ設定。
 * - 外部への通信を行わない CSP
 * - ナビゲーション・新規ウィンドウの禁止
 * - 権限要求（カメラ・通知等）はすべて拒否
 */

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

// 開発時のみ Vite の HMR（localhost）を許可する
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "object-src 'none'"
].join('; ')

export function applySessionSecurity(isDev: boolean): void {
  const csp = isDev ? DEV_CSP : PRODUCTION_CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
    })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

export function hardenWebContents(contents: WebContents, allowedOrigin: string | null): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (allowedOrigin !== null && url.startsWith(allowedOrigin)) return
    event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** 外部 URL は開かない（オフライン運用）。誤って呼ばれないよう明示的に無効化する。 */
export function disableExternalOpen(): void {
  shell.openExternal = async () => {
    throw new Error('External URLs are disabled in this application')
  }
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}
