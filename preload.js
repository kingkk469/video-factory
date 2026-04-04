const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Session
  sessionCreate: () => ipcRenderer.invoke('session:create'),
  sessionRead: (p) => ipcRenderer.invoke('session:read', p),
  sessionWrite: (p, d) => ipcRenderer.invoke('session:write', p, d),
  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionRename: (id, name) => ipcRenderer.invoke('session:rename', id, name),
  sessionDelete: (id) => ipcRenderer.invoke('session:delete', id),

  // Config
  configRead: () => ipcRenderer.invoke('config:read'),
  configWrite: (cfg) => ipcRenderer.invoke('config:write', cfg),

  // Step execution
  stepRun: (opts) => ipcRenderer.invoke('step:run', opts),
  stepCancel: (step) => ipcRenderer.invoke('step:cancel', step),

  // Log listener
  onLog: (cb) => {
    const handler = (_, msg) => cb(msg)
    ipcRenderer.on('step:log', handler)
    return () => ipcRenderer.removeListener('step:log', handler)
  },

  // Publish
  publishRun: (opts) => ipcRenderer.invoke('publish:run', opts),

  // Shell
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  // 文件对话框
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),

  // 环境检测
  envCheck: () => ipcRenderer.invoke('env:check'),

  // BGM 预设
  bgmList: () => ipcRenderer.invoke('bgm:list'),

  // 读取文本文件
  readFile: (p) => ipcRenderer.invoke('fs:readText', p)
})
