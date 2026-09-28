import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('unum', {
  connection: () => ipcRenderer.invoke('unum:connection') as Promise<{ token: string; port: number }>,
  window: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke('unum:window', action),
  googleProfile: () => ipcRenderer.invoke('unum:google-profile'),
  googleLogin: (clientId: string) => ipcRenderer.invoke('unum:google-login', clientId),
  googleLogout: () => ipcRenderer.invoke('unum:google-logout'),
  revealArtifact: (path: string) => ipcRenderer.invoke('unum:reveal-artifact', path),
  exportArtifact: (path: string) => ipcRenderer.invoke('unum:export-artifact', path),
})
