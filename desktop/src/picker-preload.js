'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
    'sourcePicker',
    Object.freeze({
        onSources: (callback) => ipcRenderer.once('picker:sources', (_event, sources) => callback(sources)),
        select: (sourceId) => ipcRenderer.send('picker:select', sourceId),
        cancel: () => ipcRenderer.send('picker:cancel'),
    })
);
