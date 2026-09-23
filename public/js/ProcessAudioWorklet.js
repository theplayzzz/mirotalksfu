'use strict';

class MiroTalkProcessAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queue = [];
        this.offset = 0;
        this.inputRate = sampleRate;
        this.channels = 2;
        this.port.onmessage = ({ data }) => {
            if (!data?.samples) return;
            const bytes = data.samples instanceof ArrayBuffer ? data.samples : data.samples.buffer;
            this.inputRate = data.sampleRate || sampleRate;
            this.channels = data.channels || 2;
            this.queue.push(new Int16Array(bytes));
        };
    }

    process(_inputs, outputs) {
        const output = outputs[0];
        if (!output?.length) return true;

        // Native capture is requested at the AudioContext rate (48 kHz). Keep
        // silence when no packet is ready; never replay stale audio.
        for (let frame = 0; frame < output[0].length; frame++) {
            while (this.queue.length && this.offset >= this.queue[0].length) {
                this.queue.shift();
                this.offset = 0;
            }

            const packet = this.queue[0];
            if (!packet) {
                for (const channel of output) channel[frame] = 0;
                continue;
            }

            for (let channel = 0; channel < output.length; channel++) {
                const sourceChannel = Math.min(channel, this.channels - 1);
                const index = this.offset + sourceChannel;
                output[channel][frame] = (packet[index] || 0) / 32768;
            }
            this.offset += this.channels;
        }
        return true;
    }
}

registerProcessor('mirotalk-process-audio', MiroTalkProcessAudioProcessor);
