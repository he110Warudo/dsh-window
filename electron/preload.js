'use strict'

/**
 * preload — 以最小接口把主进程状态桥接给状态页(splash/错误页)。
 * contextIsolation + sandbox 开启,DH 页面本身不依赖这些接口。
 */

const { contextBridge, ipcRenderer } = require('electron')

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
  }
})
