'use strict'

/**
 * dsh-window — Electron 主进程。
 *
 * 生命周期:
 *   1. 单实例锁(重复启动时聚焦已有窗口)
 *   2. 显示 splash(启动/状态/错误页),同步拉起 dsh web
 *   3. 解析到 URL 后打开主窗口并导航到 DSH Web GUI
 *   4. dsh 崩溃 → 主窗口切回状态页,可一键重启
 *   5. 关闭窗口 → 隐藏到系统托盘,dsh 后台常驻;托盘菜单可恢复窗口或退出
 *   6. 退出时停止 dsh(Windows 下清理整个进程树);另有 guard 看门狗
 *      兜底任务管理器强杀等 before-quit 无法执行的情况
 *
 * 窗口外观:隐藏系统标题栏(titleBarStyle:'hidden');主窗口的
 * 最小化/最大化/关闭按钮为注入的自绘按钮,颜色与悬停高亮复用
 * DSH 设计 token,与界面其他组件一致;页面顶部注入透明拖拽区用于移动窗口。
 */

const { app, BrowserWindow, ipcMain, clipboard, shell, Menu, dialog, nativeTheme, Tray, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { DshManager } = require('./dsh-manager')

const APP_ID = 'ai.deepseek.dshwindow'
const SPLASH_HTML = path.join(__dirname, '..', 'splash', 'index.html')
const GUARD_JS = path.join(__dirname, 'guard.js')
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.ico')
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png')

// DSH 设计系统 token(取自 @deepseek-ai/dsh-client-ui-theme design-platform.css)
// color 为全透明:标题栏区域不再绘制实色,按钮直接浮在页面内容之上,
// 页面自身的毛玻璃/遮罩效果(如设置界面)可透到按钮背后。
const CHROME_LIGHT = { color: '#ffffff00', symbolColor: '#0f1115', backgroundColor: '#ffffff' }
const CHROME_DARK = { color: '#15151700', symbolColor: '#f9fafb', backgroundColor: '#151517' }

/** 拖拽区:覆盖内容区顶部(避开左侧栏),右端止于自定义窗口按钮。 */
const DRAG_STRIP = {
  top: 0,
  height: 32,
  left: 236,
  right: '138px' // 三个 46px 自定义按钮的总宽
}

const DEFAULTS = {
  dshCommand: null,
  dshArgs: [],
  startupTimeoutSec: 90,
  openDevTools: false,
  closeToTray: true,
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
    closeToTray: merged.closeToTray !== false,
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
  return path.join(app.getPath('userData'), 'dsh-window.log')
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
let lastFailureMessage = ''
let guard = null
let tray = null
let hiddenToTray = false
let deferredShowPending = false

// ---------------------------------------------------------------- guard(看门狗)

function startGuard(dshPid) {
  stopGuard()
  if (!Number.isInteger(dshPid) || dshPid <= 0) return
  try {
    guard = spawn(process.execPath, [GUARD_JS, String(process.pid), String(dshPid)], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    logLine(`[guard] 已启动,监视 dsh pid=${dshPid}`)
  } catch (error) {
    logLine(`[guard] 启动失败: ${error.message}`)
  }
}

function stopGuard() {
  if (guard && !guard.killed) {
    try {
      guard.kill()
    } catch {
      /* ignore */
    }
  }
  guard = null
}

// ---------------------------------------------------------------- tray

/** 恢复/创建可见窗口(托盘点击、任务栏激活、二次启动共用)。 */
function showWindow() {
  hiddenToTray = false
  const win =
    appWin && !appWin.isDestroyed() ? appWin : splashWin && !splashWin.isDestroyed() ? splashWin : null
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  if (manager && manager.ready && manager.url) {
    createAppWindow(manager.url)
    prepareDshPage(appWin)
  } else {
    createSplashWindow()
    if (!manager || !manager.isRunning()) startManager()
  }
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON))
  } catch (error) {
    logLine(`[tray] 创建失败: ${error.message}`)
    return
  }
  tray.setToolTip('DSH Window')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showWindow() },
    { label: '重新启动 dsh', click: () => requestDshRestart() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
  tray.on('click', () => showWindow())
  tray.on('double-click', () => showWindow())
}

// ---------------------------------------------------------------- theme(与客户端主题对齐)

