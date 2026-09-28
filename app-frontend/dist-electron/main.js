import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative as pathRelative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const currentDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(currentDir, '..');
const sourceWorkspace = resolve(frontendDir, '..');
const backendDir = join(sourceWorkspace, 'core-backend');
const token = randomBytes(32).toString('hex');
let backendPort = 8000;
let backend;
let stopping = false;
const sessionPath = () => join(app.getPath('userData'), 'google-session.enc');
function workspacePath() {
    if (!app.isPackaged)
        return sourceWorkspace;
    const path = join(app.getPath('userData'), 'workspace');
    mkdirSync(path, { recursive: true });
    return path;
}
function insideWorkspace(root, candidate) {
    const child = pathRelative(root, candidate);
    return !!child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function artifactPath(raw) {
    if (!/^[\w./\\-]+\.apk$/.test(raw))
        throw new Error('Invalid APK path');
    const workspace = workspacePath();
    const artifact = resolve(workspace, raw);
    if (!insideWorkspace(workspace, artifact) || !existsSync(artifact) || !insideWorkspace(workspace, realpathSync(artifact)))
        throw new Error('APK not found');
    return artifact;
}
function saveSession(session) {
    writeFileSync(sessionPath(), safeStorage.encryptString(JSON.stringify(session)), { mode: 0o600 });
}
async function storedProfile() {
    try {
        if (!safeStorage.isEncryptionAvailable() || !existsSync(sessionPath()))
            return null;
        const stored = JSON.parse(safeStorage.decryptString(readFileSync(sessionPath())));
        if (stored.expiresAt < Date.now() + 60000) {
            if (!stored.tokens.refresh_token)
                return null;
            const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: stored.clientId, refresh_token: stored.tokens.refresh_token, grant_type: 'refresh_token' }) });
            if (!response.ok)
                return null;
            const renewed = await response.json();
            stored.tokens.access_token = renewed.access_token;
            stored.expiresAt = Date.now() + renewed.expires_in * 1000;
            saveSession(stored);
        }
        return stored.profile;
    }
    catch {
        return null;
    }
}
async function googleLogin(clientId) {
    if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId))
        throw new Error('Enter a valid Google Desktop OAuth client ID');
    if (!safeStorage.isEncryptionAvailable())
        throw new Error('Secure credential storage is unavailable on this desktop session');
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const server = createServer();
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('OAuth callback unavailable');
    }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    try {
        const code = await new Promise((resolveCode, reject) => {
            const timer = setTimeout(() => { reject(new Error('Google sign-in timed out')); server.close(); }, 180000);
            server.on('request', (request, response) => {
                const callback = new URL(request.url || '/', redirectUri);
                if (callback.pathname !== '/callback' || callback.searchParams.get('state') !== state) {
                    response.writeHead(400).end('Invalid OAuth callback');
                    return;
                }
                const value = callback.searchParams.get('code');
                response.writeHead(value ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(value ? 'Sign-in complete. Return to Unum IDE.' : 'Sign-in failed.');
                clearTimeout(timer);
                server.close();
                if (value)
                    resolveCode(value);
                else
                    reject(new Error(callback.searchParams.get('error') || 'Google sign-in failed'));
            });
            void shell.openExternal(url.toString()).catch((error) => { clearTimeout(timer); server.close(); reject(error); });
        });
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }) });
        if (!tokenResponse.ok)
            throw new Error(`Google token exchange failed (${tokenResponse.status})`);
        const tokens = await tokenResponse.json();
        const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        if (!userResponse.ok)
            throw new Error(`Google profile request failed (${userResponse.status})`);
        const profile = await userResponse.json();
        saveSession({ tokens, profile, clientId, expiresAt: Date.now() + tokens.expires_in * 1000 });
        return profile;
    }
    finally {
        server.close();
    }
}
async function availableLoopbackPort() {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Could not allocate a backend port');
    }
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    return address.port;
}
async function launchBackend() {
    const workspace = workspacePath();
    backendPort = app.isPackaged ? await availableLoopbackPort() : 8000;
    const executable = app.isPackaged
        ? join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'unum-backend.exe' : 'unum-backend')
        : 'bash';
    if (app.isPackaged && !existsSync(executable))
        throw new Error(`Packaged backend missing: ${executable}`);
    backend = spawn(executable, app.isPackaged ? [] : [join(backendDir, 'start.sh')], {
        cwd: app.isPackaged ? workspace : backendDir,
        env: { ...process.env, UNUM_WORKSPACE: workspace, UNUM_IPC_TOKEN: token, UNUM_BACKEND_PORT: String(backendPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    backend.stdout?.on('data', (data) => process.stdout.write(data));
    backend.stderr?.on('data', (data) => process.stderr.write(data));
    backend.on('error', (error) => {
        console.error('Backend failed:', error);
        if (app.isPackaged && !stopping)
            dialog.showErrorBox('Unum backend failed', String(error));
    });
    backend.on('exit', (code) => {
        if (app.isPackaged && !stopping && code !== 0)
            dialog.showErrorBox('Unum backend stopped', `The bundled backend exited with code ${code}.`);
    });
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
app.whenReady().then(async () => {
    ipcMain.handle('unum:connection', () => ({ token, port: backendPort }));
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
    ipcMain.handle('unum:google-profile', () => storedProfile());
    ipcMain.handle('unum:google-login', (_event, clientId) => googleLogin(clientId));
    ipcMain.handle('unum:google-logout', () => { if (existsSync(sessionPath()))
        unlinkSync(sessionPath()); return true; });
    ipcMain.handle('unum:reveal-artifact', (_event, relative) => {
        shell.showItemInFolder(artifactPath(relative));
    });
    ipcMain.handle('unum:export-artifact', async (_event, relative) => {
        const source = artifactPath(relative);
        const result = await dialog.showSaveDialog({ defaultPath: basename(source), filters: [{ name: 'Android APK', extensions: ['apk'] }] });
        if (result.canceled || !result.filePath)
            return false;
        await copyFile(source, result.filePath);
        return true;
    });
    try {
        await launchBackend();
    }
    catch (error) {
        dialog.showErrorBox('Unum backend unavailable', String(error));
        app.quit();
        return;
    }
    createWindow();
});
app.on('before-quit', () => { stopping = true; backend?.kill('SIGTERM'); });
app.on('window-all-closed', () => {
    app.quit();
});
