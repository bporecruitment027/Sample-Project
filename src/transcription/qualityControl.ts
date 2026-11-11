import type {
  DiagnosticHealthColor,
  QualityControlSnapshot,
  TranscriptConfidenceTier,
} from '../types/index.ts';
import { rmsToDbfs } from '../audio/dsp.ts';

export interface SegmentQualityEvaluationInput {
  text: string;
  durationSec: number;
  rms: number;
  peak: number;
  speechBandRatio: number;
  clippedRatio: number;
  processingMs: number;
  wasHallucinationBlocked: boolean;
  wasRepetitionSuppressed: boolean;
}

export interface SegmentQualityEvaluationResult {
  shouldEmit: boolean;
  confidenceTier: TranscriptConfidenceTier;
  qualityNote?: string;
}

/**
 * Ephemeral Transcription Quality Control & Uncertainty Classifier (Sections 10 & 11).
 *
 * Identifies quiet audio, clipping, extended silence, long recognition delays,
 * recognition failures, repeated phrases, silence hallucinations, and dropped segments.
 * Never guesses, invents, or silently alters vehicle regos, names, or spoken content.
 */
export class TranscriptionQualityController {
  private veryQuietSegments = 0;
  private clippedSegments = 0;
  private highDelayEvents = 0;
  private lastProcessingMs = 0;
  private recognitionFailures = 0;
  private suppressedRepetitions = 0;
  private blockedHallucinations = 0;
  private droppedOrMissingSegments = 0;
  private uncertainSegmentsCount = 0;

  private lastSoundTimestampMs = 0;
  private sessionActive = false;

  public startSession(): void {
    this.resetAndClear();
    this.sessionActive = true;
    this.lastSoundTimestampMs = Date.now();
  }

  public notifyLiveAudioFrame(rms: number): void {
    if (!this.sessionActive) {
      return;
    }
    if (rms >= 0.0035) {
      this.lastSoundTimestampMs = Date.now();
    }
  }

  public recordRecognitionFailure(): void {
    this.recognitionFailures += 1;
  }

  public recordDroppedSegment(): void {
    this.droppedOrMissingSegments += 1;
  }

  public evaluateTranscribedSegment(
    input: SegmentQualityEvaluationInput,
  ): SegmentQualityEvaluationResult {
    this.lastProcessingMs = input.processingMs;

    const highDelayThresholdMs = Math.max(7500, input.durationSec * 1100);
    if (input.processingMs > highDelayThresholdMs) {
      this.highDelayEvents += 1;
    }

    if (input.wasHallucinationBlocked) {
      this.blockedHallucinations += 1;
      return { shouldEmit: false, confidenceTier: 'uncertain' };
    }

    if (input.wasRepetitionSuppressed) {
      this.suppressedRepetitions += 1;
      return { shouldEmit: false, confidenceTier: 'uncertain' };
    }

    const trimmed = input.text.trim();
    if (!trimmed) {
      return { shouldEmit: false, confidenceTier: 'confirmed' };
    }

    const segmentDbfs = rmsToDbfs(input.rms);
    const wordCount = trimmed.split(/\s+/).length;
    const wordsPerSec = input.durationSec > 0 ? wordCount / input.durationSec : wordCount;

    // Guard against silence/hum hallucinations: if signal has almost zero voice-band energy
    // or impossible token density (>6.2 words/sec) on near-silent audio, suppress fabrication.
    if (
      (segmentDbfs < -40 && input.speechBandRatio < 0.10) ||
      (segmentDbfs < -33 && wordsPerSec > 6.2 && wordCount >= 6)
    ) {
      this.blockedHallucinations += 1;
      return { shouldEmit: false, confidenceTier: 'uncertain' };
    }

    const notes: string[] = [];
    let tier: TranscriptConfidenceTier = 'confirmed';

    if (input.clippedRatio >= 0.015 || input.peak >= 0.992) {
      this.clippedSegments += 1;
      tier = 'uncertain';
      notes.push('Audio clipping detected — verify unclear words');
    }

    if (segmentDbfs < -33.0) {
      this.veryQuietSegments += 1;
      tier = 'uncertain';
      notes.push(`Quiet call signal (${segmentDbfs.toFixed(0)} dBFS) — verify names/rego/numbers`);
    } else if (input.speechBandRatio < 0.17) {
      tier = 'uncertain';
      notes.push('Low voice-band clarity — verify names/rego/numbers');
    }

    if (tier === 'uncertain') {
      this.uncertainSegmentsCount += 1;
    }

    return {
      shouldEmit: true,
      confidenceTier: tier,
      qualityNote: notes.length > 0 ? notes.join(' · ') : undefined,
    };
  }

