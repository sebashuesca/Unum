import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('unum', {
    token: () => ipcRenderer.invoke('unum:token'),
    window: (action) => ipcRenderer.invoke('unum:window', action),
});
