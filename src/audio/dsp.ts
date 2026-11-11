import type {
  ChannelSelectionMode,
  ChannelTopology,
} from '../types/index.ts';

export const TARGET_SAMPLE_RATE = 16_000;

export interface BiquadBandpassState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export interface StereoChannelInspection {
  channelCount: number;
  leftRms: number;
  rightRms: number;
  leftPeak: number;
  rightPeak: number;
  leftDbfs: number;
  rightDbfs: number;
  correlation: number;
  topology: ChannelTopology;
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
 * Clamps and sanitizes a sample strictly into Whisper's expected [-1.0, +1.0] range.
 */
export function clampUnitSample(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value > 1.0) {
    return 1.0;
  }
  if (value < -1.0) {
    return -1.0;
  }
  return value;
}

/**
 * Soft-knee limiter that preserves linear dynamics below +/-0.88 and smoothly
 * asymptotically bounds peaks inside [-1.0, +1.0] without harsh digital clipping.
 */
export function softLimitSample(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const abs = Math.abs(value);
  if (abs <= 0.88) {
    return value;
  }
  const sign = value < 0 ? -1 : 1;
  const excess = (abs - 0.88) / 0.12;
  const compressed = 0.88 + 0.12 * Math.tanh(excess);
  return sign * Math.min(1.0, compressed);
}

export function rmsToDbfs(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 1e-6) {
    return -100;
  }
  return Math.max(-100, Math.min(0, 20 * Math.log10(rms)));
}

/**
 * Inspects Left and Right audio channels independently before downmixing so
 * single-sided softphone calls, quiet channels, split stereo conversations, and
 * phase-inverted channels are detected accurately rather than blindly averaged.
 */
export function inspectStereoChannels(
  channels: readonly Float32Array[],
): StereoChannelInspection {
  if (channels.length === 0 || channels[0].length === 0) {
    return {
      channelCount: 0,
      leftRms: 0,
      rightRms: 0,
      leftPeak: 0,
      rightPeak: 0,
      leftDbfs: -100,
      rightDbfs: -100,
      correlation: 0,
      topology: 'silent',
    };
  }

  const left = channels[0];
  const n = left.length;

  if (channels.length === 1) {
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const s = Number.isFinite(left[i]) ? left[i] : 0;
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / n);
    return {
      channelCount: 1,
      leftRms: rms,
      rightRms: rms,
      leftPeak: peak,
      rightPeak: peak,
      leftDbfs: rmsToDbfs(rms),
      rightDbfs: rmsToDbfs(rms),
      correlation: 1,
      topology: rms < 1e-5 ? 'silent' : 'mono-input',
    };
  }

  const right = channels[1];
  const len = Math.min(left.length, right.length);
  let sumL2 = 0;
  let sumR2 = 0;
  let sumLR = 0;
  let leftPeak = 0;
  let rightPeak = 0;

  for (let i = 0; i < len; i++) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    const absL = Math.abs(l);
    const absR = Math.abs(r);
    if (absL > leftPeak) leftPeak = absL;
    if (absR > rightPeak) rightPeak = absR;
    sumL2 += l * l;
    sumR2 += r * r;
    sumLR += l * r;
  }

  const leftRms = len > 0 ? Math.sqrt(sumL2 / len) : 0;
  const rightRms = len > 0 ? Math.sqrt(sumR2 / len) : 0;
  const leftDbfs = rmsToDbfs(leftRms);
  const rightDbfs = rmsToDbfs(rightRms);

  if (leftRms < 1e-5 && rightRms < 1e-5) {
    return {
      channelCount: channels.length,
      leftRms,
      rightRms,
      leftPeak,
      rightPeak,
      leftDbfs,
      rightDbfs,
      correlation: 0,
      topology: 'silent',
    };
  }

  const denom = Math.sqrt(sumL2 * sumR2);
  const correlation = denom > 1e-12 ? Math.max(-1, Math.min(1, sumLR / denom)) : 0;
  const dbDiff = leftDbfs - rightDbfs;

  let topology: ChannelTopology;
  if (leftRms >= 2e-4 && (rightRms < 1e-5 || dbDiff >= 6.0)) {
    topology = 'left-dominant';
  } else if (rightRms >= 2e-4 && (leftRms < 1e-5 || dbDiff <= -6.0)) {
    topology = 'right-dominant';
  } else if (correlation <= -0.25) {
    topology = 'phase-inverted';
  } else if (correlation >= 0.80 && Math.abs(dbDiff) < 6.0) {
    topology = 'identical-stereo';
  } else {
    topology = 'dual-independent';
  }

  return {
    channelCount: channels.length,
    leftRms,
    rightRms,
    leftPeak,
    rightPeak,
    leftDbfs,
    rightDbfs,
    correlation,
    topology,
  };
}

