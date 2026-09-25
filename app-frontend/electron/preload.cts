import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('unum', {
  token: () => ipcRenderer.invoke('unum:token') as Promise<string>,
  window: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke('unum:window', action),
})
