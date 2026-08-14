'use strict'

/**
 * dsh-desktop — Electron 主进程。
 *
 * 生命周期:
 *   1. 单实例锁(重复启动时聚焦已有窗口)
 *   2. 显示 splash(启动/状态/错误页),同步拉起 dsh web
 *   3. 解析到 URL 后打开主窗口并导航到 DSH Web GUI
 *   4. dsh 崩溃 → 主窗口切回状态页,可一键重启
 *   5. 退出时停止 dsh(Windows 下清理整个进程树)
 */

const { app, BrowserWindow, ipcMain, clipboard, shell, Menu, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { DshManager } = require('./dsh-manager')

const APP_ID = 'ai.deepseek.dshdesktop'
const SPLASH_HTML = path.join(__dirname, '..', 'splash', 'index.html')

const DEFAULTS = {
  dshCommand: null,
  dshArgs: [],
  startupTimeoutSec: 90,
  openDevTools: false,
  windowBounds: null
}

// ---------------------------------------------------------------- settings

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    /* 首次运行或文件损坏 → 使用默认值 */
  }
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  return {
    dshCommand: typeof merged.dshCommand === 'string' && merged.dshCommand !== '' ? merged.dshCommand : null,
    dshArgs: Array.isArray(merged.dshArgs) ? merged.dshArgs.map(String) : [],
    startupTimeoutSec: Number.isFinite(merged.startupTimeoutSec) ? merged.startupTimeoutSec : DEFAULTS.startupTimeoutSec,
    openDevTools: Boolean(merged.openDevTools),
    windowBounds:
      merged.windowBounds && typeof merged.windowBounds === 'object' ? merged.windowBounds : null
  }
}

function saveSettings(patch) {
  const current = loadSettings()
  const next = { ...current, ...patch }
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  } catch (error) {
    logLine(`保存设置失败: ${error.message}`)
  }
}

// ---------------------------------------------------------------- logging

const MAX_LOG_BYTES = 512 * 1024

function logPath() {
  return path.join(app.getPath('userData'), 'dsh-desktop.log')
}

function logLine(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    let stat = null
    try {
      stat = fs.statSync(logPath())
    } catch {
      /* 不存在则直接追加 */
    }
    if (stat && stat.size > MAX_LOG_BYTES) {
      try {
        fs.renameSync(logPath(), `${logPath()}.old`)
      } catch {
        /* 轮转失败可容忍 */
      }
    }
    fs.appendFileSync(logPath(), line)
  } catch {
    /* 日志写失败不应影响主流程 */
  }
}

// ---------------------------------------------------------------- globals

let settings = null
let manager = null
let splashWin = null
let appWin = null
let quitting = false
let appWindowUrl = null
let everReady = false
let lastFailureMessage = ''

// ---------------------------------------------------------------- windows

function createSplashWindow() {
  splashWin = new BrowserWindow({
    width: 560,
    height: 430,
    resizable: false,
    show: false,
    title: 'DSH Desktop',
    autoHideMenuBar: true,
    backgroundColor: '#0f1420',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  splashWin.loadFile(SPLASH_HTML)
  splashWin.once('ready-to-show', () => splashWin && splashWin.show())
  splashWin.on('closed', () => {
    splashWin = null
  })
}

function createAppWindow(url) {
  const bounds = settings.windowBounds
  appWin = new BrowserWindow({
    width: bounds && Number.isFinite(bounds.width) ? bounds.width : 1400,
    height: bounds && Number.isFinite(bounds.height) ? bounds.height : 900,
    x: bounds && Number.isFinite(bounds.x) ? bounds.x : undefined,
    y: bounds && Number.isFinite(bounds.y) ? bounds.y : undefined,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'DSH Desktop',
    backgroundColor: '#0f1420',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  appWindowUrl = url

  // 弹窗一律交给系统浏览器,不在应用内开新窗口
  appWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target)
    return { action: 'deny' }
  })
  // 页面导航限制在当前 dsh 源内;外链交给系统浏览器
  appWin.webContents.on('will-navigate', (event, target) => {
    try {
      if (appWindowUrl && /^https?:/i.test(appWindowUrl) && new URL(target).origin === new URL(appWindowUrl).origin) return
    } catch {
      /* 无法解析的 target 走外部处理 */
    }
    if (target.startsWith('file:')) return
    event.preventDefault()
    if (/^https?:/i.test(target)) shell.openExternal(target)
  })
  appWin.webContents.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      logLine(`主框架加载失败: ${code} ${desc} ${validatedURL}`)
    }
  })
  appWin.webContents.on('render-process-gone', (_e, details) => {
    logLine(`渲染进程异常: ${details.reason}`)
  })

  if (settings.openDevTools) appWin.webContents.openDevTools({ mode: 'detach' })
  appWin.once('ready-to-show', () => appWin && appWin.show())
  appWin.on('close', () => {
    if (!quitting && appWin) {
      try {
        saveSettings({ windowBounds: appWin.getNormalBounds() })
      } catch {
        /* 窗口已销毁时忽略 */
      }
    }
  })
  appWin.on('closed', () => {
    appWin = null
    appWindowUrl = null
  })
  appWin.loadURL(url)
}

/** 让某个窗口显示状态页(splash 与主窗口共用同一份 UI)。 */
function showStatusPage(win) {
  if (!win) return
  if (win.webContents.getURL() !== pathToFileURL(SPLASH_HTML).href) {
    win.loadFile(SPLASH_HTML)
  }
}

// ---------------------------------------------------------------- dsh wiring

