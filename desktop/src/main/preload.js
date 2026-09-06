'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the renderer gets. No node, no ipcRenderer, no filesystem —
 * just these calls. Every argument crosses as structured-clonable data.
 */
contextBridge.exposeInMainWorld('llm', {
    /** Current state without waiting for the next phase transition. */
    snapshot: () => ipcRenderer.invoke('core:snapshot'),

    /** Re-run detection and ranking. Resolves with the final state. */
    scan: (opts) => ipcRenderer.invoke('core:scan', opts),

    /** Re-probe the local runtimes only. */
    detectRuntimes: () => ipcRenderer.invoke('runtimes:detect'),

    /** Deep data for one runtime's own view. Lazy — call on navigation. */
    runtimeDetails: (id) => ipcRenderer.invoke('runtimes:details', id),

    /** The CLI's capabilities as in-app actions, so no terminal is needed. */
    listActions: () => ipcRenderer.invoke('action:list'),
    runAction: (id, args) => ipcRenderer.invoke('action:run', { id, args }),

    /** install/pull/run/serve command set for a (runtime, modelRef) pair. */
    commandsFor: (runtime, ref) => ipcRenderer.invoke('runtimes:commands', { runtime, ref }),

    copy: (text) => ipcRenderer.invoke('clipboard:write', text),

    /** http(s) only; anything else is refused in the main process. */
    openExternal: (url) => ipcRenderer.invoke('shell:open', url),

    appInfo: () => ipcRenderer.invoke('app:info'),

    /** Synchronous platform id so the renderer can pick its chrome at once. */
    platform: process.platform,

    /** Frameless window controls — no-ops on macOS, which has real chrome. */
    winMinimize: () => ipcRenderer.invoke('win:minimize'),
    winMaximize: () => ipcRenderer.invoke('win:maximize'),
    winClose: () => ipcRenderer.invoke('win:close'),

    /**
     * Subscribe to phase transitions. Returns an unsubscribe function so the
     * renderer never leaks listeners across reloads.
     */
    onState: (handler) => {
        const wrapped = (_event, state) => handler(state);
        ipcRenderer.on('core:state', wrapped);
        return () => ipcRenderer.removeListener('core:state', wrapped);
    },
});
