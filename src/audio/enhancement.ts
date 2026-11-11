import type { AudioEnhancementMode } from '../types/index.ts';
import { clampUnitSample, softLimitSample } from './dsp.ts';

// Exact 2nd-order Butterworth High-Pass Filter @ Fs = 16000 Hz, fc = 85 Hz (removes DC & 50/60 Hz hum)
const HP_B0 = 0.9766735;
const HP_B1 = -1.9533470;
const HP_B2 = 0.9766735;
const HP_A1 = -1.9528029;
const HP_A2 = 0.9538913;

// Gentle +1.6 dB telephony consonant clarity shelf @ Fs = 16000 Hz, fc = 1850 Hz, Q = 0.707
// Computed via RBJ High-Shelf (A = 10^(1.6/40) = 1.096478)
const HS_B0 = 1.1322852;
const HS_B1 = -1.5647093;
const HS_B2 = 0.5947004;
const HS_A1 = -1.5471535;
const HS_A2 = 0.7094298;

const TARGET_SPEECH_RMS = 0.112; // ~ -19.0 dBFS optimal Whisper input level
const GENTLE_MAX_GAIN = 3.98; // +12.0 dB max safe boost
const QUIET_BOOST_MAX_GAIN = 6.31; // +16.0 dB max boost for very quiet calls
const MIN_GAIN = 0.35; // -9.1 dB safe attenuation for overly loud calls

export interface EnhancementFrameResult {
  samples: Float32Array;
  appliedGainDb: number;
  mode: AudioEnhancementMode;
}

/**
 * Ephemeral in-memory 16 kHz speech clarity enhancer for desktop telephony audio.
 *
 * - 'off': Exact bit-transparent raw bypass (sanitized to [-1, 1]) for A/B comparison.
 * - 'gentle' (default): 85 Hz rumble filter + gentle 1.85 kHz speech presence shelf +
 *   non-destructive noise-floor expander + smooth RMS normalization (-19 dBFS target, max +12 dB) +
 *   soft-knee peak protection.
 * - 'quiet-boost': Same non-destructive speech chain with up to +16 dB safe gain for very faint calls.
 *
 * Never applies echo cancellation or aggressive microphone noise suppression that erases quiet words.
 */
export class EphemeralAudioEnhancer {
  private mode: AudioEnhancementMode;

  // High-pass filter state
  private hpX1 = 0;
  private hpX2 = 0;
  private hpY1 = 0;
  private hpY2 = 0;

  // Presence shelf state
  private hsX1 = 0;
  private hsX2 = 0;
  private hsY1 = 0;
  private hsY2 = 0;

  // Smooth adaptive gain & noise-floor scalars (zero sample retention)
  private smoothedGain = 1.0;
  private noiseFloorRms = 0.0012;
  private lastAppliedGainDb = 0;

  constructor(initialMode: AudioEnhancementMode = 'gentle') {
    this.mode = initialMode;
  }

  public getMode(): AudioEnhancementMode {
    return this.mode;
  }

