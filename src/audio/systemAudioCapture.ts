import type {
  AppAlert,
  AudioActivityStatus,
  AudioConnectionStatus,
  AudioEnhancementMode,
  AudioLevelMetrics,
  CaptureSourceMode,
  ChannelSelectionMode,
  ChannelTopology,
  DiagnosticProfileId,
} from '../types/index.ts';
import { CAPTURE_SOURCE_MODES, DIAGNOSTIC_PROFILES } from '../config/models.ts';
import { TARGET_SAMPLE_RATE, rmsToDbfs } from './dsp.ts';
import { EphemeralAudioEnhancer } from './enhancement.ts';

export interface SystemAudioCaptureCallbacks {
  onConnectionStatus: (status: AudioConnectionStatus) => void;
  onActivityStatus: (status: AudioActivityStatus) => void;
  onLevelMetrics: (metrics: AudioLevelMetrics) => void;
  onPcmChunk16k: (chunk: Float32Array) => void;
  onAlert: (alert: AppAlert) => void;
  onExternalOrUnexpectedStop: (alert: AppAlert) => void;
}

export interface DetailedTrackInfo {
  captureMode: CaptureSourceMode;
  displaySurface: string;
  trackLabel: string;
  sampleRateHz: number | null;
  trackSampleRateHz: number | null;
  channelCount: number;
  trackReadyState: string;
  trackMuted: boolean;
  isLive: boolean;
}

const ACTIVITY_RMS_THRESHOLD = 0.0035;
const ACTIVITY_HOLD_MS = 900;
const NO_ACTIVITY_WARNING_MS = 12_000;

export class SystemAudioCaptureController {
  private readonly callbacks: SystemAudioCaptureCallbacks;
  private readonly enhancer = new EphemeralAudioEnhancer('gentle');

  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private silentGainNode: GainNode | null = null;

  private stoppingInternally = false;
  private paused = false;
  private forwardingSamples = false;

  private captureMode: CaptureSourceMode = 'entire-screen-system';
  private channelMode: ChannelSelectionMode = 'auto';
  private selectedDisplaySurface = '';

  private lastActiveAtMs = 0;
  private everDetectedSound = false;
  private currentActivity: AudioActivityStatus = 'Audio inactive';
  private noActivityTimer: ReturnType<typeof setTimeout> | null = null;
  private activeProfile: DiagnosticProfileId = 'standard';

  private audioTrackLabel = '';
  private hardwareSampleRate: number | null = null;
  private trackReportedSampleRate: number | null = null;
  private observedChannelCount = 2;

  constructor(callbacks: SystemAudioCaptureCallbacks) {
    this.callbacks = callbacks;
  }

  public setDiagnosticProfile(profile: DiagnosticProfileId): void {
    this.activeProfile = profile;
  }

  public setCaptureMode(mode: CaptureSourceMode): void {
    this.captureMode = mode;
  }

  public getCaptureMode(): CaptureSourceMode {
    return this.captureMode;
  }

  public setChannelSelectionMode(mode: ChannelSelectionMode): void {
    this.channelMode = mode;
    this.workletNode?.port.postMessage({
      type: 'set-channel-mode',
      channelMode: mode,
    });
  }

  public getChannelSelectionMode(): ChannelSelectionMode {
    return this.channelMode;
  }

  public setEnhancementMode(mode: AudioEnhancementMode): void {
    this.enhancer.setMode(mode);
  }

  public getEnhancementMode(): AudioEnhancementMode {
    return this.enhancer.getMode();
  }

  public getTrackInfo(): DetailedTrackInfo {
    const audioTrack = this.mediaStream?.getAudioTracks()[0];
    return {
      captureMode: this.captureMode,
      displaySurface: this.selectedDisplaySurface,
      trackLabel: this.audioTrackLabel,
      sampleRateHz: this.hardwareSampleRate,
      trackSampleRateHz: this.trackReportedSampleRate,
      channelCount: this.observedChannelCount,
      trackReadyState: audioTrack ? audioTrack.readyState : 'none',
      trackMuted: Boolean(audioTrack?.muted),
      isLive: Boolean(audioTrack && audioTrack.readyState === 'live'),
    };
  }

