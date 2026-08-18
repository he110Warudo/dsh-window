'use strict'

/**
 * preload — 以最小接口把主进程状态桥接给状态页(splash/错误页)。
 * contextIsolation + sandbox 开启,DSH 页面本身不依赖这些接口。
 *
 * 额外职责:主题上报。DSH 页面把亮/暗主题写在 body 的
 * data-ds-dark-theme 属性上(启动内联脚本与 ui-layout 的 ThemePresenter
 * 共同维护),这里持续监听该属性并通过 IPC 通知主进程同步标题栏按钮颜色。
 */

const { contextBridge, ipcRenderer } = require('electron')

// ---------------------------------------------------------------- theme watch

function watchDshTheme() {
  // 只在 DSH Web 页面(http/https)上报;splash 是 file:// 且没有主题属性
  if (!location.protocol.startsWith('http')) return
  let last = null
  let timer = null
  const send = () => {
    if (!document.body) return
    const dark = document.body.hasAttribute('data-ds-dark-theme')
    if (dark === last) return
    last = dark
    // 去抖:启动初期主题可能短暂振荡,稳定 400ms 后再上报,避免按钮闪烁
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        ipcRenderer.send('dsh:theme', dark)
      } catch {
        /* ignore */
      }
    }, 400)
  }
  const start = () => {
    send()
    // 插件树激活/主题切换可能晚于 load,补几次重试兜底
    for (const delay of [500, 2000, 5000]) setTimeout(send, delay)
    new MutationObserver(send).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme']
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}

watchDshTheme()

contextBridge.exposeInMainWorld('dshWindow', {
  /** 订阅状态推送,返回取消订阅函数。 */
  onStatus(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('dsh:status', listener)
    return () => ipcRenderer.removeListener('dsh:status', listener)
  },
  /** 读取当前状态快照(phase / url / logs)。 */
  getState() {
    return ipcRenderer.invoke('dsh:get-state')
  },
  restart() {
    ipcRenderer.send('dsh:restart')
  },
  quit() {
    ipcRenderer.send('dsh:quit')
  },
  copyLogs() {
    return ipcRenderer.invoke('dsh:copy-logs')
  },
  openLogs() {
    ipcRenderer.send('dsh:open-logs')
  },
  /** 订阅主进程推送的主题(状态页与客户端主题对齐;DSH 页面自身另有上报通道)。 */
  onTheme(callback) {
    const listener = (_event, dark) => callback(dark)
    ipcRenderer.on('dsh:theme', listener)
    return () => ipcRenderer.removeListener('dsh:theme', listener)
  },
  /** 自定义窗口按钮:最小化 / 最大化切换 / 关闭(走主进程的托盘隐藏逻辑)。 */
  minimize() {
    ipcRenderer.send('dsh:minimize')
  },
  toggleMaximize() {
    ipcRenderer.send('dsh:toggle-maximize')
  },
  close() {
    ipcRenderer.send('dsh:close')
  },
  isMaximized() {
    return ipcRenderer.invoke('dsh:get-maximized')
  },
  /** 订阅最大化状态变化,返回取消订阅函数。 */
  onMaximized(callback) {
    const listener = (_event, maximized) => callback(maximized)
    ipcRenderer.on('dsh:maximized', listener)
    return () => ipcRenderer.removeListener('dsh:maximized', listener)
  }
})