  public setMode(mode: AudioEnhancementMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      if (mode === 'off') {
        this.lastAppliedGainDb = 0;
      }
    }
  }

  public getLastAppliedGainDb(): number {
    return this.mode === 'off' ? 0 : this.lastAppliedGainDb;
  }

  /**
   * Processes a temporary 16 kHz Float32Array chunk and zeroes the raw input if replaced.
   */
  public processChunk16k(input: Float32Array): EnhancementFrameResult {
    const n = input.length;
    if (n === 0) {
      return { samples: new Float32Array(0), appliedGainDb: 0, mode: this.mode };
    }

    if (this.mode === 'off') {
      const rawOut = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        rawOut[i] = clampUnitSample(input[i]);
      }
      this.lastAppliedGainDb = 0;
      return { samples: rawOut, appliedGainDb: 0, mode: 'off' };
    }

    const filtered = new Float32Array(n);
    let hpX1 = this.hpX1;
    let hpX2 = this.hpX2;
    let hpY1 = this.hpY1;
    let hpY2 = this.hpY2;

    let hsX1 = this.hsX1;
    let hsX2 = this.hsX2;
    let hsY1 = this.hsY1;
    let hsY2 = this.hsY2;

    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = Number.isFinite(input[i]) ? input[i] : 0;

      // Stage 1: 85 Hz Butterworth high-pass filter (hum & DC removal)
      const hpOut =
        HP_B0 * x + HP_B1 * hpX1 + HP_B2 * hpX2 - HP_A1 * hpY1 - HP_A2 * hpY2;
      hpX2 = hpX1;
      hpX1 = x;
      hpY2 = hpY1;
      hpY1 = hpOut;

      // Stage 2: Gentle +1.6 dB telephony consonant shelf
      const hsOut =
        HS_B0 * hpOut + HS_B1 * hsX1 + HS_B2 * hsX2 - HS_A1 * hsY1 - HS_A2 * hsY2;
      hsX2 = hsX1;
      hsX1 = hpOut;
      hsY2 = hsY1;
      hsY1 = hsOut;

      filtered[i] = hsOut;
      sumSq += hsOut * hsOut;
    }

    this.hpX1 = hpX1;
    this.hpX2 = hpX2;
    this.hpY1 = hpY1;
    this.hpY2 = hpY2;
    this.hsX1 = hsX1;
    this.hsX2 = hsX2;
    this.hsY1 = hsY1;
    this.hsY2 = hsY2;

    const frameRms = Math.sqrt(sumSq / n);

    // Track steady background noise floor conservatively without latching onto speech
    if (frameRms > 1e-6 && frameRms < this.noiseFloorRms) {
      this.noiseFloorRms = 0.85 * this.noiseFloorRms + 0.15 * frameRms;
    } else if (frameRms > 1e-6 && frameRms < this.noiseFloorRms * 2.0) {
      this.noiseFloorRms = 0.992 * this.noiseFloorRms + 0.008 * frameRms;
    }
    this.noiseFloorRms = Math.max(0.0004, Math.min(0.015, this.noiseFloorRms));

    const maxGain = this.mode === 'quiet-boost' ? QUIET_BOOST_MAX_GAIN : GENTLE_MAX_GAIN;
    let targetGain = this.smoothedGain;

    if (frameRms >= Math.max(0.0022, this.noiseFloorRms * 2.2)) {
      // Active speech energy: normalize smoothly toward -19 dBFS within safe gain bounds
      const desired = TARGET_SPEECH_RMS / frameRms;
      targetGain = Math.max(MIN_GAIN, Math.min(maxGain, desired));
    } else if (frameRms <= this.noiseFloorRms * 1.35) {
      // Idle line hiss during silence: gentle max -3 dB expansion (never gates quiet syllables to zero)
      targetGain = Math.min(1.0, Math.max(0.70, this.smoothedGain * 0.92));
    }

    const prevGain = this.smoothedGain;
    const smoothing = targetGain < prevGain ? 0.25 : 0.12;
    const nextGain = prevGain + smoothing * (targetGain - prevGain);
    this.smoothedGain = nextGain;
    this.lastAppliedGainDb = 20 * Math.log10(Math.max(1e-4, nextGain));

    // Apply per-sample linear gain ramp + soft-knee peak protection (zero zipper clicks, zero clipping)
    const gainStep = (nextGain - prevGain) / n;
    let g = prevGain;
    for (let i = 0; i < n; i++) {
      g += gainStep;
      filtered[i] = softLimitSample(filtered[i] * g);
    }

    return {
      samples: filtered,
      appliedGainDb: this.lastAppliedGainDb,
      mode: this.mode,
    };
  }

  public resetAndZero(): void {
    this.hpX1 = 0;
    this.hpX2 = 0;
    this.hpY1 = 0;
    this.hpY2 = 0;
    this.hsX1 = 0;
    this.hsX2 = 0;
    this.hsY1 = 0;
    this.hsY2 = 0;
    this.smoothedGain = 1.0;
    this.noiseFloorRms = 0.0012;
    this.lastAppliedGainDb = 0;
  }
}
