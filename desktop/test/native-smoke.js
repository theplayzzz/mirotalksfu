'use strict';

const path = require('node:path');
const { app } = require('electron');

app.whenReady().then(() => {
    const addon = require(path.join(__dirname, '..', 'build', 'Release', 'process_loopback.node'));
    const system = addon.getWindowsBuild();
    if (!system?.build || typeof addon.start !== 'function' || typeof addon.stop !== 'function') {
        throw new Error('O módulo WASAPI não expôs a interface esperada.');
    }
    console.log(JSON.stringify({ nativeAddon: 'ok', system }));
    app.quit();
});

setTimeout(() => {
    console.error('Tempo excedido ao carregar o módulo nativo.');
    app.exit(1);
}, 15000).unref();
