'use strict';

const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const { canStartProcessAudio, isTrustedUrl, sourceKind } = require('./capture-policy');

const APP_URL = 'https://mirotalk-dev.5-161-64-137.sslip.io/join/link';
const TRUSTED_ORIGIN = new URL(APP_URL).origin;
const nativeAudio = require(path.join(__dirname, '..', 'build', 'Release', 'process_loopback.node'));

let mainWindow;
let activePicker;
let nativeOwnerId = null;
const pendingSelections = new Map();
const authorizedProcesses = new Map();

function isTrustedWebContents(contents) {
    if (!contents || contents !== mainWindow?.webContents || contents.isDestroyed()) return false;
    return isTrustedUrl(contents.getURL(), TRUSTED_ORIGIN);
}

function assertTrusted(event) {
    if (!isTrustedWebContents(event.sender)) throw new Error('Origem não autorizada.');
}

async function chooseDesktopSource(parent) {
    if (activePicker) {
        activePicker.window.close();
        activePicker = null;
    }

    const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
    });
    const sourcesById = new Map(sources.map((source) => [source.id, source]));

    return new Promise((resolve) => {
        const pickerWindow = new BrowserWindow({
            width: 900,
            height: 650,
            minWidth: 680,
            minHeight: 480,
            modal: true,
            parent,
            show: false,
            autoHideMenuBar: true,
            title: 'Escolha o que compartilhar',
            webPreferences: {
                preload: path.join(__dirname, 'picker-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        const finish = (selection) => {
            if (!activePicker || activePicker.window !== pickerWindow) return;
            activePicker = null;
            resolve(selection);
            if (!pickerWindow.isDestroyed()) pickerWindow.close();
        };

        activePicker = { window: pickerWindow, finish, sourcesById };
        pickerWindow.on('closed', () => finish(null));
        pickerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        pickerWindow.webContents.on('will-navigate', (event) => event.preventDefault());
        pickerWindow.loadFile(path.join(__dirname, 'picker.html'));
        pickerWindow.once('ready-to-show', () => pickerWindow.show());
        pickerWindow.webContents.once('did-finish-load', () => {
            const serializable = sources.map((source) => ({
                id: source.id,
                name: source.name,
                kind: sourceKind(source.id),
                thumbnail: source.thumbnail.toDataURL(),
                appIcon: source.appIcon?.toDataURL() || null,
            }));
            pickerWindow.webContents.send('picker:sources', serializable);
        });
    });
}

function configureDisplayCapture() {
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
        return permission === 'media' && isTrustedUrl(requestingOrigin, TRUSTED_ORIGIN);
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        const allowed =
            permission === 'media' &&
            contents === mainWindow?.webContents &&
            isTrustedUrl(details.requestingUrl, TRUSTED_ORIGIN);
        callback(Boolean(allowed));
    });

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        if (!isTrustedUrl(request.securityOrigin, TRUSTED_ORIGIN) || !mainWindow || mainWindow.isDestroyed()) {
            callback(null);
            return;
        }

        try {
            const source = await chooseDesktopSource(mainWindow);
            if (!source) {
                callback(null);
                return;
            }

            const kind = sourceKind(source.id);
            if (!kind) throw new Error('Tipo de fonte desconhecido.');
            const processId = kind === 'window' ? nativeAudio.getWindowProcessId(source.id) : 0;
            pendingSelections.set(mainWindow.webContents.id, {
                sourceId: source.id,
                name: source.name,
                kind,
                processId,
            });

            callback({
                video: source,
                ...(kind === 'screen' && request.audioRequested ? { audio: 'loopback' } : {}),
            });
        } catch (error) {
            console.error('[display-capture]', error);
            callback(null);
        }
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 900,
        minHeight: 650,
        autoHideMenuBar: true,
        title: 'MiroTalk Desktop',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!isTrustedUrl(url, TRUSTED_ORIGIN)) event.preventDefault();
    });
    mainWindow.on('closed', () => {
        nativeAudio.stop();
        mainWindow = null;
    });
    mainWindow.loadURL(APP_URL);
}

ipcMain.on('picker:select', (event, sourceId) => {
    const picker = activePicker;
    if (!picker || event.sender !== picker.window.webContents) return;
    picker.finish(picker.sourcesById.get(sourceId) || null);
});

ipcMain.on('picker:cancel', (event) => {
    const picker = activePicker;
    if (picker && event.sender === picker.window.webContents) picker.finish(null);
});

ipcMain.handle('desktop-capture:consume-selection', (event) => {
    assertTrusted(event);
    const selection = pendingSelections.get(event.sender.id) || null;
    pendingSelections.delete(event.sender.id);
    if (selection?.kind === 'window' && selection.processId) {
        authorizedProcesses.set(event.sender.id, selection.processId);
    }
    return selection;
});

ipcMain.handle('desktop-capture:system-info', (event) => {
    assertTrusted(event);
    return {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        windows: nativeAudio.getWindowsBuild(),
        architecture: process.arch,
    };
});

ipcMain.handle('desktop-capture:start-audio', async (event, processId) => {
    assertTrusted(event);
    const ownerId = event.sender.id;
    if (!canStartProcessAudio(authorizedProcesses.get(ownerId), processId)) {
        throw new Error('O processo não corresponde à janela escolhida.');
    }

    nativeAudio.stop();
    nativeOwnerId = ownerId;

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            nativeAudio.stop();
            reject(new Error('A captura de áudio não respondeu em 12 segundos.'));
        }, 12000);

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            fn(value);
        };

        try {
            nativeAudio.start(processId, (message) => {
                if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== ownerId) return;
                if (message.type === 'ready') {
                    finish(resolve, {
                        sampleRate: message.sampleRate,
                        channels: message.channels,
                        system: nativeAudio.getWindowsBuild(),
                    });
                } else if (message.type === 'audio') {
                    mainWindow.webContents.send('desktop-capture:audio-frame', {
                        samples: message.data,
                        sampleRate: message.sampleRate,
                        channels: message.channels,
                    });
                } else if (message.type === 'error') {
                    finish(reject, new Error(message.message));
                    mainWindow.webContents.send('desktop-capture:audio-error', message.message);
                }
            });
        } catch (error) {
            finish(reject, error);
        }
    });
});

ipcMain.handle('desktop-capture:stop-audio', (event) => {
    assertTrusted(event);
    if (nativeOwnerId === event.sender.id) {
        nativeAudio.stop();
        nativeOwnerId = null;
    }
    authorizedProcesses.delete(event.sender.id);
    return true;
});

app.whenReady().then(() => {
    configureDisplayCapture();
    createMainWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => nativeAudio.stop());
