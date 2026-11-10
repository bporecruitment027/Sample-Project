import type {
  AudioLevelMetrics,
  CompatibilityCheckItem,
  CompatibilityDiagnosticSnapshot,
  DiagnosticProfileId,
} from '../types/index.ts';
import { DIAGNOSTIC_PROFILES } from '../config/models.ts';
import { rmsToDbfs } from './dsp.ts';
import { SystemAudioCaptureController } from './systemAudioCapture.ts';

/**
 * Ephemeral, zero-retention Audio Compatibility Diagnostics tracker for:
 * - Standard System Audio
 * - NICE CXone Test (diagnostic label only — zero API integration)
 * - Avaya Test (diagnostic label only — zero API integration)
 * - Combined Audio Test (NICE CXone + Avaya running simultaneously)
 *
 * Computes scalar DSP telemetry only; stores zero audio samples and clears on stop.
 */
export class CompatibilityDiagnosticsEngine {
  private profile: DiagnosticProfileId = 'nice-cxone';
  private running = false;
  private startedAtMs = 0;

  private hasAudioTrack = false;
  private trackStillLive = false;
  private trackLabel = '';
  private sampleRateHz: number | null = null;
  private trackDropoutsObserved = 0;

  private peakRmsObserved = 0;
  private activeSpeechFrames = 0;
  private clippingFrames = 0;
  private speechBandRatioSum = 0;

  private wasRecentlyActive = false;
  private silenceEnteredAtMs = 0;
  private holdPauseCounted = false;
  private holdTransitionsObserved = 0;

  public setProfile(profile: DiagnosticProfileId): void {
    this.profile = profile;
  }

  public getProfile(): DiagnosticProfileId {
    return this.profile;
  }

  public startSession(trackInfo: {
    hasAudioTrack: boolean;
    trackLabel: string;
    sampleRateHz: number | null;
    isLive: boolean;
  }): void {
    this.running = trackInfo.hasAudioTrack && trackInfo.isLive;
    this.startedAtMs = Date.now();
    this.hasAudioTrack = trackInfo.hasAudioTrack;
    this.trackStillLive = trackInfo.isLive;
    this.trackLabel = trackInfo.trackLabel;
    this.sampleRateHz = trackInfo.sampleRateHz;
    this.trackDropoutsObserved = 0;

    this.peakRmsObserved = 0;
    this.activeSpeechFrames = 0;
    this.clippingFrames = 0;
    this.speechBandRatioSum = 0;
    this.wasRecentlyActive = false;
    this.silenceEnteredAtMs = 0;
    this.holdPauseCounted = false;
    this.holdTransitionsObserved = 0;
  }

  public recordTrackDropout(): void {
    if (this.hasAudioTrack) {
      this.trackDropoutsObserved += 1;
    }
    this.trackStillLive = false;
    this.running = false;
  }

  public ingestMetrics(metrics: AudioLevelMetrics, trackIsLive: boolean): void {
    if (!this.running) {
      return;
    }

    this.trackStillLive = trackIsLive;
    if (!trackIsLive) {
      this.trackDropoutsObserved += 1;
      this.running = false;
      return;
    }

    if (metrics.rms > this.peakRmsObserved) {
      this.peakRmsObserved = metrics.rms;
    }

    const now = Date.now();
    const soundPresent = metrics.rms >= 0.008;

    if (soundPresent) {
      this.activeSpeechFrames += 1;
      this.speechBandRatioSum += metrics.speechBandRatio;
      if (metrics.clipping) {
        this.clippingFrames += 1;
      }

      if (!this.wasRecentlyActive && this.holdPauseCounted) {
        // Sound resumed cleanly after a hold/silence gap!
        this.holdPauseCounted = false;
      }
      this.wasRecentlyActive = true;
      this.silenceEnteredAtMs = 0;
    } else if (this.wasRecentlyActive) {
      if (this.silenceEnteredAtMs === 0) {
        this.silenceEnteredAtMs = now;
      } else if (!this.holdPauseCounted && now - this.silenceEnteredAtMs >= 1500) {
        this.holdTransitionsObserved += 1;
        this.holdPauseCounted = true;
      }
    }
  }

  public resetAndClear(): void {
    this.running = false;
    this.startedAtMs = 0;
    this.hasAudioTrack = false;
    this.trackStillLive = false;
    this.trackLabel = '';
    this.sampleRateHz = null;
    this.trackDropoutsObserved = 0;
    this.peakRmsObserved = 0;
    this.activeSpeechFrames = 0;
    this.clippingFrames = 0;
    this.speechBandRatioSum = 0;
    this.wasRecentlyActive = false;
    this.silenceEnteredAtMs = 0;
    this.holdPauseCounted = false;
    this.holdTransitionsObserved = 0;
  }

