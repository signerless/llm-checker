'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, shell, clipboard, nativeTheme } = require('electron');
const { Core } = require('./core');
const runtimes = require('./runtimes');

const IS_MAC = process.platform === 'darwin';

// One Core for the life of the app. This is the whole point of the desktop
// build: hardware detection and the 42 MB catalog load happen once, not on
// every invocation the way they do in the CLI.
const core = new Core();

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
    // No menu bar anywhere but macOS (whose edit shortcuts need it); the few
    // useful entries live in the app's own Settings view instead.
    if (!IS_MAC) Menu.setApplicationMenu(null);

    win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 860,
        minHeight: 560,
        show: false,                       // avoid a white flash; show on ready-to-show
        // macOS keeps its native chrome with real traffic lights; everywhere
        // else the window is frameless + transparent so the renderer can draw
        // the design's 10px-radius window on all four corners itself.
        ...(IS_MAC
            ? {
                backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
                titleBarStyle: 'hiddenInset',
                trafficLightPosition: { x: 20, y: 20 },
            }
            : {
                frame: false,
                transparent: true,
                backgroundColor: '#00000000',
            }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,                // preload needs require() for the bridge
            spellcheck: false,
        },
    });

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    win.once('ready-to-show', () => {
        win.show();
        // Kick the scan only after the window is up, so the first paint is not
        // blocked behind hardware probes.
        core.scan().catch((err) => console.error('[scan]', err));
    });

    // Push every phase transition to the renderer as it happens.
    core.on('state', (state) => {
        if (win && !win.isDestroyed()) win.webContents.send('core:state', state);
    });

    // External links open in the real browser, never in the app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    win.on('closed', () => { win = null; });
}

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });

    app.whenReady().then(() => {
        registerIpc();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}

function registerIpc() {
    // Renderer asks for the current snapshot on boot (it may attach after the
    // first phases have already fired).
    ipcMain.handle('core:snapshot', () => core.snapshot());

    ipcMain.handle('core:scan', async (_e, opts) => core.scan(opts ?? {}));

    ipcMain.handle('runtimes:detect', async () => {
        const hw = core.state.hardware ?? {};
        return runtimes.detectAll({ gpu: { vramGB: hw.vramGB }, summary: { backend: hw.backend } });
    });

    ipcMain.handle('runtimes:commands', (_e, { runtime, ref }) =>
        runtimes.commandsFor(runtime, ref)
    );

    // Deep probe for one runtime's detail view. Lazy on purpose — these cost
    // more than the per-scan detect(), so they only run when the user opens
    // that page.
    ipcMain.handle('runtimes:details', async (_e, runtime) => {
        const hw = core.state.hardware ?? {};
        return runtimes.details(runtime, {
            gpu: { vramGB: hw.vramGB },
            summary: { backend: hw.backend },
        });
    });

    ipcMain.handle('clipboard:write', (_e, text) => {
        clipboard.writeText(String(text ?? ''));
        return true;
    });

    // Only http(s) ever reaches the shell — never a file: or custom scheme.
    ipcMain.handle('shell:open', (_e, url) => {
        const u = String(url ?? '');
        if (!/^https?:\/\//i.test(u)) return false;
        shell.openExternal(u);
        return true;
    });

    // Run one of the CLI's capabilities in-process and hand back structured
    // output. The point of the desktop app is that none of this needs a
    // terminal, so these are real actions rather than commands to copy.
    ipcMain.handle('action:run', async (_e, { id, args } = {}) => {
        const started = Date.now();
        try {
            const result = await core.runAction(id, args ?? {});
            return { ok: true, id, ms: Date.now() - started, ...result };
        } catch (err) {
            return { ok: false, id, ms: Date.now() - started, error: err?.message ?? String(err) };
        }
    });

    ipcMain.handle('action:list', () => core.listActions());

    ipcMain.handle('app:info', () => ({
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
    }));

    // Frameless window controls (Linux/Windows — macOS has the real ones).
    ipcMain.handle('win:minimize', () => { win?.minimize(); return true; });
    ipcMain.handle('win:maximize', () => {
        if (!win) return false;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return win.isMaximized();
    });
    ipcMain.handle('win:close', () => { win?.close(); return true; });
}
