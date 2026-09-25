import { app, BrowserWindow, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const currentDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(currentDir, '..');
const workspace = resolve(frontendDir, '..');
const backendDir = join(workspace, 'core-backend');
const token = randomBytes(32).toString('hex');
let backend;
function launchBackend() {
    backend = spawn('bash', [join(backendDir, 'start.sh')], {
        cwd: backendDir,
        env: { ...process.env, UNUM_WORKSPACE: workspace, UNUM_IPC_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    backend.stdout?.on('data', (data) => process.stdout.write(data));
    backend.stderr?.on('data', (data) => process.stderr.write(data));
    backend.on('error', (error) => console.error('Backend failed:', error));
}
function createWindow() {
    const window = new BrowserWindow({
        width: 1480, height: 920, minWidth: 1000, minHeight: 650,
        frame: false, backgroundColor: '#0b1019',
        webPreferences: {
            preload: join(currentDir, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    window.webContents.on('will-navigate', (event, destination) => {
        const allowed = !app.isPackaged
            ? destination.startsWith('http://127.0.0.1:5173/')
            : destination.startsWith(`file://${join(frontendDir, 'dist')}/`);
        if (!allowed)
            event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (!app.isPackaged)
        void window.loadURL('http://127.0.0.1:5173');
    else
        void window.loadFile(join(frontendDir, 'dist', 'index.html'));
}
app.whenReady().then(() => {
    ipcMain.handle('unum:token', () => token);
    ipcMain.handle('unum:window', (event, action) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window)
            return;
        if (action === 'minimize')
            window.minimize();
        if (action === 'maximize') {
            if (window.isMaximized())
                window.unmaximize();
            else
                window.maximize();
        }
        if (action === 'close')
            window.close();
    });
    launchBackend();
    createWindow();
});
app.on('window-all-closed', () => {
    backend?.kill('SIGTERM');
    app.quit();
});