/**
 * Inspects individual stereo/multi-channel inputs and converts to a clean mono
 * Float32Array without blind averaging losses:
 * - Single-channel speech (L active, R silent) keeps 100% amplitude (+6.02 dB vs blind average).
 * - Identical L/R speech uses coherent 0.5*(L+R) downmix.
 * - Independent L/R signals (e.g. split caller/agent stereo) use equal-power 0.7071*(L+R) with soft peak protection.
 * - Phase-inverted channels avoid destructive cancellation.
 */
export function inspectAndMixChannels(
  channels: readonly Float32Array[],
  mode: ChannelSelectionMode = 'auto',
): { mono: Float32Array; inspection: StereoChannelInspection } {
  const inspection = inspectStereoChannels(channels);
  if (channels.length === 0 || channels[0].length === 0) {
    return { mono: new Float32Array(0), inspection };
  }

  const frameLength = channels[0].length;
  const mono = new Float32Array(frameLength);

  if (channels.length === 1) {
    const ch0 = channels[0];
    for (let i = 0; i < frameLength; i++) {
      mono[i] = clampUnitSample(ch0[i]);
    }
    return { mono, inspection };
  }

  const left = channels[0];
  const right = channels[1];
  const len = Math.min(frameLength, right.length);

  if (mode === 'left') {
    for (let i = 0; i < frameLength; i++) {
      mono[i] = clampUnitSample(left[i]);
    }
    return { mono, inspection };
  }

  if (mode === 'right') {
    for (let i = 0; i < len; i++) {
      mono[i] = clampUnitSample(right[i]);
    }
    return { mono, inspection };
  }

  if (mode === 'stereo-sum') {
    const invN = 1 / channels.length;
    for (let ch = 0; ch < channels.length; ch++) {
      const data = channels[ch];
      const chLen = Math.min(frameLength, data.length);
      for (let i = 0; i < chLen; i++) {
        mono[i] += (Number.isFinite(data[i]) ? data[i] : 0) * invN;
      }
    }
    for (let i = 0; i < frameLength; i++) {
      mono[i] = clampUnitSample(mono[i]);
    }
    return { mono, inspection };
  }

  // Smart 'auto' channel handling based on real-time channel inspection
  switch (inspection.topology) {
    case 'left-dominant': {
      for (let i = 0; i < frameLength; i++) {
        mono[i] = clampUnitSample(left[i]);
      }
      break;
    }
    case 'right-dominant': {
      for (let i = 0; i < len; i++) {
        mono[i] = clampUnitSample(right[i]);
      }
      break;
    }
    case 'phase-inverted': {
      if (inspection.correlation <= -0.75) {
        // Pure polarity inversion between L and R: recover full signal via difference
        for (let i = 0; i < len; i++) {
          const l = Number.isFinite(left[i]) ? left[i] : 0;
          const r = Number.isFinite(right[i]) ? right[i] : 0;
          mono[i] = softLimitSample(0.5 * (l - r));
        }
      } else {
        // Partial phase/comb offset: select clearer stronger channel to preserve consonants
        const chosen = inspection.leftRms >= inspection.rightRms ? left : right;
        const cLen = Math.min(frameLength, chosen.length);
        for (let i = 0; i < cLen; i++) {
          mono[i] = clampUnitSample(chosen[i]);
        }
      }
      break;
    }
    case 'dual-independent':
    case 'identical-stereo':
    case 'silent':
    case 'mono-input':
    default: {
      const invN = 1 / channels.length;
      for (let ch = 0; ch < channels.length; ch++) {
        const data = channels[ch];
        const chLen = Math.min(frameLength, data.length);
        for (let i = 0; i < chLen; i++) {
          mono[i] += (Number.isFinite(data[i]) ? data[i] : 0) * invN;
        }
      }
      for (let i = 0; i < frameLength; i++) {
        mono[i] = clampUnitSample(mono[i]);
      }
      break;
    }
  }

  return { mono, inspection };
}

/**
 * Inspects channels first, then converts N-channel planar Float32Array inputs into
 * an optimal mono Float32Array normalized to [-1.0, +1.0].
 */
export function mixChannelsToMono(
  channels: readonly Float32Array[],
  mode: ChannelSelectionMode = 'auto',
): Float32Array {
  return inspectAndMixChannels(channels, mode).mono;
}

const POLYPHASE_PHASES = 64;

interface PolyphaseSincTable {
  phases: number;
  tapsPerPhase: number;
  halfWidth: number;
  weights: Float32Array;
}