/** DSH 主题偏好持久化文件:与 dsh 一致,位于 $DSH_HOME 或 ~/.dsh 下的 settings.yaml。 */
function dshSettingsPath() {
  const env = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : null
  return path.join(env || path.join(os.homedir(), '.dsh'), 'settings.yaml')
}

/**
 * 读取 DSH 的 ui-theme.preference(light/dark/system),规则与
 * @deepseek-ai/dsh-client-ui-theme 一致:文件缺失或无法解析时按默认值 system。
 */
function readThemePreference() {
  let text = ''
  try {
    text = fs.readFileSync(dshSettingsPath(), 'utf8')
  } catch {
    return 'system'
  }
  // 定位 ui-theme 段:兼容块状(下一行缩进的 preference)与行内 flow 两种写法
  const section = text.match(/(?:^|\n)[ \t]*["']?ui-theme["']?\s*:\s*([^\n]*)(?:\n((?:[ \t]+.*\n?)*))?/)
  const haystack = `${section ? section[1] : ''}\n${section ? section[2] : ''}`
  const m = haystack.match(/["']?preference["']?\s*:\s*["']?(light|dark|system)["']?/)
  return m ? m[1] : 'system'
}

let currentDark = false

/** 与 DSH 客户端相同的解析规则:dark = 偏好 dark,或偏好 system 且系统为暗色。 */
function resolveThemeDark() {
  const preference = readThemePreference()
  if (preference === 'light') return false
  if (preference === 'dark') return true
  return nativeTheme.shouldUseDarkColors
}

/** 窗口当前是否正在显示状态页(splash 与主窗口共用同一份 UI)。 */
function isStatusWindow(win) {
  if (!win || win.isDestroyed()) return false
  try {
    return win.webContents.getURL().split('?')[0] === pathToFileURL(SPLASH_HTML).href
  } catch {
    return false
  }
}

/** 主题变化时推送给状态页,并同步其窗口背景/标题栏。 */
function pushTheme() {
  const dark = resolveThemeDark()
  if (dark === currentDark) return
  currentDark = dark
  logLine(`[theme] 状态页主题: ${dark ? 'dark' : 'light'}`)
  for (const win of [splashWin, appWin]) {
    if (!isStatusWindow(win)) continue
    win.webContents.send('dsh:theme', dark)
    applyChrome(win, dark)
  }
}

/**
 * 启动主题跟随:初始解析 + 监听变化。
 *  - nativeTheme 'updated':偏好为 system 时随系统亮暗切换(与 DSH 一致);
 *  - 监听设置文件所在目录:DSH 以「临时文件 + 原子改名」写入,文件监听在
 *    Windows 上会因 rename 失联,目录监听始终可靠;
 *  - 目录尚不存在时向上找最近存在的祖先,首次创建即触发重读。
 */
function watchTheme() {
  currentDark = resolveThemeDark()
  nativeTheme.on('updated', pushTheme)
  let dir = path.dirname(dshSettingsPath())
  while (true) {
    try {
      if (fs.statSync(dir).isDirectory()) break
    } catch {
      /* 目录不存在,向上找 */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    const watcher = fs.watch(dir, () => pushTheme())
    watcher.on('error', () => {})
    watcher.unref && watcher.unref()
  } catch {
    logLine('[theme] 设置文件监听不可用,主题仅启动时解析')
  }
}

// ---------------------------------------------------------------- windows

function chromeOptions() {
  return resolveThemeDark() ? CHROME_DARK : CHROME_LIGHT
}

/** 把窗口背景色切到指定亮/暗主题(自定义按钮颜色由页面 CSS 变量自动跟随)。 */
function applyChrome(win, dark) {
  const overlay = dark ? CHROME_DARK : CHROME_LIGHT
  try {
    win.setBackgroundColor(overlay.backgroundColor)
  } catch {
    /* 窗口已销毁时忽略 */
  }
}

function createSplashWindow() {
  const chrome = chromeOptions()
  splashWin = new BrowserWindow({
    width: 560,
    height: 430,
    icon: APP_ICON,
    resizable: false,
    show: false,
    title: 'DSH Window',
    autoHideMenuBar: true,
    backgroundColor: chrome.backgroundColor,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.color, symbolColor: chrome.symbolColor, height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  splashWin.loadFile(SPLASH_HTML, { query: { theme: resolveThemeDark() ? 'dark' : 'light' } })
  splashWin.once('ready-to-show', () => splashWin && splashWin.show())
  splashWin.on('closed', () => {
    splashWin = null
  })
  splashWin.on('close', (event) => {
    if (quitting || !settings.closeToTray) return
    hiddenToTray = true
    event.preventDefault()
    splashWin.hide()
  })
}

function createAppWindow(url, opts = {}) {
  const deferShow = !!opts.deferShow
  if (deferShow) deferredShowPending = true
  const bounds = settings.windowBounds
  const chrome = chromeOptions()
  appWin = new BrowserWindow({
    width: bounds && Number.isFinite(bounds.width) ? bounds.width : 1400,
    height: bounds && Number.isFinite(bounds.height) ? bounds.height : 900,
    icon: APP_ICON,
    x: bounds && Number.isFinite(bounds.x) ? bounds.x : undefined,
    y: bounds && Number.isFinite(bounds.y) ? bounds.y : undefined,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'DSH Window',
    backgroundColor: chrome.backgroundColor,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  appWindowUrl = url

  // 自定义窗口按钮:最大化状态回传页面,切换 最大化/还原 图标
  appWin.on('maximize', () => {
    if (appWin && !appWin.isDestroyed()) appWin.webContents.send('dsh:maximized', true)
  })
  appWin.on('unmaximize', () => {
    if (appWin && !appWin.isDestroyed()) appWin.webContents.send('dsh:maximized', false)
  })

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
    if (isMainFrame) finishSplashSwap()
  })
  appWin.webContents.on('render-process-gone', (_e, details) => {
    logLine(`渲染进程异常: ${details.reason}`)
  })

  if (settings.openDevTools) appWin.webContents.openDevTools({ mode: 'detach' })
  appWin.once('ready-to-show', () => {
    if (!deferShow && appWin) appWin.show()
  })
  appWin.on('close', (event) => {
    if (appWin) {
      try {
        saveSettings({ windowBounds: appWin.getNormalBounds() })
      } catch {
        /* 窗口已销毁时忽略 */
      }
    }
    if (!quitting && settings.closeToTray) {
      hiddenToTray = true
      event.preventDefault()
      appWin.hide()
    }
  })
  appWin.on('closed', () => {
    appWin = null
    appWindowUrl = null
  })
  appWin.loadURL(url)
}

/** 关闭 splash 并显示主窗口(splash 覆盖交接点,消除空壳白屏闪烁)。 */
function finishSplashSwap() {
  if (!deferredShowPending) return
  deferredShowPending = false
  logLine('[chrome] 切换:关闭 splash,显示主窗口')
  if (appWin && !appWin.isDestroyed()) appWin.show()
  if (splashWin) {
    splashWin.destroy()
    splashWin = null
  }
}

/** DSH 页面加载完成后:同步窗口按钮主题 + 注入拖拽条 + 记录布局校准数据。 */
function prepareDshPage(win) {
  const wc = win.webContents
  wc.on('did-finish-load', () => {
    // 延迟显示交接:DSH shell 是空的 #root,首帧是白屏;等 React 真正渲染出
    // 内容再关闭 splash,保证 splash → 界面无缝切换。
    if (deferredShowPending && win === appWin) {
      if (wc.getURL().startsWith('file:')) {
        finishSplashSwap() // 状态页为静态 HTML,可直接切换
      } else {
        const pollForContent = async () => {
          if (!deferredShowPending || !appWin || appWin.isDestroyed()) return
          let hasContent = false
          try {
            hasContent = await wc.executeJavaScript(
              `!!(document.getElementById('root') && document.getElementById('root').childElementCount > 0)`
            )
          } catch {
            /* 页面切换中,继续等待 */
          }
          if (hasContent) finishSplashSwap()
          else setTimeout(pollForContent, 100)
        }
        pollForContent()
      }
    }
    if (!wc.getURL().startsWith('http')) return

    // 1) 窗口按钮颜色跟随页面实际主题(亮/暗)。preload 的 MutationObserver 会
    //    持续上报变化,这里在 load 完成时再立即校正一次。
    wc
      .executeJavaScript(`document.body.hasAttribute('data-ds-dark-theme')`)
      .then((dark) => {
        logLine(`[chrome] load 时页面主题: ${dark ? 'dark' : 'light'}`)
        if (!win.isDestroyed()) applyChrome(win, dark)
      })
      .catch(() => {})

    // 2) 顶部拖拽条(真实元素,保证 app-region 命中)
    const right = DRAG_STRIP.right
    wc
      .executeJavaScript(`(() => {
        document.getElementById('dsh-window-drag-strip')?.remove();
        const el = document.createElement('div');
        el.id = 'dsh-window-drag-strip';
        el.style.cssText = 'position:fixed;top:${DRAG_STRIP.top}px;left:${DRAG_STRIP.left}px;right:calc(${right});height:${DRAG_STRIP.height}px;-webkit-app-region:drag;z-index:2147483000;';
        document.body.appendChild(el);
        return true;
      })()`)
      .catch(() => {})

    // 2.5) 自定义窗口控制按钮:原生 WCO 的悬停高亮由系统绘制,无法与 DSH
    //      组件一致;注入自绘按钮,颜色/悬停/关闭高亮直接复用 DSH 设计 token。
    logLine('[chrome] 注入自定义窗口按钮…')
    wc
      .executeJavaScript(`(() => {
        document.getElementById('dsh-window-controls')?.remove();
        const host = document.createElement('div');
        host.id = 'dsh-window-controls';
        const style = document.createElement('style');
        style.textContent = [
          '#dsh-window-controls{position:fixed;top:0;right:0;height:36px;display:flex;align-items:stretch;z-index:2147483001;-webkit-app-region:no-drag;}',
          '#dsh-window-controls button{width:46px;height:100%;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;padding:0;margin:0;cursor:pointer;color:var(--dsw-alias-label-secondary);-webkit-app-region:no-drag;}',
          '#dsh-window-controls button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
          '#dsh-window-controls button.close:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);}',
          '#dsh-window-controls svg{width:16px;height:16px;}'
        ].join('\\n');
        host.appendChild(style);
        const icons = {
          min: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 8.5h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
          max: '<svg viewBox="0 0 16 16" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>',
          restore: '<svg viewBox="0 0 16 16" fill="none"><path d="M6.5 4.5h4a1 1 0 0 1 1 1v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="4.5" y="6.5" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>',
          close: '<svg viewBox="0 0 16 16" fill="none"><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
        };
        const make = (label, cls, svg) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = cls;
          b.setAttribute('aria-label', label);
          b.innerHTML = svg;
          host.appendChild(b);
          return b;
        };
        const btnMin = make('最小化', '', icons.min);
        const btnMax = make('最大化', '', icons.max);
        const btnClose = make('关闭', 'close', icons.close);
        const api = window.dshWindow;
        if (!api) { document.body.appendChild(host); return false; }
        btnMin.addEventListener('click', () => api.minimize());
        btnMax.addEventListener('click', () => api.toggleMaximize());
        btnClose.addEventListener('click', () => api.close());
        const applyMax = (maximized) => {
          btnMax.innerHTML = maximized ? icons.restore : icons.max;
          btnMax.setAttribute('aria-label', maximized ? '还原' : '最大化');
        };
        api.isMaximized().then(applyMax).catch(() => {});
        api.onMaximized(applyMax);
        document.body.appendChild(host);
        return true;
      })()`)
      .then((ok) => logLine(`[chrome] 自定义窗口按钮注入: ${ok}`))
      .catch((error) => logLine(`[chrome] 自定义窗口按钮注入失败: ${error.message}`))

    // 3) 布局校准数据(写入日志,便于后续调整拖拽条/按钮位置)
    setTimeout(() => {
      wc
        .executeJavaScript(`(() => {
          const out = [];
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.top < 44 && r.height > 2 && r.width > 6 && r.bottom > 0) {
              const hit = el.closest('button,a,[role=button],input,textarea,select,label,[contenteditable]');
              out.push({ x: Math.round(r.x), w: Math.round(r.width), click: !!hit });
            }
          }
          const leftCols = [];
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.top <= 0 && r.bottom >= window.innerHeight && r.width > 40 && r.width < window.innerWidth) leftCols.push(Math.round(r.width));
          }
          return JSON.stringify({ clickables: out.slice(0, 12), leftColWidths: leftCols.slice(0, 4), vw: window.innerWidth });
        })()`)
        .then((json) => logLine(`[layout] ${json}`))
        .catch(() => {})
    }, 2500)
  })
}

/** 让某个窗口显示状态页(splash 与主窗口共用同一份 UI)。 */
function showStatusPage(win) {
  if (!win) return
  if (win.webContents.getURL().split('?')[0] === pathToFileURL(SPLASH_HTML).href) return
  win.loadFile(SPLASH_HTML, { query: { theme: resolveThemeDark() ? 'dark' : 'light' } })
}

// ---------------------------------------------------------------- dsh wiring

function broadcast(payload) {
  for (const win of [splashWin, appWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('dsh:status', payload)
  }
}

function startManager() {
  manager = new DshManager({
    command: process.env.DSH_WINDOW_DSH || settings.dshCommand || null,
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
    // splash 仍可见时,主窗口延迟到内容渲染完成再显示,避免空壳白屏
    const deferShow = !!splashWin && !hiddenToTray && !appWin
    if (appWin) {
      appWindowUrl = url
      appWin.loadURL(url).catch(() => {})
    } else if (!hiddenToTray) {
      createAppWindow(url, { deferShow })
      prepareDshPage(appWin)
    }
    // 看门狗:主进程被强杀时兜底清理 dsh 进程树
    if (manager.child && manager.child.pid) startGuard(manager.child.pid)

    if (process.env.DSH_WINDOW_SMOKE) {
      console.log(`DSH_WINDOW_SMOKE_READY ${url}`)
      if (appWin) {
        appWin.webContents.on('did-finish-load', () => {
          console.log(`DSH_WINDOW_SMOKE_PAGE_LOADED ${appWin.webContents.getURL()}`)
        })
      }
      setTimeout(() => app.quit(), 9000)
    }
    if (deferShow) {
      // 兜底:页面迟迟未就绪时,10s 后强制切换
      setTimeout(finishSplashSwap, 10_000)
    } else if (splashWin) {
      splashWin.destroy()
      splashWin = null
    }
  })
  manager.on('error', ({ message }) => {
    logLine(`[dsh] 错误: ${message}`)
    lastFailureMessage = message
    if (process.env.DSH_WINDOW_SMOKE) {
      console.log(`DSH_WINDOW_SMOKE_ERROR ${message}`)
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
    message: lastFailureMessage,
    version: app.getVersion(),
    theme: resolveThemeDark()
  }))
  ipcMain.on('dsh:theme', (event, dark) => {
    logLine(`[chrome] IPC 主题: ${dark ? 'dark' : 'light'}`)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      applyChrome(win, Boolean(dark))
    }
  })
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
  // 自定义窗口按钮(minimize / maximize / close)
  ipcMain.on('dsh:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.minimize()
  })
  ipcMain.on('dsh:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
  })
  ipcMain.on('dsh:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.close()
  })
  ipcMain.handle('dsh:get-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return !!(win && !win.isDestroyed() && win.isMaximized())
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
          label: '关于 DSH Window',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: 'DSH Window',
              detail: `DeepSeek Harness 窗口客户端 v${app.getVersion()}\n\n自动拉起 dsh web 并嵌入窗口;退出应用时自动停止 dsh。`
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
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    settings = loadSettings()
    logLine(`dsh-window v${app.getVersion()} 启动`)
    logLine(`设置文件: ${settingsPath()}`)
    if (process.env.DSH_WINDOW_DSH) logLine(`环境变量 DSH_WINDOW_DSH: ${process.env.DSH_WINDOW_DSH}`)
    else if (settings.dshCommand) logLine(`设置 dshCommand: ${settings.dshCommand}`)
    buildMenu()
    wireIpc()
    watchTheme()
    createTray()
    if (process.env.DSH_WINDOW_SMOKE) logLine('[smoke] 冒烟模式已开启')
    createSplashWindow()
    startManager()
    if (process.env.DSH_WINDOW_SMOKE) {
      // 冒烟模式硬上限:60s 内无论成败都退出
      setTimeout(() => {
        console.log('DSH_WINDOW_SMOKE_TIMEOUT')
        app.quit()
      }, 60_000)
    }
  })

  app.on('activate', () => showWindow())

  app.on('window-all-closed', () => {
    if (!settings || !settings.closeToTray) app.quit()
  })

  app.on('before-quit', async (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    stopGuard()
    logLine('应用退出,正在停止 dsh…')
    if (manager) {
      const timeout = new Promise((resolve) => setTimeout(resolve, 5000))
      await Promise.race([manager.stop(), timeout])
    }
    logLine('dsh 已停止,退出。')
    app.quit()
  })

  app.on('will-quit', () => {
    stopGuard()
    if (tray) {
      tray.destroy()
      tray = null
    }
  })
}
