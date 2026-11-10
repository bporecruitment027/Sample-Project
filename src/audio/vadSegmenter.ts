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
  rms: number;
}

export interface VadSegmenterOptions {
  sampleRate?: number;
  speechOnsetRms?: number;
  speechHoldRms?: number;
  minSpeechSec?: number;
  silenceSplitSec?: number;
  maxSegmentSec?: number;
  preRollSec?: number;
  overlapSec?: number;
  onSpeechStateChange?: (isSpeaking: boolean) => void;
  onSegmentReady: (segment: SpeechSegmentPayload) => void;
}

/**
 * Ephemeral Voice Activity Detector & Bounded Speech Segmenter.
 *
 * Holds only short-lived Float32Array chunks for the current utterance (max 8 seconds, ~512 KB),
 * transfers/emits completed segments for local Whisper inference, and overwrites discarded
 * temporary buffers with zeros immediately.
 */
export class EphemeralVadSegmenter {
  private readonly sampleRate: number;
  private readonly speechOnsetRms: number;
  private readonly speechHoldRms: number;
  private readonly minSpeechSamples: number;
  private readonly silenceSplitSamples: number;
  private readonly maxSegmentSamples: number;
  private readonly preRollMaxSamples: number;
  private readonly overlapSamples: number;
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

  constructor(options: VadSegmenterOptions) {
    this.sampleRate = options.sampleRate ?? TARGET_SAMPLE_RATE;
    this.speechOnsetRms = options.speechOnsetRms ?? 0.007;
    this.speechHoldRms = options.speechHoldRms ?? 0.0045;
    this.minSpeechSamples = Math.round((options.minSpeechSec ?? 0.55) * this.sampleRate);
    this.silenceSplitSamples = Math.round((options.silenceSplitSec ?? 0.65) * this.sampleRate);
    this.maxSegmentSamples = Math.round((options.maxSegmentSec ?? 12.0) * this.sampleRate);
    this.preRollMaxSamples = Math.round((options.preRollSec ?? 0.45) * this.sampleRate);
    this.overlapSamples = Math.round((options.overlapSec ?? 0.8) * this.sampleRate);
    this.onSpeechStateChange = options.onSpeechStateChange;
    this.onSegmentReady = options.onSegmentReady;
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
    const threshold = this.isSpeaking ? this.speechHoldRms : this.speechOnsetRms;
    const voiceLikely =
      metrics.rms >= threshold &&
      (metrics.speechBandRatio >= 0.14 || metrics.rms >= threshold * 2.4);

    if (!this.isSpeaking) {
      if (voiceLikely) {
        this.isSpeaking = true;
        this.onSpeechStateChange?.(true);

        // Prepend pre-roll ring buffer so initial word onset is preserved
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
      } else {
        // Maintain bounded pre-roll ring buffer and securely zero evicted chunks
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

    // Currently in an active speech segment
    const copy = new Float32Array(chunk);
    secureZeroFloat32(chunk);

    this.activeChunks.push(copy);
    this.activeTotalSamples += copy.length;

    if (voiceLikely) {
      this.activeSpeechSamples += copy.length;
      this.trailingSilenceSamples = 0;
    } else {
      this.trailingSilenceSamples += copy.length;
    }

    // Case 1: Natural conversational pause reached
    if (this.trailingSilenceSamples >= this.silenceSplitSamples) {
      this.emitOrDiscardSegment(false);
      return;
    }

    // Case 2: Continuous speech reached maxSegmentSamples -> split with short boundary overlap
    if (this.activeTotalSamples >= this.maxSegmentSamples) {
      this.emitOrDiscardSegment(true);
    }
  }

  /**
   * Flushes any valid buffered speech (e.g. at end of test clip) without retaining tail buffers.
   */
  public flushPending(): void {
    if (this.isSpeaking && this.activeTotalSamples > 0) {
      this.emitOrDiscardSegment(false);
    }
  }

  /**
   * Immediately zeroes and discards all active, pre-roll, and filter state buffers.
   * Invoked on PAUSE, STOP, error abort, and page unload.
   */
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
    resetBiquadBandpassState(this.filterState);

    if (this.isSpeaking) {
      this.isSpeaking = false;
      this.onSpeechStateChange?.(false);
    }
  }

  private emitOrDiscardSegment(keepOverlapForNext: boolean): void {
    const merged = new Float32Array(this.activeTotalSamples);
    let offset = 0;
    for (const c of this.activeChunks) {
      merged.set(c, offset);
      offset += c.length;
      secureZeroFloat32(c);
    }
    this.activeChunks = [];
    this.activeTotalSamples = 0;

    const hadEnoughSpeech = this.activeSpeechSamples >= this.minSpeechSamples;
    const hadIncomingOverlap = this.currentSegmentHasOverlap;

    this.activeSpeechSamples = 0;
    this.trailingSilenceSamples = 0;

    if (keepOverlapForNext && merged.length > this.overlapSamples) {
      const overlapTail = merged.slice(merged.length - this.overlapSamples);
      this.activeChunks = [overlapTail];
      this.activeTotalSamples = overlapTail.length;
      this.activeSpeechSamples = Math.floor(overlapTail.length * 0.5);
      this.currentSegmentHasOverlap = true;
      // Remain in speaking state across forced mid-utterance split
    } else {
      this.currentSegmentHasOverlap = false;
      this.isSpeaking = false;
      this.onSpeechStateChange?.(false);
    }

    if (!hadEnoughSpeech) {
      secureZeroFloat32(merged);
      return;
    }

    let sumSq = 0;
    for (let i = 0; i < merged.length; i++) {
      sumSq += merged[i] * merged[i];
    }
    const rms = Math.sqrt(sumSq / merged.length);

    if (rms < this.speechHoldRms * 0.75) {
      secureZeroFloat32(merged);
      return;
    }

    this.onSegmentReady({
      samples: merged,
      durationSec: merged.length / this.sampleRate,
      hadBoundaryOverlap: hadIncomingOverlap,
      rms,
    });
  }
}
