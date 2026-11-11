import type { VadTuningConfig } from '../types/index.ts';
import { DEFAULT_VAD_CONFIG } from '../config/models.ts';
import {
  TARGET_SAMPLE_RATE,
  analyzeAudioFrame16k,
  createBiquadBandpassState,
  resetBiquadBandpassState,
  secureZeroFloat32,
} from './dsp.ts';

export interface SpeechSegmentPayload {
  samples: Float32Array;
  durationSec: number;
  hadBoundaryOverlap: boolean;
  overlapDurationSec: number;
  rms: number;
  peak: number;
  speechBandRatio: number;
  clippedRatio: number;
}

export interface VadSegmenterOptions {
  sampleRate?: number;
  speechOnsetRms?: number;
  speechHoldRms?: number;
  minSpeechSec?: number;
  silenceSplitSec?: number;
  maxSegmentSec?: number;
  preRollSec?: number;
  postRollKeepSec?: number;
  overlapSec?: number;
  onSpeechStateChange?: (isSpeaking: boolean) => void;
  onSegmentReady: (segment: SpeechSegmentPayload) => void;
}

/**
 * Ephemeral Voice Activity Detector & Bounded Speech Segmenter (v2).
 *
 * Defaults tuned for Australian automotive customer-service telephony:
 * - Segment length: 20.0 s (adjustable)
 * - Segment overlap: 3.0 s (adjustable)
 * - Silence threshold: 1.2 s (1.0–1.5 s range, adjustable; avoids cutting off regos & phone numbers)
 * - Pre-roll: 0.65 s (beginning-of-sentence preservation)
 * - Tail preservation: 0.45 s (end-of-sentence preservation while trimming excess silence)
 * - Zero audio persistence: overwrites all temporary Float32Array buffers with 0 immediately.
 */
export class EphemeralVadSegmenter {
  private readonly sampleRate: number;
  private readonly speechOnsetRms: number;
  private readonly speechHoldRms: number;
  private readonly minSpeechSamples: number;
  private silenceSplitSamples: number;
  private maxSegmentSamples: number;
  private readonly preRollMaxSamples: number;
  private readonly postRollKeepSamples: number;
  private overlapSamples: number;
  private readonly onSpeechStateChange?: (isSpeaking: boolean) => void;
  private readonly onSegmentReady: (segment: SpeechSegmentPayload) => void;

  private readonly filterState = createBiquadBandpassState();

  private preRollChunks: Float32Array[] = [];
  private preRollSamples = 0;

  private activeChunks: Float32Array[] = [];
  private activeTotalSamples = 0;
  private activeSpeechSamples = 0;
  private trailingSilenceSamples = 0;
  private isSpeaking = false;
  private currentSegmentHasOverlap = false;
  private currentSegmentOverlapSamples = 0;

  private adaptiveNoiseFloor = 0.0012;
  private segmentClippedSamples = 0;
  private segmentBandEnergyWeighted = 0;
  private segmentTotalEnergy = 0;

  constructor(options: VadSegmenterOptions) {
    this.sampleRate = options.sampleRate ?? TARGET_SAMPLE_RATE;
    this.speechOnsetRms = options.speechOnsetRms ?? 0.0048;
    this.speechHoldRms = options.speechHoldRms ?? 0.0032;
    this.minSpeechSamples = Math.round((options.minSpeechSec ?? 0.30) * this.sampleRate);
    this.silenceSplitSamples = Math.round(
      (options.silenceSplitSec ?? DEFAULT_VAD_CONFIG.silenceSplitSec) * this.sampleRate,
    );
    this.maxSegmentSamples = Math.round(
      (options.maxSegmentSec ?? DEFAULT_VAD_CONFIG.maxSegmentSec) * this.sampleRate,
    );
    this.preRollMaxSamples = Math.round((options.preRollSec ?? 0.65) * this.sampleRate);
    this.postRollKeepSamples = Math.round((options.postRollKeepSec ?? 0.45) * this.sampleRate);
    this.overlapSamples = Math.round(
      (options.overlapSec ?? DEFAULT_VAD_CONFIG.overlapSec) * this.sampleRate,
    );
    this.onSpeechStateChange = options.onSpeechStateChange;
    this.onSegmentReady = options.onSegmentReady;
  }

