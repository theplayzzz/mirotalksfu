'use strict';

/**
 * Desktop capture adapter.
 *
 * Browsers keep using getDisplayMedia unchanged. The Electron build exposes a
 * deliberately small bridge that selects a window and supplies PCM audio from
 * that window's process tree. No system-audio fallback is used for windows.
 */

let desktopCaptureCleanup = null;

async function getMiroTalkDisplayMedia(constraints) {
    const desktop = window.mirotalkDesktop;
    if (!desktop?.isDesktopApp) {
        return navigator.mediaDevices.getDisplayMedia(constraints);
    }

    await stopMiroTalkDesktopCapture();

    const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    const selection = await desktop.consumeSelection();

    if (!selection) {
        stopStream(stream);
        throw new Error('O aplicativo não recebeu a fonte selecionada.');
    }

    // A complete screen intentionally keeps Electron's system-loopback track.
    if (selection.kind === 'screen') {
        showDesktopCaptureStatus('Tela inteira · áudio do sistema');
        desktopCaptureCleanup = async () => {
            hideDesktopCaptureStatus();
            stopStream(stream);
        };
        bindCaptureCleanup(stream.getVideoTracks()[0]);
        return stream;
    }

    // Electron must not return a loopback track for a window. If it does, fail
    // closed instead of risking transmission of unrelated system audio.
    for (const track of stream.getAudioTracks()) track.stop();

    if (!selection.processId) {
        stopStream(stream);
        throw new Error('Não foi possível identificar o processo da janela selecionada.');
    }

    let audioContext;
    let audioNode;
    let destination;
    let removeAudioListener = () => {};
    let removeErrorListener = () => {};

    try {
        audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        await audioContext.audioWorklet.addModule('/js/ProcessAudioWorklet.js');

        destination = audioContext.createMediaStreamDestination();
        audioNode = new AudioWorkletNode(audioContext, 'mirotalk-process-audio', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        audioNode.connect(destination);

        removeAudioListener = desktop.onAudioFrame((frame) => {
            if (!frame?.samples) return;
            audioNode.port.postMessage({
                samples: frame.samples,
                channels: frame.channels,
                sampleRate: frame.sampleRate,
            });
        });
        removeErrorListener = desktop.onAudioError((message) => {
            console.error('[DesktopCapture] process audio failed:', message);
            showDesktopCaptureStatus(`Falha no áudio da aplicação: ${message}`, true);
            stopMiroTalkDesktopCapture();
        });

        await desktop.startProcessAudio(selection.processId);
        await audioContext.resume();

        const audioTrack = destination.stream.getAudioTracks()[0];
        if (!audioTrack) throw new Error('A faixa de áudio isolado não foi criada.');

        const combined = new MediaStream([...stream.getVideoTracks(), audioTrack]);
        showDesktopCaptureStatus(`Áudio da aplicação · ${selection.name}`);

        desktopCaptureCleanup = async () => {
            removeAudioListener();
            removeErrorListener();
            desktopCaptureCleanup = null;
            hideDesktopCaptureStatus();
            await desktop.stopProcessAudio().catch(() => {});
            audioNode?.disconnect();
            destination?.disconnect?.();
            stopStream(stream);
            stopStream(combined);
            if (audioContext && audioContext.state !== 'closed') await audioContext.close();
        };

        bindCaptureCleanup(combined.getVideoTracks()[0]);
        return combined;
    } catch (error) {
        removeAudioListener();
        removeErrorListener();
        await desktop.stopProcessAudio().catch(() => {});
        audioNode?.disconnect();
        stopStream(stream);
        if (audioContext && audioContext.state !== 'closed') await audioContext.close();
        throw new Error(`Não foi possível iniciar o áudio isolado: ${error.message}`);
    }
}

async function stopMiroTalkDesktopCapture() {
    const cleanup = desktopCaptureCleanup;
    desktopCaptureCleanup = null;
    if (cleanup) await cleanup();
}

function bindCaptureCleanup(videoTrack) {
    if (!videoTrack) return;
    videoTrack.addEventListener('ended', () => stopMiroTalkDesktopCapture(), { once: true });
}

function stopStream(stream) {
    stream?.getTracks().forEach((track) => track.stop());
}

function showDesktopCaptureStatus(text, error = false) {
    let status = document.getElementById('mirotalk-desktop-capture-status');
    if (!status) {
        status = document.createElement('div');
        status.id = 'mirotalk-desktop-capture-status';
        Object.assign(status.style, {
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            zIndex: '100000',
            padding: '9px 13px',
            borderRadius: '8px',
            color: '#fff',
            font: '600 13px system-ui, sans-serif',
            boxShadow: '0 4px 18px rgba(0,0,0,.35)',
        });
        document.body.appendChild(status);
    }
    status.style.background = error ? '#b3261e' : '#157347';
    status.textContent = text;
}

function hideDesktopCaptureStatus() {
    document.getElementById('mirotalk-desktop-capture-status')?.remove();
}

window.addEventListener('beforeunload', () => stopMiroTalkDesktopCapture());
