'use strict'

;(function installDshWindowBridge() {
  if (window.dshWindow) return
  if (!window.__TAURI_INTERNALS__) {
    setTimeout(installDshWindowBridge, 10)
    return
  }
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__.invoke
  const listen = window.__TAURI__?.event?.listen

  const subscribe = (eventName, callback) => {
    if (!listen) return () => {}
    const pending = listen(eventName, (event) => callback(event.payload))
    return () => pending.then((unlisten) => unlisten()).catch(() => {})
  }

  window.dshWindow = {
    onStatus: (callback) => subscribe('dsh:status', callback),
    getState: () => invoke('get_state'),
    restart: () => invoke('restart'),
    quit: () => invoke('quit'),
    copyLogs: () => invoke('copy_logs'),
    openLogs: () => invoke('open_logs'),
    onTheme: (callback) => subscribe('dsh:theme', callback)
  }
})()