  public updateTuning(config: VadTuningConfig): void {
    this.maxSegmentSamples = Math.round(config.maxSegmentSec * this.sampleRate);
    this.overlapSamples = Math.round(config.overlapSec * this.sampleRate);
    this.silenceSplitSamples = Math.round(config.silenceSplitSec * this.sampleRate);
  }

  public getTuning(): VadTuningConfig {
    return {
      maxSegmentSec: this.maxSegmentSamples / this.sampleRate,
      overlapSec: this.overlapSamples / this.sampleRate,
      silenceSplitSec: this.silenceSplitSamples / this.sampleRate,
    };
  }

  public get speaking(): boolean {
    return this.isSpeaking;
  }

  public get bufferedSamplesCount(): number {
    return this.activeTotalSamples + this.preRollSamples;
  }

  public pushChunk16k(chunk: Float32Array): void {
    if (chunk.length === 0) {
      return;
    }

    const metrics = analyzeAudioFrame16k(chunk, this.filterState);

    // Update adaptive background noise floor conservatively during quiet periods
    if (!this.isSpeaking && metrics.rms < this.speechOnsetRms) {
      this.adaptiveNoiseFloor = 0.92 * this.adaptiveNoiseFloor + 0.08 * metrics.rms;
      this.adaptiveNoiseFloor = Math.max(0.0004, Math.min(0.009, this.adaptiveNoiseFloor));
    }

    const dynamicOnset = Math.max(this.speechOnsetRms, this.adaptiveNoiseFloor * 2.15);
    const dynamicHold = Math.max(this.speechHoldRms, this.adaptiveNoiseFloor * 1.55);
    const threshold = this.isSpeaking ? dynamicHold : dynamicOnset;

    const voiceLikely =
      metrics.rms >= threshold &&
      (metrics.speechBandRatio >= 0.11 || metrics.rms >= threshold * 2.1);

    if (!this.isSpeaking) {
      if (voiceLikely) {
        this.isSpeaking = true;
        this.onSpeechStateChange?.(true);

        // Beginning-of-sentence preservation: prepend pre-roll ring buffer
        for (const pre of this.preRollChunks) {
          this.activeChunks.push(pre);
          this.activeTotalSamples += pre.length;
        }
        this.preRollChunks = [];
        this.preRollSamples = 0;

        const copy = new Float32Array(chunk);
        this.activeChunks.push(copy);
        this.activeTotalSamples += copy.length;
        this.activeSpeechSamples += copy.length;
        this.trailingSilenceSamples = 0;
        this.segmentClippedSamples += metrics.clippedSampleCount;
        const e = metrics.rms * metrics.rms * copy.length;
        this.segmentTotalEnergy += e;
        this.segmentBandEnergyWeighted += e * metrics.speechBandRatio;
      } else {
        const copy = new Float32Array(chunk);
        this.preRollChunks.push(copy);
        this.preRollSamples += copy.length;
        while (this.preRollSamples > this.preRollMaxSamples && this.preRollChunks.length > 1) {
          const evicted = this.preRollChunks.shift();
          if (evicted) {
            this.preRollSamples -= evicted.length;
            secureZeroFloat32(evicted);
          }
        }
      }
      secureZeroFloat32(chunk);
      return;
    }

    // Active speech segment accumulation
    const copy = new Float32Array(chunk);
    secureZeroFloat32(chunk);

    this.activeChunks.push(copy);
    this.activeTotalSamples += copy.length;
    this.segmentClippedSamples += metrics.clippedSampleCount;
    const chunkEnergy = metrics.rms * metrics.rms * copy.length;
    this.segmentTotalEnergy += chunkEnergy;
    this.segmentBandEnergyWeighted += chunkEnergy * metrics.speechBandRatio;

    if (voiceLikely) {
      this.activeSpeechSamples += copy.length;
      this.trailingSilenceSamples = 0;
    } else {
      this.trailingSilenceSamples += copy.length;
    }

    // Case 1: Speaker finished thought (conversational silence >= 1.0–1.5s)
    if (this.trailingSilenceSamples >= this.silenceSplitSamples) {
      this.emitOrDiscardSegment(false);
      return;
    }

    // Case 2: Continuous monologue reached 20s segment limit -> split with 3s context overlap
    if (this.activeTotalSamples >= this.maxSegmentSamples) {
      this.emitOrDiscardSegment(true);
    }
  }

  public flushPending(): void {
    if (this.isSpeaking && this.activeTotalSamples > 0) {
      this.emitOrDiscardSegment(false);
    }
  }

