"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('unum', {
    token: () => electron_1.ipcRenderer.invoke('unum:token'),
    window: (action) => electron_1.ipcRenderer.invoke('unum:window', action),
});
