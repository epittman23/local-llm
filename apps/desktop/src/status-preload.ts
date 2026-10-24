// The progress and settings window's preload. Only static/status.html ever
// loads with it (its own window, never the app's), and main.ts's handlers
// refuse any other sender.
//
// Sandboxed, so it is CommonJS and imports nothing but electron.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('lllmStatus', {
	ready: () => ipcRenderer.invoke('status:ready'),
	onUpdate: (callback: (progress: unknown) => void) =>
		ipcRenderer.on('status:update', (_event, progress) => callback(progress)),
	onView: (callback: (view: string) => void) => ipcRenderer.on('status:view', (_event, view) => callback(view)),
	action: (name: string) => ipcRenderer.invoke('status:action', name),
	getSettings: () => ipcRenderer.invoke('status:get-settings'),
	saveSettings: (settings: { serverUrl: string; repoPath: string }) =>
		ipcRenderer.invoke('status:save-settings', settings),
	browseRepo: () => ipcRenderer.invoke('status:browse-repo')
});