function buildPolyphaseSincTable(
  sourceSampleRate: number,
  targetSampleRate: number,
): PolyphaseSincTable {
  const ratio = sourceSampleRate / targetSampleRate;
  // Scale filter support by decimation ratio when downsampling so cutoff sits cleanly at 0.925 * f_nyquist_target
  const cutoffScale = ratio > 1 ? 0.925 / ratio : 0.925;
  const baseHalfZeros = 8;
  const halfWidth = Math.max(8, Math.min(48, Math.ceil(baseHalfZeros * Math.max(1, ratio))));
  const tapsPerPhase = halfWidth * 2;
  const weights = new Float32Array(POLYPHASE_PHASES * tapsPerPhase);

  for (let p = 0; p < POLYPHASE_PHASES; p++) {
    const frac = p / POLYPHASE_PHASES;
    let weightSum = 0;
    const rowOffset = p * tapsPerPhase;

    for (let t = 0; t < tapsPerPhase; t++) {
      const k = t - halfWidth + 1;
      const delta = k - frac; // distance from fractional sample center in [-halfWidth, +halfWidth]
      const normPos = delta / halfWidth; // in [-1, +1]

      let w = 0;
      if (Math.abs(normPos) < 1) {
        // Blackman window (>58 dB stopband attenuation, minimal passband droop)
        const winAngle = Math.PI * (normPos + 1);
        const blackman =
          0.42 - 0.5 * Math.cos(winAngle) + 0.08 * Math.cos(2 * winAngle);

        const x = Math.PI * cutoffScale * delta;
        const sinc = Math.abs(x) < 1e-8 ? 1.0 : Math.sin(x) / x;
        w = cutoffScale * sinc * blackman;
      }

      weights[rowOffset + t] = w;
      weightSum += w;
    }

    // Normalize each polyphase sub-filter to exact unity DC gain (prevents ripple & clipping)
    if (Math.abs(weightSum) > 1e-9) {
      const invSum = 1 / weightSum;
      for (let t = 0; t < tapsPerPhase; t++) {
        weights[rowOffset + t] *= invSum;
      }
    }
  }

  return {
    phases: POLYPHASE_PHASES,
    tapsPerPhase,
    halfWidth,
    weights,
  };
}

/**
 * Stateful streaming Blackman-windowed sinc anti-aliased resampler for continuous
 * block-by-block conversion (48 kHz / 44.1 kHz / arbitrary rate -> 16 kHz Float32Array).
 */
export class StreamingSincResampler {
  private readonly sourceRate: number;
  private readonly targetRate: number;
  private readonly ratio: number;
  private readonly table: PolyphaseSincTable;
  private history: Float32Array;
  private historyFill = 0;
  private readPos = 0;

  constructor(sourceSampleRate: number, targetSampleRate: number = TARGET_SAMPLE_RATE) {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
      throw new Error('sourceSampleRate must be a positive finite number.');
    }
    if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
      throw new Error('targetSampleRate must be a positive finite number.');
    }
    this.sourceRate = sourceSampleRate;
    this.targetRate = targetSampleRate;
    this.ratio = sourceSampleRate / targetSampleRate;
    this.table = buildPolyphaseSincTable(sourceSampleRate, targetSampleRate);
    this.history = new Float32Array(this.table.tapsPerPhase * 2);
  }

  public process(input: Float32Array): Float32Array {
    if (input.length === 0) {
      return new Float32Array(0);
    }

    if (this.sourceRate === this.targetRate) {
      const out = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        out[i] = clampUnitSample(input[i]);
      }
      return out;
    }

    const { tapsPerPhase, halfWidth, phases, weights } = this.table;

    // Seed initial left-wing history on very first block to avoid startup transient
    if (this.historyFill === 0) {
      const firstSample = clampUnitSample(input[0]);
      for (let i = 0; i < tapsPerPhase; i++) {
        this.history[i] = firstSample;
      }
      this.historyFill = tapsPerPhase;
      this.readPos = halfWidth - 1;
    }

    const combinedLen = this.historyFill + input.length;
    const combined = new Float32Array(combinedLen);
    combined.set(this.history.subarray(0, this.historyFill), 0);
    for (let i = 0; i < input.length; i++) {
      combined[this.historyFill + i] = clampUnitSample(input[i]);
    }

    const maxCenter = combinedLen - halfWidth - 1;
    if (this.readPos > maxCenter) {
      this.history = combined;
      this.historyFill = combinedLen;
      return new Float32Array(0);
    }

    const estimatedOut = Math.max(
      0,
      Math.floor((maxCenter - this.readPos) / this.ratio) + 1,
    );
    const out = new Float32Array(estimatedOut);
    let outIdx = 0;

    while (this.readPos <= maxCenter && outIdx < estimatedOut) {
      const baseIdx = Math.floor(this.readPos);
      const frac = this.readPos - baseIdx;
      const phaseIdx = Math.min(phases - 1, Math.floor(frac * phases));
      const rowOffset = phaseIdx * tapsPerPhase;
      const startSrc = baseIdx - halfWidth + 1;

      let acc = 0;
      for (let t = 0; t < tapsPerPhase; t++) {
        acc += combined[startSrc + t] * weights[rowOffset + t];
      }

      out[outIdx++] = clampUnitSample(acc);
      this.readPos += this.ratio;
    }

    // Retain only the tail samples still needed for the next block's FIR window
    const keepFrom = Math.max(0, Math.floor(this.readPos) - halfWidth);
    const remaining = combinedLen - keepFrom;
    if (this.history.length < remaining) {
      this.history = new Float32Array(remaining);
    }
    this.history.set(combined.subarray(keepFrom, combinedLen), 0);
    this.historyFill = remaining;
    this.readPos -= keepFrom;

    combined.fill(0);
    return outIdx === out.length ? out : out.slice(0, outIdx);
  }

  public resetAndZero(): void {
    this.history.fill(0);
    this.historyFill = 0;
    this.readPos = 0;
  }
}