  public clearAndZero(): void {
    for (const c of this.preRollChunks) {
      secureZeroFloat32(c);
    }
    for (const c of this.activeChunks) {
      secureZeroFloat32(c);
    }
    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.activeChunks = [];
    this.activeTotalSamples = 0;
    this.activeSpeechSamples = 0;
    this.trailingSilenceSamples = 0;
    this.currentSegmentHasOverlap = false;
    this.currentSegmentOverlapSamples = 0;
    this.segmentClippedSamples = 0;
    this.segmentBandEnergyWeighted = 0;
    this.segmentTotalEnergy = 0;
    this.adaptiveNoiseFloor = 0.0012;
    resetBiquadBandpassState(this.filterState);

    if (this.isSpeaking) {
      this.isSpeaking = false;
      this.onSpeechStateChange?.(false);
    }
  }

  private emitOrDiscardSegment(keepOverlapForNext: boolean): void {
    const mergedFull = new Float32Array(this.activeTotalSamples);
    let offset = 0;
    for (const c of this.activeChunks) {
      mergedFull.set(c, offset);
      offset += c.length;
      secureZeroFloat32(c);
    }
    this.activeChunks = [];
    this.activeTotalSamples = 0;

    const hadEnoughSpeech = this.activeSpeechSamples >= this.minSpeechSamples;
    const hadIncomingOverlap = this.currentSegmentHasOverlap;
    const incomingOverlapSec = hadIncomingOverlap
      ? this.currentSegmentOverlapSamples / this.sampleRate
      : 0;
    const trailingSilence = this.trailingSilenceSamples;
    const clippedRatio =
      mergedFull.length > 0 ? this.segmentClippedSamples / mergedFull.length : 0;
    const avgBandRatio =
      this.segmentTotalEnergy > 1e-10
        ? Math.min(1, Math.max(0, this.segmentBandEnergyWeighted / this.segmentTotalEnergy))
        : 0;

    this.activeSpeechSamples = 0;
    this.trailingSilenceSamples = 0;
    this.segmentClippedSamples = 0;
    this.segmentBandEnergyWeighted = 0;
    this.segmentTotalEnergy = 0;

    if (keepOverlapForNext && mergedFull.length > this.overlapSamples) {
      const overlapTail = mergedFull.slice(mergedFull.length - this.overlapSamples);
      this.activeChunks = [overlapTail];
      this.activeTotalSamples = overlapTail.length;
      // Only count new non-overlap speech toward the next segment's minSpeech threshold
      // unless actual voice continues after the split
      this.activeSpeechSamples = Math.floor(this.minSpeechSamples * 0.5);
      this.currentSegmentHasOverlap = true;
      this.currentSegmentOverlapSamples = overlapTail.length;
    } else {
      this.currentSegmentHasOverlap = false;
      this.currentSegmentOverlapSamples = 0;
      this.isSpeaking = false;
      this.onSpeechStateChange?.(false);
    }

    if (!hadEnoughSpeech) {
      secureZeroFloat32(mergedFull);
      return;
    }

    // End-of-sentence preservation: keep 0.45s natural tail while trimming excess trailing dead air
    let finalSamples = mergedFull;
    if (!keepOverlapForNext && trailingSilence > this.postRollKeepSamples) {
      const excessSilence = trailingSilence - this.postRollKeepSamples;
      const trimmedLen = Math.max(this.minSpeechSamples, mergedFull.length - excessSilence);
      if (trimmedLen < mergedFull.length) {
        finalSamples = mergedFull.slice(0, trimmedLen);
        secureZeroFloat32(mergedFull);
      }
    }

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < finalSamples.length; i++) {
      const s = finalSamples[i];
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
      sumSq += s * s;
    }
    const rms = finalSamples.length > 0 ? Math.sqrt(sumSq / finalSamples.length) : 0;

    if (rms < this.speechHoldRms * 0.65) {
      secureZeroFloat32(finalSamples);
      return;
    }

    this.onSegmentReady({
      samples: finalSamples,
      durationSec: finalSamples.length / this.sampleRate,
      hadBoundaryOverlap: hadIncomingOverlap,
      overlapDurationSec: incomingOverlapSec,
      rms,
      peak,
      speechBandRatio: avgBandRatio,
      clippedRatio,
    });
  }
}
