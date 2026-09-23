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
    let activated = false;
    addon.start(process.pid, (message) => {
        if (finished) return;
        if (message.type === 'activated') {
            activated = true;
            console.log(JSON.stringify({ nativeAddon: 'process-activation-ready', system }));
            return;
        }
        if (message.type === 'error') {
            finished = true;
            const headlessRunnerWithoutEndpoint = activated && /HRESULT 0x88890010\b/.test(message.message);
            const output = {
                nativeAddon: headlessRunnerWithoutEndpoint ? 'activation-only' : 'error',
                system,
                message: message.message,
            };
            (headlessRunnerWithoutEndpoint ? console.warn : console.error)(JSON.stringify(output));
            setImmediate(() => {
                addon.stop();
                app.exit(headlessRunnerWithoutEndpoint ? 0 : 1);
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
