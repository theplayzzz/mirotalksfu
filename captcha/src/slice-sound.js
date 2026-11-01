// Short synthetic blade swish. No downloaded sounds or microphone access.
export function scheduleSlice(context, time = context.currentTime, combo = 1) {
  const length = 0.15,
    buffer = context.createBuffer(
      1,
      Math.ceil(context.sampleRate * length),
      context.sampleRate,
    );
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = context.createBufferSource(),
    filter = context.createBiquadFilter(),
    gain = context.createGain();
  const metal = context.createOscillator(),
    metalGain = context.createGain();
  noise.buffer = buffer;
  filter.type = "bandpass";
  filter.Q.value = 0.65;
  filter.frequency.setValueAtTime(5200, time);
  filter.frequency.exponentialRampToValueAtTime(1100, time + 0.13);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(0.1, time + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.145);
  noise.connect(filter).connect(gain).connect(context.destination);
  metal.type = "sine";
  metal.frequency.setValueAtTime(2600 + Math.min(combo, 3) * 100, time);
  metal.frequency.exponentialRampToValueAtTime(1200, time + 0.1);
  metalGain.gain.setValueAtTime(0.0001, time);
  metalGain.gain.linearRampToValueAtTime(0.016, time + 0.004);
  metalGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.11);
  metal.connect(metalGain).connect(context.destination);
  noise.start(time);
  noise.stop(time + length);
  metal.start(time);
  metal.stop(time + 0.12);
  noise.onended = () => {
    noise.disconnect();
    filter.disconnect();
    gain.disconnect();
    metal.disconnect();
    metalGain.disconnect();
  };
}

export function createSliceSound() {
  let context,
    last = -1;
  const unlock = async () => {
    try {
      context ||= new AudioContext();
      await context.resume();
      return context;
    } catch {
      return null;
    }
  };
  const play = async (combo = 1) => {
    const ctx = await unlock();
    if (!ctx || ctx.currentTime - last < 0.035) return;
    last = ctx.currentTime;
    try {
      scheduleSlice(ctx, ctx.currentTime, combo);
    } catch {
      /* Optional audio never blocks gameplay. */
    }
  };
  play.unlock = unlock;
  return play;
}