  public static checkBrowserSupport(): { supported: boolean; alert?: AppAlert } {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return {
        supported: false,
        alert: {
          code: 'SCREEN_CAPTURE_UNSUPPORTED',
          severity: 'error',
          title: 'HTTPS Secure Context Required',
          message:
            'Chrome requires a secure HTTPS connection to capture Windows system audio via screen sharing.',
          remediation:
            'Open this application over https:// rather than an insecure http:// or file:// address.',
        },
      };
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
      return {
        supported: false,
        alert: {
          code: 'SCREEN_CAPTURE_UNSUPPORTED',
          severity: 'error',
          title: 'Screen Capture API Not Supported',
          message:
            'This browser does not support navigator.mediaDevices.getDisplayMedia() required for Windows system audio capture.',
          remediation:
            'Open this webpage in Google Chrome on Windows over HTTPS.',
        },
      };
    }

    if (
      typeof AudioContext === 'undefined' &&
      typeof (globalThis as Record<string, unknown>).webkitAudioContext === 'undefined'
    ) {
      return {
        supported: false,
        alert: {
          code: 'SCREEN_CAPTURE_UNSUPPORTED',
          severity: 'error',
          title: 'Web Audio API Unavailable',
          message: 'This browser does not expose AudioContext required for local audio processing.',
        },
      };
    }

