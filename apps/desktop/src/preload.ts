// The app window's preload: the one seam between the server's pages and
// this machine. It exposes `window.lllmDesktop` so the frontend can tell it
// is running in the desktop app, and nothing else yet. Native features added
// here later (local coding-agent tools) must check, in their ipcMain
// handlers, that `event.senderFrame.origin` is the configured server, and be
// offered only over HTTPS or loopback: otherwise any page shown in this
// window could run things on this machine (docs/guides/desktop.md).
//
// Sandboxed, so it is CommonJS and imports nothing but electron.

import { contextBridge } from 'electron';

// app.getVersion() is main-process only; main.ts passes it as an argument.
const versionArg = process.argv.find((arg) => arg.startsWith('--lllm-desktop-version='));

contextBridge.exposeInMainWorld(
	'lllmDesktop',
	Object.freeze({
		platform: process.platform,
		version: versionArg ? versionArg.slice('--lllm-desktop-version='.length) : ''
	})
);