function broadcast(payload) {
  for (const win of [splashWin, appWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('dsh:status', payload)
  }
}

function startManager() {
  manager = new DshManager({
    command: process.env.DSH_DESKTOP_DSH || settings.dshCommand || null,
    args: settings.dshArgs,
    timeoutMs: Math.max(10, settings.startupTimeoutSec) * 1000
  })

  manager.on('state', (s) => {
    logLine(`[dsh] ${s.phase}: ${s.message}`)
    broadcast({ kind: 'state', ...s })
  })
  manager.on('log', ({ line }) => broadcast({ kind: 'log', line }))
  manager.on('ready', ({ url }) => {
    logLine(`[dsh] 就绪: ${url}`)
    everReady = true
    if (appWin) {
      appWindowUrl = url
      appWin.loadURL(url).catch(() => {})
    } else {
      createAppWindow(url)
    }
    if (process.env.DSH_DESKTOP_SMOKE) {
      console.log(`DSH_DESKTOP_SMOKE_READY ${url}`)
      if (appWin) {
        appWin.webContents.on('did-finish-load', () => {
          console.log(`DSH_DESKTOP_SMOKE_PAGE_LOADED ${appWin.webContents.getURL()}`)
        })
      }
      setTimeout(() => app.quit(), 4000)
    }
    if (splashWin) {
      splashWin.close()
      splashWin = null
    }
  })
  manager.on('error', ({ message }) => {
    logLine(`[dsh] 错误: ${message}`)
    lastFailureMessage = message
    if (process.env.DSH_DESKTOP_SMOKE) {
      console.log(`DSH_DESKTOP_SMOKE_ERROR ${message}`)
      for (const line of manager.getLogs().slice(-15)) console.log(`  ${line}`)
    }
    broadcast({ kind: 'state', phase: 'error', message })
  })
  manager.on('exit', ({ code, signal }) => {
    logLine(`[dsh] 已退出: code=${code} signal=${signal}`)
    lastFailureMessage = `dsh 进程已退出(code=${code}, signal=${signal})`
    if (appWin && !appWin.isDestroyed()) showStatusPage(appWin)
    broadcast({ kind: 'state', phase: 'crashed', message: lastFailureMessage })
  })

  manager.start().catch((error) => {
    logLine(`[dsh] 启动异常: ${error.message}`)
    broadcast({ kind: 'state', phase: 'error', message: error.message })
  })
}

// ---------------------------------------------------------------- IPC

function requestDshRestart() {
  if (!manager) return
  logLine('[dsh] 用户请求重启')
  manager
    .restart()
    .catch((error) => broadcast({ kind: 'state', phase: 'error', message: error.message }))
}

function wireIpc() {
  ipcMain.handle('dsh:get-state', () => ({
    phase: manager ? manager.phase : 'idle',
    url: manager ? manager.url : null,
    logs: manager ? manager.getLogs() : [],
    message: lastFailureMessage
  }))
  ipcMain.on('dsh:restart', () => requestDshRestart())
  ipcMain.on('dsh:quit', () => app.quit())
  ipcMain.handle('dsh:copy-logs', () => {
    const logs = manager ? manager.getLogs().join('\n') : ''
    clipboard.writeText(logs)
    return logs.length > 0
  })
  ipcMain.on('dsh:open-logs', () => {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true })
      fs.writeFileSync(logPath(), '', { flag: 'a' })
      shell.showItemInFolder(logPath())
    } catch (error) {
      dialog.showErrorBox('无法打开日志目录', error.message)
    }
  })
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新启动 dsh', accelerator: 'CmdOrCtrl+Shift+R', click: () => requestDshRestart() },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新页面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '在浏览器中打开',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            if (manager && manager.url) shell.openExternal(manager.url)
          }
        },
        {
          label: '打开日志文件',
          click: () => {
            try {
              fs.writeFileSync(logPath(), '', { flag: 'a' })
              shell.showItemInFolder(logPath())
            } catch {
              /* ignore */
            }
          }
        },
        { type: 'separator' },
        {
          label: '关于 DSH Desktop',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: 'DSH Desktop',
              detail: `DeepSeek Harness 桌面客户端 v${app.getVersion()}\n\n自动拉起 dsh web 并嵌入窗口;退出应用时自动停止 dsh。`
            })
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------- app lifecycle

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId(APP_ID)
  app.on('second-instance', () => {
    const win = appWin || splashWin
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    settings = loadSettings()
    logLine(`dsh-desktop v${app.getVersion()} 启动`)
    logLine(`设置文件: ${settingsPath()}`)
    if (process.env.DSH_DESKTOP_DSH) logLine(`环境变量 DSH_DESKTOP_DSH: ${process.env.DSH_DESKTOP_DSH}`)
    else if (settings.dshCommand) logLine(`设置 dshCommand: ${settings.dshCommand}`)
    buildMenu()
    wireIpc()
    createSplashWindow()
    startManager()
    if (process.env.DSH_DESKTOP_SMOKE) {
      // 冒烟模式硬上限:60s 内无论成败都退出
      setTimeout(() => {
        console.log('DSH_DESKTOP_SMOKE_TIMEOUT')
        app.quit()
      }, 60_000)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (everReady) startManager()
      else {
        createSplashWindow()
        if (!manager || !manager.isRunning()) startManager()
      }
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', async (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    logLine('应用退出,正在停止 dsh…')
    if (manager) {
      const timeout = new Promise((resolve) => setTimeout(resolve, 5000))
      await Promise.race([manager.stop(), timeout])
    }
    logLine('dsh 已停止,退出。')
    app.quit()
  })
}
