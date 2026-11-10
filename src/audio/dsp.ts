export const TARGET_SAMPLE_RATE = 16_000;

export interface BiquadBandpassState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export function createBiquadBandpassState(): BiquadBandpassState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

export function resetBiquadBandpassState(state: BiquadBandpassState): void {
  state.x1 = 0;
  state.x2 = 0;
  state.y1 = 0;
  state.y2 = 0;
}

/**
 * Overwrites every float sample in a PCM buffer with 0.0 before releasing reference.
 */
export function secureZeroFloat32(buffer: Float32Array | null | undefined): void {
  if (buffer && buffer.length > 0) {
    buffer.fill(0);
  }
}

/**
 * Mixes arbitrary N-channel planar Float32Array inputs into a single mono Float32Array.
 */
export function mixChannelsToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) {
    return new Float32Array(0);
  }
  const frameLength = channels[0].length;
  if (channels.length === 1) {
    return new Float32Array(channels[0]);
  }
  const mono = new Float32Array(frameLength);
  const scale = 1 / channels.length;
  for (let ch = 0; ch < channels.length; ch++) {
    const channelData = channels[ch];
    const len = Math.min(frameLength, channelData.length);
    for (let i = 0; i < len; i++) {
      mono[i] += channelData[i] * scale;
    }
  }
  return mono;
}

/**
 * Anti-aliased resampler from hardware sampleRate (e.g. 48000 Hz or 44100 Hz)
 * to 16000 Hz mono PCM as required by Whisper feature extraction.
 * Uses boxcar integration across each source window to suppress high-frequency aliasing.
 */
export function downsampleTo16kHz(
  monoInput: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number = TARGET_SAMPLE_RATE,
): Float32Array {
  if (monoInput.length === 0) {
    return new Float32Array(0);
  }
  if (sourceSampleRate <= 0 || targetSampleRate <= 0) {
    throw new Error('Sample rates must be positive numbers.');
  }
  if (sourceSampleRate === targetSampleRate) {
    return new Float32Array(monoInput);
  }

  if (sourceSampleRate < targetSampleRate) {
    // Linear upsampling for unusual low-rate telephony endpoints (e.g. 8 kHz -> 16 kHz)
    const ratio = sourceSampleRate / targetSampleRate;
    const outLength = Math.max(1, Math.round(monoInput.length / ratio));
    const output = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = monoInput[Math.min(idx, monoInput.length - 1)];
      const s1 = monoInput[Math.min(idx + 1, monoInput.length - 1)];
      output[i] = s0 + (s1 - s0) * frac;
    }
    return output;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.floor(monoInput.length / ratio);
  if (outputLength === 0) {
    return new Float32Array(0);
  }

  const output = new Float32Array(outputLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < outputLength) {
    const nextOffsetBuffer = Math.min(
      monoInput.length,
      Math.round((offsetResult + 1) * ratio),
    );
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += monoInput[i];
      count += 1;
    }
    output[offsetResult] = count > 0 ? accum / count : monoInput[offsetBuffer] ?? 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return output;
}

export function rmsToDbfs(rms: number): number {
  if (rms <= 1e-6) {
    return -100;
  }
  return Math.max(-100, Math.min(0, 20 * Math.log10(rms)));
}

/**
 * Computes instantaneous audio level and telephony speech-band (300–3400 Hz @ 16 kHz)
 * energy ratio without retaining any audio samples.
 *
 * Precomputed RBJ bandpass biquad @ Fs = 16000 Hz, f0 = 1010 Hz, BW ~ 3.5 octaves (300–3400 Hz):
 */
const BP_B0 = 0.4208;
const BP_B1 = 0.0;
const BP_B2 = -0.4208;
const BP_A1 = -1.0235;
const BP_A2 = 0.1584;

export function analyzeAudioFrame16k(
  samples16k: Float32Array,
  filterState: BiquadBandpassState,
): {
  rms: number;
  peak: number;
  dbfs: number;
  speechBandRatio: number;
  clipping: boolean;
} {
  const n = samples16k.length;
  if (n === 0) {
    return { rms: 0, peak: 0, dbfs: -100, speechBandRatio: 0, clipping: false };
  }

  let sumSq = 0;
  let bandSumSq = 0;
  let peak = 0;

  let { x1, x2, y1, y2 } = filterState;

  for (let i = 0; i < n; i++) {
    const x0 = samples16k[i];
    const abs = Math.abs(x0);
    if (abs > peak) {
      peak = abs;
    }
    sumSq += x0 * x0;

    const y0 = BP_B0 * x0 + BP_B1 * x1 + BP_B2 * x2 - BP_A1 * y1 - BP_A2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    bandSumSq += y0 * y0;
  }

  filterState.x1 = x1;
  filterState.x2 = x2;
  filterState.y1 = y1;
  filterState.y2 = y2;

  const rms = Math.sqrt(sumSq / n);
  const dbfs = rmsToDbfs(rms);
  const speechBandRatio =
    sumSq > 1e-9 ? Math.min(1, Math.max(0, bandSumSq / sumSq)) : 0;

  return {
    rms,
    peak,
    dbfs,
    speechBandRatio,
    clipping: peak >= 0.985,
  };
}