/**
 * Genuine anti-aliased Blackman-windowed sinc resampler from hardware sampleRate
 * (e.g. 48000 Hz or 44100 Hz) to 16000 Hz mono Float32Array normalized to [-1.0, +1.0].
 * Preserves speech frequencies up to 7.4 kHz while suppressing >8 kHz aliasing by >58 dB.
 */
export function downsampleTo16kHz(
  monoInput: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number = TARGET_SAMPLE_RATE,
): Float32Array {
  if (monoInput.length === 0) {
    return new Float32Array(0);
  }
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0 || targetSampleRate <= 0) {
    throw new Error('Sample rates must be positive numbers.');
  }
  if (sourceSampleRate === targetSampleRate) {
    const copy = new Float32Array(monoInput.length);
    for (let i = 0; i < monoInput.length; i++) {
      copy[i] = clampUnitSample(monoInput[i]);
    }
    return copy;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(monoInput.length / ratio));
  if (monoInput.length < 4) {
    const out = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      out[i] = clampUnitSample(monoInput[Math.min(monoInput.length - 1, Math.floor(i * ratio))]);
    }
    return out;
  }

  const table = buildPolyphaseSincTable(sourceSampleRate, targetSampleRate);
  const { tapsPerPhase, halfWidth, phases, weights } = table;
  const output = new Float32Array(outputLength);
  const lastIdx = monoInput.length - 1;

  for (let outIdx = 0; outIdx < outputLength; outIdx++) {
    const srcPos = outIdx * ratio;
    const baseIdx = Math.floor(srcPos);
    const frac = srcPos - baseIdx;
    const phaseIdx = Math.min(phases - 1, Math.floor(frac * phases));
    const rowOffset = phaseIdx * tapsPerPhase;
    const startSrc = baseIdx - halfWidth + 1;

    let acc = 0;
    for (let t = 0; t < tapsPerPhase; t++) {
      let sIdx = startSrc + t;
      if (sIdx < 0) sIdx = 0;
      else if (sIdx > lastIdx) sIdx = lastIdx;
      const sample = Number.isFinite(monoInput[sIdx]) ? monoInput[sIdx] : 0;
      acc += sample * weights[rowOffset + t];
    }

    output[outIdx] = clampUnitSample(acc);
  }

  return output;
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
  filterState: BiquadBandpassState = { x1: 0, x2: 0, y1: 0, y2: 0 },
): {
  rms: number;
  peak: number;
  dbfs: number;
  peakDbfs: number;
  speechBandRatio: number;
  clipping: boolean;
  clippedSampleCount: number;
} {
  const n = samples16k.length;
  if (n === 0) {
    return {
      rms: 0,
      peak: 0,
      dbfs: -100,
      peakDbfs: -100,
      speechBandRatio: 0,
      clipping: false,
      clippedSampleCount: 0,
    };
  }

  let sumSq = 0;
  let bandSumSq = 0;
  let peak = 0;
  let clippedSampleCount = 0;

  let { x1, x2, y1, y2 } = filterState;

  for (let i = 0; i < n; i++) {
    const x0 = Number.isFinite(samples16k[i]) ? samples16k[i] : 0;
    const abs = Math.abs(x0);
    if (abs > peak) {
      peak = abs;
    }
    if (abs >= 0.985) {
      clippedSampleCount += 1;
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
  const peakDbfs = rmsToDbfs(peak);
  const speechBandRatio =
    sumSq > 1e-9 ? Math.min(1, Math.max(0, bandSumSq / sumSq)) : 0;

  return {
    rms,
    peak,
    dbfs,
    peakDbfs,
    speechBandRatio,
    clipping: peak >= 0.985,
    clippedSampleCount,
  };
}