    return { supported: true };
  }

  /**
   * Must be invoked directly from an explicit user button click (START TRANSCRIPTION or Test Audio Only).
   * Supports Entire Screen + System Audio, Window + Application Audio (Win 11 / supported Chrome), and
   * Window + System Audio. Verifies usable audio track without ever falling back to microphone.
   */
  public async startCapture(forwardSpeechSamplesImmediately: boolean): Promise<boolean> {
    const support = SystemAudioCaptureController.checkBrowserSupport();
    if (!support.supported && support.alert) {
      this.callbacks.onConnectionStatus('Not connected');
      this.callbacks.onAlert(support.alert);
      return false;
    }

    this.stoppingInternally = false;
    this.paused = false;
    this.forwardingSamples = forwardSpeechSamplesImmediately;
    this.everDetectedSound = false;
    this.lastActiveAtMs = 0;
    this.currentActivity = 'Audio inactive';
    this.selectedDisplaySurface = '';
    this.enhancer.resetAndZero();

    this.callbacks.onConnectionStatus('Requesting screen-sharing permission');
    this.callbacks.onActivityStatus('Audio inactive');

    let stream: MediaStream;
    try {
      stream = await this.requestDisplayStreamForSelectedMode();
    } catch (err) {
      this.callbacks.onConnectionStatus('Not connected');
      this.callbacks.onAlert(this.mapDisplayMediaError(err));
      return false;
    }

    this.mediaStream = stream;
    this.callbacks.onConnectionStatus('Screen sharing active');

    // Inspect video track (never process, render, screenshot, or save video!)
    const videoTracks = stream.getVideoTracks();
    for (const vTrack of videoTracks) {
      try {
        const settings = vTrack.getSettings?.() as MediaTrackSettings & {
          displaySurface?: string;
        };
        if (settings?.displaySurface) {
          this.selectedDisplaySurface = settings.displaySurface;
        }
      } catch {
        // Ignore settings read errors
      }
      vTrack.enabled = false;
    }

    // Inspect audio tracks — NEVER fall back to microphone!
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0 || audioTracks[0].readyState === 'ended') {
      const chosenSurface = this.selectedDisplaySurface;
      await this.stopAndCleanup();
      this.callbacks.onConnectionStatus('No system audio detected');

      const profileGuidance = DIAGNOSTIC_PROFILES[this.activeProfile].routingGuidance;
      const selectedWindow = chosenSurface === 'window' || chosenSurface === 'browser';

      const windowModeExplanation =
        this.captureMode !== 'entire-screen-system'
          ? 'Your Windows/Chrome build did not provide per-window application audio for the selected window (per-window audio requires supported Windows 11 + Chrome application-audio builds). Switch Capture Source to "A. Entire Screen + System Audio".'
          : 'You shared an individual window or tab without system audio. On Windows, Chrome reliably provides desktop softphone audio when you share "Entire Screen" and enable "Also share system audio".';

      this.callbacks.onAlert({
        code: selectedWindow ? 'SYSTEM_AUDIO_NOT_SELECTED' : 'NO_AUDIO_TRACK',
        severity: 'error',
        title: selectedWindow
          ? 'No Usable Audio Track Attached to Shared Window'
          : 'No Accessible Windows System Audio Track Returned',
        message: selectedWindow
          ? windowModeExplanation
          : 'Chrome is sharing your screen, but Windows has not provided an accessible system audio track. Check whether you enabled "Also share system audio" in Chrome\'s dialog, and check whether NICE CXone or Avaya is routing call audio through a separate audio endpoint.',
        remediation: `1) Select Capture Source "A. Entire Screen + System Audio" -> click START TRANSCRIPTION -> choose "Entire Screen" -> turn ON "Also share system audio" -> Share. 2) ${profileGuidance}`,
      });
      return false;
    }

    const primaryAudioTrack = audioTracks[0];
    this.audioTrackLabel = primaryAudioTrack.label || 'Windows System Output Audio';

    // Read actual hardware track settings reported by Chromium
    try {
      const aSettings = primaryAudioTrack.getSettings?.();
      if (aSettings) {
        if (typeof aSettings.sampleRate === 'number' && aSettings.sampleRate > 0) {
          this.trackReportedSampleRate = aSettings.sampleRate;
        }
        if (typeof aSettings.channelCount === 'number' && aSettings.channelCount > 0) {
          this.observedChannelCount = aSettings.channelCount;
        }
      }
    } catch {
      // Ignore track settings read errors
    }

    this.callbacks.onConnectionStatus('System audio detected');

    const handleTrackEnded = (source: 'video' | 'audio') => {
      if (this.stoppingInternally) {
        return;
      }
      const alert: AppAlert =
        source === 'video'
          ? {
              code: 'EXTERNAL_STOP_SHARING',
              severity: 'info',
              title: 'Screen Sharing Stopped Outside Application',
              message:
                'You stopped screen sharing from Chrome\'s browser controls. Session ended and all temporary audio and transcript data were cleared.',
            }
          : {
              code: 'CAPTURE_STOPPED_UNEXPECTEDLY',
              severity: 'warning',
              title: 'System Audio Capture Stopped Unexpectedly',
              message:
                'The Windows audio track ended unexpectedly (for example, headset profile switch or softphone endpoint change). Temporary session data was cleared.',
              remediation:
                'Verify your headset is connected in Windows Sound output and click START TRANSCRIPTION to begin a fresh session.',
            };
      void this.stopAndCleanup().then(() => {
        this.callbacks.onExternalOrUnexpectedStop(alert);
      });
    };

    for (const vTrack of videoTracks) {
      vTrack.addEventListener('ended', () => handleTrackEnded('video'), { once: true });
    }
    for (const aTrack of audioTracks) {
      aTrack.addEventListener('ended', () => handleTrackEnded('audio'), { once: true });
      aTrack.addEventListener?.('mute', () => {
        if (!this.stoppingInternally && !this.paused) {
          this.callbacks.onActivityStatus('Audio inactive');
        }
      });
    }

    // Build Web Audio + AudioWorklet pipeline at native hardware sample rate
    try {
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      const ctx = new AudioCtx({ latencyHint: 'interactive' });
      this.audioContext = ctx;
      this.hardwareSampleRate = ctx.sampleRate;

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
        throw new Error('AudioWorklet API is unavailable in this browser context.');
      }

      const workletUrl = new URL('./audio-capture-worklet.js', window.location.href).href;
      await ctx.audioWorklet.addModule(workletUrl);

      const audioOnlyStream = new MediaStream([primaryAudioTrack]);
      const source = ctx.createMediaStreamSource(audioOnlyStream);
      const worklet = new AudioWorkletNode(ctx, 'ephemeral-pcm-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      worklet.port.postMessage({
        type: 'set-forwarding',
        forwardSamples: this.forwardingSamples,
      });
      worklet.port.postMessage({
        type: 'set-channel-mode',
        channelMode: this.channelMode,
      });

      worklet.port.onmessage = (event: MessageEvent) => {
        this.handleWorkletMessage(event.data);
      };

      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(ctx.destination);

      this.sourceNode = source;
      this.workletNode = worklet;
      this.silentGainNode = silentGain;

      this.armNoActivityWatchdog();
      return true;
    } catch (err) {
      await this.stopAndCleanup();
      this.callbacks.onConnectionStatus('Not connected');
      this.callbacks.onAlert({
        code: 'CAPTURE_STOPPED_UNEXPECTEDLY',
        severity: 'error',
        title: 'Audio Processing Pipeline Failed to Initialize',
        message:
          err instanceof Error
            ? `Unable to initialize Web Audio / AudioWorklet pipeline: ${err.message}`
            : 'Unable to initialize Web Audio / AudioWorklet pipeline.',
        remediation:
          'Confirm you are using Google Chrome over HTTPS and refresh the page.',
      });
      return false;
    }
  }

  public setForwardingSpeechSamples(enabled: boolean): void {
    this.forwardingSamples = enabled;
    this.workletNode?.port.postMessage({
      type: 'set-forwarding',
      forwardSamples: enabled,
    });
  }

  public pause(): void {
    this.paused = true;
    this.clearNoActivityWatchdog();
    this.enhancer.resetAndZero();
    this.workletNode?.port.postMessage({ type: 'pause', paused: true });
    this.currentActivity = 'Audio inactive';
    this.callbacks.onActivityStatus('Audio inactive');
    this.callbacks.onLevelMetrics({
      rms: 0,
      peak: 0,
      dbfs: -100,
      peakDbfs: -100,
      leftRms: 0,
      rightRms: 0,
      leftDbfs: -100,
      rightDbfs: -100,
      channelCount: this.observedChannelCount,
      channelTopology: 'silent',
      channelCorrelation: 0,
      sourceSampleRate: this.hardwareSampleRate ?? undefined,
      outputSampleRate: TARGET_SAMPLE_RATE,
      enhancementMode: this.enhancer.getMode(),
      enhancementGainDb: 0,
      speechBandRatio: 0,
      clipping: false,
      isSpeechActive: false,
    });
  }

  public resume(): void {
    this.paused = false;
    this.workletNode?.port.postMessage({ type: 'pause', paused: false });
    if (!this.everDetectedSound) {
      this.armNoActivityWatchdog();
    }
  }

  public async stopAndCleanup(): Promise<void> {
    this.stoppingInternally = true;
    this.paused = false;
    this.forwardingSamples = false;
    this.clearNoActivityWatchdog();
    this.enhancer.resetAndZero();

    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'shutdown' });
        this.workletNode.port.onmessage = null;
        this.workletNode.port.close();
      } catch {
        // Ignore already-closed port
      }
      try {
        this.workletNode.disconnect();
      } catch {
        // Ignore disconnect error
      }
      this.workletNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore
      }
      this.sourceNode = null;
    }

    if (this.silentGainNode) {
      try {
        this.silentGainNode.disconnect();
      } catch {
        // Ignore
      }
      this.silentGainNode = null;
    }

    if (this.audioContext) {
      const ctx = this.audioContext;
      this.audioContext = null;
      try {
        if (ctx.state !== 'closed') {
          await ctx.close();
        }
      } catch {
        // Ignore close error
      }
    }

    if (this.mediaStream) {
      const tracks = this.mediaStream.getTracks();
      for (const track of tracks) {
        try {
          track.stop();
        } catch {
          // Ignore track stop error
        }
      }
      this.mediaStream = null;
    }

    this.audioTrackLabel = '';
    this.hardwareSampleRate = null;
    this.trackReportedSampleRate = null;
    this.selectedDisplaySurface = '';
    this.currentActivity = 'Audio inactive';
  }

  private async requestDisplayStreamForSelectedMode(): Promise<MediaStream> {
    // Disable browser microphone-oriented DSP (echoCancellation/noiseSuppression/autoGainControl)
    // so Chrome delivers clean, unaltered system output PCM.
    const cleanAudioConstraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };

    const preferredSurface =
      this.captureMode === 'entire-screen-system' ? 'monitor' : 'window';

    const extendedOptions: Record<string, unknown> = {
      video: {
        displaySurface: preferredSurface,
        frameRate: { ideal: 1, max: 5 },
        width: { max: 320 },
        height: { max: 240 },
      },
      audio: cleanAudioConstraints,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    };

    if (this.captureMode === 'window-app-audio') {
      // Chromium Windows 11 per-window application audio hint where supported
      extendedOptions.windowAudio = 'window';
    } else if (this.captureMode === 'window-system-audio') {
      extendedOptions.windowAudio = 'system';
    }

    try {
      return await navigator.mediaDevices.getDisplayMedia(
        extendedOptions as DisplayMediaStreamOptions,
      );
    } catch (err) {
      const name = (err as DOMException)?.name ?? '';
      if (name === 'TypeError' || name === 'OverconstrainedError') {
        return navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
          // @ts-expect-error Chrome DisplayMediaStreamOptions extension
          systemAudio: 'include',
        });
      }
      throw err;
    }
  }

  private mapDisplayMediaError(err: unknown): AppAlert {
    const domErr = err as DOMException | Error | undefined;
    const name = domErr?.name ?? '';
    const message = domErr?.message ?? '';

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'AbortError') {
      const isIframePolicy =
        typeof window !== 'undefined' &&
        window.self !== window.top &&
        /permission policy|display-capture|disallowed/i.test(message);

      if (isIframePolicy) {
        return {
          code: 'SCREEN_CAPTURE_UNSUPPORTED',
          severity: 'error',
          title: 'Embedded Frame Blocks Screen Audio Capture',
          message:
            'This page is currently embedded inside an outer preview frame whose Permissions-Policy restricts display-capture.',
          remediation:
            'Click "Open Standalone HTTPS Tab" in the top bar to open the application directly in a full Chrome tab where screen + system audio sharing works natively.',
        };
      }

      return {
        code: 'PERMISSION_DENIED',
        severity: 'warning',
        title: 'Screen-Sharing Permission Cancelled or Denied',
        message:
          'Screen and audio sharing was cancelled or denied. No audio is being captured.',
        remediation: `When ready, click START TRANSCRIPTION (${CAPTURE_SOURCE_MODES[this.captureMode].chromeStepHint}).`,
      };
    }

    if (name === 'NotFoundError') {
      return {
        code: 'NO_AUDIO_TRACK',
        severity: 'error',
        title: 'No Screen or Audio Capture Source Available',
        message: 'Chrome could not find a sharable screen or audio output source.',
      };
    }

    if (name === 'NotReadableError') {
      return {
        code: 'CAPTURE_STOPPED_UNEXPECTEDLY',
        severity: 'error',
        title: 'Windows Audio/Display Endpoint Busy or Unreadable',
        message:
          'Windows prevented Chrome from reading the selected screen or audio output device (for example, exclusive-mode audio driver lock).',
        remediation:
          'Check that your headset is not locked in Exclusive Mode by another application and try again.',
      };
    }

    return {
      code: 'SCREEN_CAPTURE_UNSUPPORTED',
      severity: 'error',
      title: 'Unable to Start Chrome Screen Audio Capture',
      message: message || 'An unexpected browser error prevented screen audio capture.',
      remediation:
        'Ensure you clicked START TRANSCRIPTION directly in Google Chrome on Windows over HTTPS.',
    };
  }

  private handleWorkletMessage(data: unknown): void {
    if (!data || typeof data !== 'object') {
      return;
    }
    const msg = data as {
      type?: string;
      rms?: number;
      peak?: number;
      leftRms?: number;
      rightRms?: number;
      channelCount?: number;
      channelTopology?: ChannelTopology;
      channelCorrelation?: number;
      sourceSampleRate?: number;
      speechBandRatio?: number;
      clipping?: boolean;
      samples?: Float32Array;
    };

    if (this.paused || this.stoppingInternally) {
      if (msg.type === 'pcm' && msg.samples instanceof Float32Array) {
        msg.samples.fill(0);
      }
      return;
    }

    if (msg.type === 'level') {
      const rms = typeof msg.rms === 'number' ? msg.rms : 0;
      const peak = typeof msg.peak === 'number' ? msg.peak : 0;
      const leftRms = typeof msg.leftRms === 'number' ? msg.leftRms : rms;
      const rightRms = typeof msg.rightRms === 'number' ? msg.rightRms : rms;
      const speechBandRatio = typeof msg.speechBandRatio === 'number' ? msg.speechBandRatio : 0;
      const clipping = Boolean(msg.clipping);
      const now = Date.now();

      if (typeof msg.channelCount === 'number' && msg.channelCount > 0) {
        this.observedChannelCount = msg.channelCount;
      }
      if (typeof msg.sourceSampleRate === 'number' && msg.sourceSampleRate > 0) {
        this.hardwareSampleRate = msg.sourceSampleRate;
      }

      if (rms >= ACTIVITY_RMS_THRESHOLD) {
        this.lastActiveAtMs = now;
        if (!this.everDetectedSound) {
          this.everDetectedSound = true;
          this.clearNoActivityWatchdog();
        }
      }

      const isActive =
        rms >= ACTIVITY_RMS_THRESHOLD ||
        (this.lastActiveAtMs > 0 && now - this.lastActiveAtMs <= ACTIVITY_HOLD_MS);

      const nextStatus: AudioActivityStatus = isActive
        ? 'Audio activity detected'
        : 'Audio inactive';

      if (nextStatus !== this.currentActivity) {
        this.currentActivity = nextStatus;
        this.callbacks.onActivityStatus(nextStatus);
      }

      this.callbacks.onLevelMetrics({
        rms,
        peak,
        dbfs: rmsToDbfs(rms),
        peakDbfs: rmsToDbfs(peak),
        leftRms,
        rightRms,
        leftDbfs: rmsToDbfs(leftRms),
        rightDbfs: rmsToDbfs(rightRms),
        channelCount: this.observedChannelCount,
        channelTopology: msg.channelTopology ?? 'identical-stereo',
        channelCorrelation: msg.channelCorrelation ?? 1,
        sourceSampleRate: this.hardwareSampleRate ?? undefined,
        outputSampleRate: TARGET_SAMPLE_RATE,
        enhancementMode: this.enhancer.getMode(),
        enhancementGainDb: this.enhancer.getLastAppliedGainDb(),
        speechBandRatio,
        clipping,
        isSpeechActive: isActive && speechBandRatio >= 0.14,
      });
      return;
    }

    if (msg.type === 'pcm' && msg.samples instanceof Float32Array) {
      if (!this.forwardingSamples) {
        msg.samples.fill(0);
        return;
      }
      // Run optional in-memory audio enhancement (or exact raw bypass when 'off')
      const enhanced = this.enhancer.processChunk16k(msg.samples);
      msg.samples.fill(0);
      this.callbacks.onPcmChunk16k(enhanced.samples);
    }
  }

  private armNoActivityWatchdog(): void {
    this.clearNoActivityWatchdog();
    this.noActivityTimer = setTimeout(() => {
      if (!this.everDetectedSound && !this.paused && !this.stoppingInternally && this.mediaStream) {
        const routingTip = DIAGNOSTIC_PROFILES[this.activeProfile].routingGuidance;
        this.callbacks.onAlert({
          code: 'NO_AUDIO_ACTIVITY',
          severity: 'warning',
          title: 'Active Track Connected, But Zero Sound Energy Detected',
          message:
            'Chrome returned a live audio track, yet 0.000 sound energy (-100 dBFS) has reached the browser.',
          remediation: `Play harmless sample audio to confirm capture. If audible in your headset while -100 dBFS here: ${routingTip}`,
        });
      }
    }, NO_ACTIVITY_WARNING_MS);
  }

  private clearNoActivityWatchdog(): void {
    if (this.noActivityTimer !== null) {
      clearTimeout(this.noActivityTimer);
      this.noActivityTimer = null;
    }
  }
}
