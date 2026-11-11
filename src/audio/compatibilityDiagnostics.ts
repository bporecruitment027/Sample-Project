import type {
  AudioEnhancementMode,
  AudioLevelMetrics,
  CaptureSourceMode,
  ChannelTopology,
  CompatibilityCheckItem,
  CompatibilityDiagnosticSnapshot,
  DiagnosticHealthColor,
  DiagnosticProfileId,
  RealtimeAudioDiagnosticsView,
} from '../types/index.ts';
import { CAPTURE_SOURCE_MODES, DIAGNOSTIC_PROFILES } from '../config/models.ts';
import { TARGET_SAMPLE_RATE, rmsToDbfs } from './dsp.ts';
import { SystemAudioCaptureController } from './systemAudioCapture.ts';

function formatTopologyShort(topology: ChannelTopology | undefined): string {
  switch (topology) {
    case 'left-dominant':
      return 'Left-Dominant (+6 dB preserved)';
    case 'right-dominant':
      return 'Right-Dominant (+6 dB preserved)';
    case 'identical-stereo':
      return 'Coherent Stereo (L=R)';
    case 'dual-independent':
      return 'Dual Independent (Eq-Power)';
    case 'phase-inverted':
      return 'Phase-Offset (Anti-Cancel)';
    case 'mono-input':
      return 'Mono Track';
    default:
      return 'Idle / Silent';
  }
}

/**
 * Ephemeral, zero-retention Real-Time Audio Diagnostics & Softphone Compatibility Engine (Section 4).
 *
 * Computes live scalar DSP telemetry only (in dBFS); stores zero audio samples and zero diagnostic history.
 */
export class CompatibilityDiagnosticsEngine {
  private profile: DiagnosticProfileId = 'standard';
  private running = false;
  private startedAtMs = 0;

  private captureMode: CaptureSourceMode = 'entire-screen-system';
  private displaySurface = '';
  private hasAudioTrack = false;
  private trackStillLive = false;
  private trackReadyState = 'none';
  private trackMuted = false;
  private trackLabel = '';
  private sampleRateHz: number | null = null;
  private channelCount = 2;
  private trackDropoutsObserved = 0;

  // Instantaneous / rolling scalar metrics (zero history array!)
  private currentPeakDbfs = -100;
  private currentLeftDbfs = -100;
  private currentRightDbfs = -100;
  private avgRmsEma = 0;
  private currentTopology: ChannelTopology = 'silent';
  private currentSpeechBandRatio = 0;
  private currentIsClipping = false;
  private currentIsSpeechActive = false;
  private currentEnhancementMode: AudioEnhancementMode = 'gentle';
  private currentEnhancementGainDb = 0;

  private queueInFlight = false;
  private queueWaitingCount = 0;
  private lastInferenceMs = 0;

  private peakRmsObserved = 0;
  private activeSpeechFrames = 0;
  private totalFrames = 0;
  private clippingFrames = 0;
  private speechBandRatioSum = 0;

  private wasRecentlyActive = false;
  private lastSoundAtMs = 0;
  private silenceEnteredAtMs = 0;
  private holdPauseCounted = false;
  private holdTransitionsObserved = 0;

  // Separate ephemeral indicator states for NICE CXone and Avaya test sessions (cleared on stop)
  private cxoneTestStatus: { color: DiagnosticHealthColor | 'IDLE'; text: string } = {
    color: 'IDLE',
    text: 'Not tested in this session',
  };
  private avayaTestStatus: { color: DiagnosticHealthColor | 'IDLE'; text: string } = {
    color: 'IDLE',
    text: 'Not tested in this session',
  };

  public setProfile(profile: DiagnosticProfileId): void {
    this.profile = profile;
  }

  public getProfile(): DiagnosticProfileId {
    return this.profile;
  }

  public updateQueueTelemetry(
    inFlight: boolean,
    waitingCount: number,
    lastProcessingMs: number,
  ): void {
    this.queueInFlight = inFlight;
    this.queueWaitingCount = waitingCount;
    this.lastInferenceMs = lastProcessingMs;
  }

