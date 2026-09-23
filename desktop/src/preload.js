'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback, transform = (value) => value) {
    if (typeof callback !== 'function') throw new TypeError('O listener precisa ser uma função.');
    const listener = (_event, payload) => callback(transform(payload));
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
    'mirotalkDesktop',
    Object.freeze({
        isDesktopApp: true,
        consumeSelection: () => ipcRenderer.invoke('desktop-capture:consume-selection'),
        getSystemInfo: () => ipcRenderer.invoke('desktop-capture:system-info'),
        startProcessAudio: (processId) => ipcRenderer.invoke('desktop-capture:start-audio', processId),
        stopProcessAudio: () => ipcRenderer.invoke('desktop-capture:stop-audio'),
        onAudioFrame: (callback) =>
            subscribe('desktop-capture:audio-frame', callback, (payload) => {
                const view = payload.samples;
                const samples = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
                return { ...payload, samples };
            }),
        onAudioError: (callback) => subscribe('desktop-capture:audio-error', callback),
    })
);