  public getSnapshot(nowMs: number = Date.now()): QualityControlSnapshot {
    const silenceDurationSec =
      this.sessionActive && this.lastSoundTimestampMs > 0
        ? Math.max(0, Math.floor((nowMs - this.lastSoundTimestampMs) / 1000))
        : 0;
    const extendedSilenceActive = this.sessionActive && silenceDurationSec >= 15;

    let overallHealth: DiagnosticHealthColor = 'GREEN';
    let statusSummary = 'Healthy recognition quality — clear English speech & normal queue latency.';

    if (this.recognitionFailures > 0 || this.droppedOrMissingSegments >= 2) {
      overallHealth = 'RED';
      statusSummary =
        this.droppedOrMissingSegments >= 2
          ? `${this.droppedOrMissingSegments} speech segments dropped due to CPU overload — switch model to Whisper Base.en.`
          : `${this.recognitionFailures} local recognition failure(s) encountered.`;
    } else if (
      this.clippedSegments > 0 ||
      this.veryQuietSegments > 0 ||
      this.highDelayEvents >= 2 ||
      this.droppedOrMissingSegments === 1 ||
      extendedSilenceActive
    ) {
      overallHealth = 'YELLOW';
      if (this.clippedSegments > 0) {
        statusSummary =
          'Signal clipping observed — reduce softphone/headset output volume slightly for cleaner speech.';
      } else if (this.veryQuietSegments > 0) {
        statusSummary =
          'Quiet call audio observed — enable Quiet Call Boost enhancement and double-check uncertain segments.';
      } else if (this.highDelayEvents >= 2 || this.droppedOrMissingSegments === 1) {
        statusSummary =
          'Elevated local CPU inference delay — switch to Whisper Base.en if queue lag increases.';
      } else {
        statusSummary = `No audio detected for ${silenceDurationSec}s (call on hold, muted, or waiting for caller).`;
      }
    } else if (!this.sessionActive) {
      overallHealth = 'GREEN';
      statusSummary = 'Standby — quality monitor activates automatically during transcription.';
    }

    return {
      overallHealth,
      statusSummary,
      veryQuietSegments: this.veryQuietSegments,
      clippedSegments: this.clippedSegments,
      extendedSilenceActive,
      silenceDurationSec,
      highDelayEvents: this.highDelayEvents,
      lastProcessingMs: this.lastProcessingMs,
      recognitionFailures: this.recognitionFailures,
      suppressedRepetitions: this.suppressedRepetitions,
      blockedHallucinations: this.blockedHallucinations,
      droppedOrMissingSegments: this.droppedOrMissingSegments,
      uncertainSegmentsCount: this.uncertainSegmentsCount,
    };
  }

  public resetAndClear(): void {
    this.sessionActive = false;
    this.lastSoundTimestampMs = 0;
    this.veryQuietSegments = 0;
    this.clippedSegments = 0;
    this.highDelayEvents = 0;
    this.lastProcessingMs = 0;
    this.recognitionFailures = 0;
    this.suppressedRepetitions = 0;
    this.blockedHallucinations = 0;
    this.droppedOrMissingSegments = 0;
    this.uncertainSegmentsCount = 0;
  }
}