  public startSession(trackInfo: {
    hasAudioTrack: boolean;
    trackLabel: string;
    sampleRateHz: number | null;
    isLive: boolean;
    captureMode?: CaptureSourceMode;
    displaySurface?: string;
    channelCount?: number;
    trackReadyState?: string;
    trackMuted?: boolean;
  }): void {
    this.running = trackInfo.hasAudioTrack && trackInfo.isLive;
    this.startedAtMs = Date.now();
    this.lastSoundAtMs = this.startedAtMs;
    this.hasAudioTrack = trackInfo.hasAudioTrack;
    this.trackStillLive = trackInfo.isLive;
    this.trackLabel = trackInfo.trackLabel;
    this.sampleRateHz = trackInfo.sampleRateHz;
    this.captureMode = trackInfo.captureMode ?? 'entire-screen-system';
    this.displaySurface = trackInfo.displaySurface ?? '';
    this.channelCount = trackInfo.channelCount ?? 2;
    this.trackReadyState =
      trackInfo.trackReadyState ?? (trackInfo.hasAudioTrack ? (trackInfo.isLive ? 'live' : 'ended') : 'none');
    this.trackMuted = Boolean(trackInfo.trackMuted);
    this.trackDropoutsObserved = 0;

    this.currentPeakDbfs = -100;
    this.currentLeftDbfs = -100;
    this.currentRightDbfs = -100;
    this.avgRmsEma = 0;
    this.currentTopology = 'silent';
    this.currentSpeechBandRatio = 0;
    this.currentIsClipping = false;
    this.currentIsSpeechActive = false;

    this.peakRmsObserved = 0;
    this.activeSpeechFrames = 0;
    this.totalFrames = 0;
    this.clippingFrames = 0;
    this.speechBandRatioSum = 0;
    this.wasRecentlyActive = false;
    this.silenceEnteredAtMs = 0;
    this.holdPauseCounted = false;
    this.holdTransitionsObserved = 0;

    if (!trackInfo.hasAudioTrack) {
      this.updatePhoneSystemBadges('RED', 'Capture failed — no audio track');
    } else {
      this.updatePhoneSystemBadges('YELLOW', 'Connected — waiting for speech');
    }
  }

  public recordTrackDropout(): void {
    if (this.hasAudioTrack) {
      this.trackDropoutsObserved += 1;
    }
    this.trackStillLive = false;
    this.trackReadyState = 'ended';
    this.running = false;
    this.updatePhoneSystemBadges('RED', 'Audio track disconnected');
  }