  public getSnapshot(): CompatibilityDiagnosticSnapshot {
    const support = SystemAudioCaptureController.checkBrowserSupport();
    const profileMeta = DIAGNOSTIC_PROFILES[this.profile];
    const elapsedSeconds =
      this.startedAtMs > 0 ? Math.floor((Date.now() - this.startedAtMs) / 1000) : 0;
    const avgSpeechBandRatio =
      this.activeSpeechFrames > 0 ? this.speechBandRatioSum / this.activeSpeechFrames : 0;
    const clippingRatio =
      this.activeSpeechFrames > 0 ? this.clippingFrames / this.activeSpeechFrames : 0;
    const peakDbfs = rmsToDbfs(this.peakRmsObserved);

    const checks: CompatibilityCheckItem[] = [
      {
        id: 'browser-api',
        label: '1. Chrome System Audio Sharing Support',
        state: support.supported ? 'pass' : 'fail',
        detail: support.supported
          ? 'HTTPS Secure Context, getDisplayMedia(), and AudioWorklet are supported.'
          : (support.alert?.message ?? 'Browser does not support system audio capture.'),
      },
      {
        id: 'audio-track',
        label: '2. Windows System Audio Track Returned',
        state:
          this.startedAtMs === 0
            ? 'pending'
            : this.hasAudioTrack
              ? 'pass'
              : 'fail',
        detail:
          this.startedAtMs === 0
            ? 'Click START TRANSCRIPTION (or Run Audio Diagnostics) and share Entire Screen + System Audio.'
            : this.hasAudioTrack
              ? `Audio track active (${this.trackLabel}${this.sampleRateHz ? ` @ ${this.sampleRateHz} Hz` : ''}).`
              : `No accessible audio track returned. ${profileMeta.routingGuidance}`,
      },
      {
        id: 'signal-activity',
        label: '3. Actual Sound Energy Detected on Track',
        state:
          !this.hasAudioTrack
            ? 'pending'
            : this.peakRmsObserved >= 0.008
              ? 'pass'
              : this.running
                ? 'running'
                : 'fail',
        detail:
          !this.hasAudioTrack
            ? 'Waiting for system audio track.'
            : this.peakRmsObserved >= 0.008
              ? `Sound verified (peak ${peakDbfs.toFixed(1)} dBFS). Audio is reaching Chrome.`
              : `Track is silent (${peakDbfs.toFixed(1)} dBFS). Play harmless test audio; if silent in Chrome while audible in headset, ${profileMeta.routingGuidance}`,
      },
      {
        id: 'speech-clarity',
        label: '4. Speech Clarity Suitability (300–3400 Hz Voice Band)',
        state:
          this.activeSpeechFrames < 6
            ? 'pending'
            : avgSpeechBandRatio >= 0.25 && clippingRatio < 0.1
              ? 'pass'
              : 'warn',
        detail:
          this.activeSpeechFrames < 6
            ? 'Play at least 1–2 seconds of spoken English test audio to evaluate clarity.'
            : avgSpeechBandRatio >= 0.25 && clippingRatio < 0.1
              ? `Clear speech-band energy (${Math.round(avgSpeechBandRatio * 100)}% voice band, ${(clippingRatio * 100).toFixed(1)}% clipping) — suitable for Whisper.`
              : clippingRatio >= 0.1
                ? `Audio clipping detected (${Math.round(clippingRatio * 100)}% frames clipped). Lower softphone/Windows volume slightly.`
                : `Low voice-band ratio (${Math.round(avgSpeechBandRatio * 100)}%). Signal may be non-speech noise or tones.`,
      },
      {
        id: 'track-stability',
        label: '5. Continuous Stream Stability',
        state:
          !this.hasAudioTrack
            ? 'pending'
            : this.trackDropoutsObserved > 0
              ? 'fail'
              : elapsedSeconds >= 5 && this.trackStillLive
                ? 'pass'
                : 'running',
        detail:
          !this.hasAudioTrack
            ? 'Waiting for active capture session.'
            : this.trackDropoutsObserved > 0
              ? `Audio track dropped (${this.trackDropoutsObserved} interruption). Check USB/Bluetooth headset stability.`
              : elapsedSeconds >= 5
                ? `Stream remained continuously live for ${elapsedSeconds}s with 0 track dropouts.`
                : `Monitoring track stability (${elapsedSeconds}s / 5s minimum)...`,
      },
      {
        id: 'hold-interruption',
        label: '6. Hold / Silence Transition Behavior',
        state:
          !this.hasAudioTrack
            ? 'pending'
            : this.trackDropoutsObserved > 0
              ? 'fail'
              : this.holdTransitionsObserved > 0 && this.trackStillLive
                ? 'pass'
                : 'pending',
        detail:
          !this.hasAudioTrack
            ? 'Waiting for active capture session.'
            : this.trackDropoutsObserved > 0
              ? 'Track disconnected during call hold or endpoint switch.'
              : this.holdTransitionsObserved > 0
                ? `Verified ${this.holdTransitionsObserved} active-to-silence (hold/mute) transition(s) while audio track stayed live.`
                : 'Optional check: pause test audio for 2 seconds to simulate call hold and confirm stream stays live.',
      },
    ];

    let summaryVerdict = 'Not yet tested in this session. Start capture with harmless sample audio to run live checks.';
    if (this.startedAtMs > 0) {
      if (!this.hasAudioTrack) {
        summaryVerdict = `FAIL (${profileMeta.label}): Windows/Chrome did not return a system audio track.`;
      } else if (this.trackDropoutsObserved > 0) {
        summaryVerdict = `WARN (${profileMeta.label}): System audio track disconnected unexpectedly.`;
      } else if (this.peakRmsObserved >= 0.008 && avgSpeechBandRatio >= 0.25 && elapsedSeconds >= 5) {
        summaryVerdict = `PASS (${profileMeta.label}): System audio track, live speech clarity, and stream stability verified on harmless audio.`;
      } else {
        summaryVerdict = `IN PROGRESS (${profileMeta.label}): Play 5+ seconds of harmless spoken test audio to complete verification.`;
      }
    }

    return {
      profile: this.profile,
      profileLabel: profileMeta.label,
      running: this.running,
      elapsedSeconds,
      peakRmsObserved: this.peakRmsObserved,
      peakDbfsObserved: peakDbfs,
      avgSpeechBandRatio,
      holdTransitionsObserved: this.holdTransitionsObserved,
      trackDropoutsObserved: this.trackDropoutsObserved,
      trackLabel: this.trackLabel,
      sampleRateHz: this.sampleRateHz,
      checks,
      summaryVerdict,
    };
  }
}
