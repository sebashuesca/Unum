"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('unum', {
    connection: () => electron_1.ipcRenderer.invoke('unum:connection'),
    window: (action) => electron_1.ipcRenderer.invoke('unum:window', action),
    googleProfile: () => electron_1.ipcRenderer.invoke('unum:google-profile'),
    googleLogin: (clientId) => electron_1.ipcRenderer.invoke('unum:google-login', clientId),
    googleLogout: () => electron_1.ipcRenderer.invoke('unum:google-logout'),
    revealArtifact: (path) => electron_1.ipcRenderer.invoke('unum:reveal-artifact', path),
    exportArtifact: (path) => electron_1.ipcRenderer.invoke('unum:export-artifact', path),
});