  public ingestMetrics(
    metrics: AudioLevelMetrics,
    trackIsLive: boolean,
    extraTrackState?: { readyState?: string; muted?: boolean; displaySurface?: string },
  ): void {
    if (!this.running) {
      return;
    }

    this.trackStillLive = trackIsLive;
    if (extraTrackState?.readyState) {
      this.trackReadyState = extraTrackState.readyState;
    }
    if (typeof extraTrackState?.muted === 'boolean') {
      this.trackMuted = extraTrackState.muted;
    }
    if (extraTrackState?.displaySurface) {
      this.displaySurface = extraTrackState.displaySurface;
    }

    if (!trackIsLive) {
      this.trackDropoutsObserved += 1;
      this.trackReadyState = 'ended';
      this.running = false;
      this.updatePhoneSystemBadges('RED', 'Track ended unexpectedly');
      return;
    }

    this.totalFrames += 1;
    this.currentPeakDbfs = metrics.peakDbfs ?? rmsToDbfs(metrics.peak);
    this.currentLeftDbfs = metrics.leftDbfs ?? metrics.dbfs;
    this.currentRightDbfs = metrics.rightDbfs ?? metrics.dbfs;
    this.avgRmsEma =
      this.avgRmsEma === 0 ? metrics.rms : 0.85 * this.avgRmsEma + 0.15 * metrics.rms;

    if (typeof metrics.channelCount === 'number' && metrics.channelCount > 0) {
      this.channelCount = metrics.channelCount;
    }
    if (metrics.channelTopology) {
      this.currentTopology = metrics.channelTopology;
    }
    if (typeof metrics.sourceSampleRate === 'number' && metrics.sourceSampleRate > 0) {
      this.sampleRateHz = metrics.sourceSampleRate;
    }
    if (metrics.enhancementMode) {
      this.currentEnhancementMode = metrics.enhancementMode;
    }
    if (typeof metrics.enhancementGainDb === 'number') {
      this.currentEnhancementGainDb = metrics.enhancementGainDb;
    }

    this.currentSpeechBandRatio = metrics.speechBandRatio;
    this.currentIsClipping = metrics.clipping;
    this.currentIsSpeechActive = metrics.isSpeechActive;

    if (metrics.rms > this.peakRmsObserved) {
      this.peakRmsObserved = metrics.rms;
    }

    const now = Date.now();
    const soundPresent = metrics.rms >= 0.005;

    if (soundPresent) {
      this.lastSoundAtMs = now;
      this.activeSpeechFrames += 1;
      this.speechBandRatioSum += metrics.speechBandRatio;
      if (metrics.clipping) {
        this.clippingFrames += 1;
      }

      if (!this.wasRecentlyActive && this.holdPauseCounted) {
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

    const health = this.computeRealtimeHealth();
    this.updatePhoneSystemBadges(health.color, health.shortBadgeText);
  }

  public resetAndClear(): void {
    this.running = false;
    this.startedAtMs = 0;
    this.hasAudioTrack = false;
    this.trackStillLive = false;
    this.trackReadyState = 'none';
    this.trackMuted = false;
    this.trackLabel = '';
    this.displaySurface = '';
    this.sampleRateHz = null;
    this.channelCount = 2;
    this.trackDropoutsObserved = 0;

    this.currentPeakDbfs = -100;
    this.currentLeftDbfs = -100;
    this.currentRightDbfs = -100;
    this.avgRmsEma = 0;
    this.currentTopology = 'silent';
    this.currentSpeechBandRatio = 0;
    this.currentIsClipping = false;
    this.currentIsSpeechActive = false;
    this.currentEnhancementGainDb = 0;
    this.queueInFlight = false;
    this.queueWaitingCount = 0;
    this.lastInferenceMs = 0;

    this.peakRmsObserved = 0;
    this.activeSpeechFrames = 0;
    this.totalFrames = 0;
    this.clippingFrames = 0;
    this.speechBandRatioSum = 0;
    this.wasRecentlyActive = false;
    this.lastSoundAtMs = 0;
    this.silenceEnteredAtMs = 0;
    this.holdPauseCounted = false;
    this.holdTransitionsObserved = 0;

    this.cxoneTestStatus = { color: 'IDLE', text: 'Not tested in this session' };
    this.avayaTestStatus = { color: 'IDLE', text: 'Not tested in this session' };
  }

  private updatePhoneSystemBadges(color: DiagnosticHealthColor, detail: string): void {
    if (this.profile === 'nice-cxone' || this.profile === 'combined') {
      this.cxoneTestStatus = { color, text: detail };
    }
    if (this.profile === 'avaya' || this.profile === 'combined') {
      this.avayaTestStatus = { color, text: detail };
    }
  }

  private computeRealtimeHealth(): {
    color: DiagnosticHealthColor;
    summary: string;
    shortBadgeText: string;
  } {
    if (this.startedAtMs === 0) {
      return {
        color: 'YELLOW',
        summary: 'Standby — start transcription or Test Audio Only to inspect live signal.',
        shortBadgeText: 'Standby',
      };
    }

    if (!this.hasAudioTrack || !this.trackStillLive || this.trackMuted || this.trackDropoutsObserved > 0) {
      return {
        color: 'RED',
        summary: !this.hasAudioTrack
          ? 'RED: No usable audio track returned by Chrome/Windows.'
          : this.trackMuted
            ? 'RED: Audio track is muted at OS/softphone level.'
            : 'RED: Audio capture track disconnected unexpectedly.',
        shortBadgeText: 'No usable audio / disconnected',
      };
    }

    const clipRatio =
      this.activeSpeechFrames > 0 ? this.clippingFrames / this.activeSpeechFrames : 0;
    if (clipRatio >= 0.08 || (this.currentIsClipping && this.currentPeakDbfs >= -0.15)) {
      return {
        color: 'RED',
        summary: 'RED: Severe audio clipping detected — lower headset/softphone volume slightly.',
        shortBadgeText: 'Severe clipping detected',
      };
    }

    const elapsedSec = Math.floor((Date.now() - this.startedAtMs) / 1000);
    if (this.peakRmsObserved < 0.002 && elapsedSec >= 6) {
      return {
        color: 'RED',
        summary:
          'RED: Connected track is completely silent (-100 dBFS) — check Avaya background-mute & Windows output endpoint.',
        shortBadgeText: 'Silent track (-100 dBFS)',
      };
    }

    const avgDbfs = rmsToDbfs(this.avgRmsEma);
    if (this.peakRmsObserved < 0.008) {
      return {
        color: 'YELLOW',
        summary: 'YELLOW: Waiting for spoken audio or signal is very faint.',
        shortBadgeText: 'Waiting for speech / weak',
      };
    }

    if (avgDbfs < -33 && this.currentIsSpeechActive) {
      return {
        color: 'YELLOW',
        summary: `YELLOW: Speech is weak (${avgDbfs.toFixed(1)} dBFS avg) — Quiet Call Boost recommended.`,
        shortBadgeText: `Weak input (${avgDbfs.toFixed(0)} dBFS)`,
      };
    }

    const silenceSecs =
      this.lastSoundAtMs > 0 ? Math.floor((Date.now() - this.lastSoundAtMs) / 1000) : 0;
    if (silenceSecs >= 10) {
      return {
        color: 'YELLOW',
        summary: `YELLOW: Silence for ${silenceSecs}s (call on hold, pause, or waiting for speaker).`,
        shortBadgeText: `Healthy (currently silent ${silenceSecs}s)`,
      };
    }

    return {
      color: 'GREEN',
      summary: `GREEN: Healthy ${this.sampleRateHz ?? 48000} Hz → 16 kHz speech signal (${rmsToDbfs(this.peakRmsObserved).toFixed(1)} dBFS peak).`,
      shortBadgeText: `Healthy (${rmsToDbfs(this.peakRmsObserved).toFixed(1)} dBFS peak)`,
    };
  }

  private buildRealtimeTelemetryView(): RealtimeAudioDiagnosticsView {
    const health = this.computeRealtimeHealth();
    const avgDbfs = rmsToDbfs(this.avgRmsEma);
    const silenceSecs =
      this.startedAtMs > 0 && this.lastSoundAtMs > 0
        ? Math.max(0, Math.floor((Date.now() - this.lastSoundAtMs) / 1000))
        : 0;
    const clipRatio =
      this.activeSpeechFrames > 0 ? (this.clippingFrames / this.activeSpeechFrames) * 100 : 0;

    const surfaceInfo = this.displaySurface ? ` [${this.displaySurface}]` : '';
    const captureSourceLabel =
      this.startedAtMs === 0
        ? 'Not connected'
        : `${CAPTURE_SOURCE_MODES[this.captureMode].label.split(' (')[0]}${surfaceInfo}`;

    const enhLabel =
      this.currentEnhancementMode === 'off'
        ? 'Raw Bypass (0.0 dB)'
        : `${this.currentEnhancementMode === 'quiet-boost' ? 'Quiet Boost' : 'Gentle Clarity'} (${this.currentEnhancementGainDb >= 0 ? '+' : ''}${this.currentEnhancementGainDb.toFixed(1)} dB)`;

    const queueLabel =
      !this.queueInFlight && this.queueWaitingCount === 0
        ? this.lastInferenceMs > 0
          ? `Idle (last ${this.lastInferenceMs} ms)`
          : 'Idle (0 queued)'
        : `${this.queueInFlight ? '1 active' : '0 active'} · ${this.queueWaitingCount} queued${this.lastInferenceMs > 0 ? ` (${this.lastInferenceMs} ms)` : ''}`;

    return {
      healthColor: health.color,
      healthSummary: health.summary,
      captureSourceLabel,
      audioTrackAvailable: this.hasAudioTrack
        ? `Yes (${this.trackLabel || 'System Audio'})`
        : 'No usable track',
      trackStateLabel:
        this.startedAtMs === 0
          ? 'idle'
          : `${this.trackReadyState}${this.trackMuted ? ' (MUTED)' : ' (unmuted)'}`,
      sampleRateConversionLabel: this.sampleRateHz
        ? `${this.sampleRateHz.toLocaleString()} Hz → ${TARGET_SAMPLE_RATE.toLocaleString()} Hz (Blackman-Sinc)`
        : 'Standby (target 16,000 Hz Float32)',
      channelHandlingLabel:
        this.startedAtMs === 0
          ? 'Standby (L/R independent inspection)'
          : `${this.channelCount} ch · ${formatTopologyShort(this.currentTopology)}`,
      leftLevelDbfs: `${this.currentLeftDbfs.toFixed(1)} dBFS`,
      rightLevelDbfs: `${this.currentRightDbfs.toFixed(1)} dBFS`,
      avgRmsDbfs: `${avgDbfs.toFixed(1)} dBFS`,
      peakLevelDbfs: `${this.currentPeakDbfs.toFixed(1)} dBFS`,
      silenceDetectionLabel:
        this.startedAtMs === 0
          ? 'Idle'
          : this.currentIsSpeechActive
            ? 'Active Speech'
            : `Silence (${silenceSecs}s)`,
      clippingDetectionLabel:
        this.currentIsClipping || clipRatio >= 2
          ? `Clipping (${clipRatio.toFixed(1)}% frames)`
          : `Clean (${clipRatio.toFixed(1)}% clipped)`,
      audioActivityLabel: this.currentIsSpeechActive
        ? `Speech Active (${Math.round(this.currentSpeechBandRatio * 100)}% voice band)`
        : `Inactive (${Math.round(this.currentSpeechBandRatio * 100)}% voice band)`,
      audioProcessingLabel: enhLabel,
      recognitionQueueLabel: queueLabel,
      niceCxoneIndicator: this.cxoneTestStatus,
      avayaIndicator: this.avayaTestStatus,
    };
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
            ? 'Click START TRANSCRIPTION (or Test Audio Only) and share Entire Screen + System Audio.'
            : this.hasAudioTrack
              ? `Audio track active (${this.trackLabel}${this.sampleRateHz ? ` @ ${this.sampleRateHz} Hz, ${this.channelCount} ch` : ''}).`
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
              ? `Sound verified (peak ${peakDbfs.toFixed(1)} dBFS, ${formatTopologyShort(this.currentTopology)}).`
              : `Track is silent (${peakDbfs.toFixed(1)} dBFS). Play harmless test audio; if silent in Chrome while audible in headset, ${profileMeta.routingGuidance}`,
      },
      {
        id: 'speech-clarity',
        label: '4. Speech Clarity Suitability (300–3400 Hz Voice Band)',
        state:
          this.activeSpeechFrames < 6
            ? 'pending'
            : avgSpeechBandRatio >= 0.22 && clippingRatio < 0.1
              ? 'pass'
              : 'warn',
        detail:
          this.activeSpeechFrames < 6
            ? 'Play at least 1–2 seconds of spoken English test audio to evaluate clarity.'
            : avgSpeechBandRatio >= 0.22 && clippingRatio < 0.1
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

    let summaryVerdict =
      'Not yet tested in this session. Start capture with harmless sample audio to run live checks.';
    if (this.startedAtMs > 0) {
      if (!this.hasAudioTrack) {
        summaryVerdict = `FAIL (${profileMeta.label}): Windows/Chrome did not return a system audio track.`;
      } else if (this.trackDropoutsObserved > 0) {
        summaryVerdict = `WARN (${profileMeta.label}): System audio track disconnected unexpectedly.`;
      } else if (this.peakRmsObserved >= 0.008 && avgSpeechBandRatio >= 0.22 && elapsedSeconds >= 5) {
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
      realtimeTelemetry: this.buildRealtimeTelemetryView(),
      checks,
      summaryVerdict,
    };
  }
}
