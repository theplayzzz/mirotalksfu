'use strict';

const path = require('node:path');
const { app } = require('electron');

app.whenReady().then(() => {
    const addon = require(path.join(__dirname, '..', 'build', 'Release', 'process_loopback.node'));
    const system = addon.getWindowsBuild();
    if (!system?.build || typeof addon.start !== 'function' || typeof addon.stop !== 'function') {
        throw new Error('O módulo WASAPI não expôs a interface esperada.');
    }
    let finished = false;
    addon.start(process.pid, (message) => {
        if (finished) return;
        if (message.type === 'error') {
            finished = true;
            console.error(JSON.stringify({ nativeAddon: 'error', system, message: message.message }));
            setImmediate(() => {
                addon.stop();
                app.exit(1);
            });
            return;
        }
        if (message.type === 'ready') {
            finished = true;
            console.log(JSON.stringify({ nativeAddon: 'capture-ready', system }));
            setImmediate(() => {
                addon.stop();
                app.quit();
            });
        }
    });
});

setTimeout(() => {
    console.error('Tempo excedido ao iniciar a captura WASAPI por processo.');
    try {
        const addon = require(path.join(__dirname, '..', 'build', 'Release', 'process_loopback.node'));
        addon.stop();
    } catch {}
    app.exit(1);
}, 20000).unref();
