import {
  DEFAULT_MODEL_KEY,
  DIAGNOSTIC_PROFILES,
  WHISPER_MODELS,
  validateDevicePreference,
  validateDiagnosticProfile,
  validateModelKey,
} from '../config/models.ts';
import { CompatibilityDiagnosticsEngine } from '../audio/compatibilityDiagnostics.ts';
import { SystemAudioCaptureController } from '../audio/systemAudioCapture.ts';
import { EphemeralVadSegmenter } from '../audio/vadSegmenter.ts';
import {
  purgeApplicationCacheStorage,
  runLivePrivacyAudit,
  verifyLocalProcessingConfiguration,
} from '../privacy/storageAudit.ts';
import {
  LocalWhisperEngine,
  type WorkerLike,
} from '../transcription/whisperEngine.ts';
import type {
  AppAlert,
  AudioActivityStatus,
  AudioConnectionStatus,
  AudioLevelMetrics,
  DiagnosticProfileId,
  ModelKey,
  ModelLoadingStatus,
  PreferredDeviceSetting,
  ProcessingDevice,
  ProcessingStatus,
  SessionLifecycleState,
  TranscriptSegment,
} from '../types/index.ts';
import { EphemeralLevelMeter } from './levelMeter.ts';

function getRequiredElement<T extends HTMLElement>(root: ParentNode, id: string): T {
  const el = root.querySelector<T>(`#${id}`);
  if (!el) {
    throw new Error(`Missing required UI element #${id}`);
  }
  return el;
}

function formatDurationHhMmSs(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatElapsedMmSs(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `+${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export interface AppControllerOptions {
  root?: ParentNode;
  workerFactory?: () => WorkerLike;
}

export class PrivateTranscriberAppController {
  private readonly root: ParentNode;
  private readonly audioCapture: SystemAudioCaptureController;
  private readonly vadSegmenter: EphemeralVadSegmenter;
  private readonly whisperEngine: LocalWhisperEngine;
  private readonly diagnosticsEngine: CompatibilityDiagnosticsEngine;
  private readonly levelMeter: EphemeralLevelMeter;

  // Ephemeral active-session state (cleared completely on STOP / unload)
  private lifecycleState: SessionLifecycleState = 'idle';
  private diagnosticsOnlyMode = false;
  private selectedModelKey: ModelKey = DEFAULT_MODEL_KEY;
  private selectedDevicePref: PreferredDeviceSetting = 'auto';
  private selectedProfile: DiagnosticProfileId = 'standard';
  private activeDevice: ProcessingDevice | null = null;
  private connectionStatus: AudioConnectionStatus = 'Not connected';
  private activityStatus: AudioActivityStatus = 'Audio inactive';
  private modelStatus: ModelLoadingStatus = 'Not loaded (on-demand or preload)';
  private processingStatus: ProcessingStatus = 'Idle';

  private segments: TranscriptSegment[] = [];
  private nextSegmentId = 1;
  private sessionStartedAtMs = 0;
  private pausedAccumulatedMs = 0;
  private pauseBeganAtMs = 0;
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private recentHighlightTimer: ReturnType<typeof setTimeout> | null = null;

  // Bound DOM references
  private readonly headerPrivacyBadge: HTMLElement;
  private readonly headerEngineBadge: HTMLElement;
  private readonly headerModeBadge: HTMLElement;
  private readonly standaloneTabLink: HTMLAnchorElement;

  private readonly alertRegion: HTMLElement;
  private readonly alertTitle: HTMLElement;
  private readonly alertMessage: HTMLElement;
  private readonly alertRemediation: HTMLElement;
  private readonly alertDismissBtn: HTMLButtonElement;

  private readonly connectionDot: HTMLElement;
  private readonly connectionStatusEl: HTMLElement;
  private readonly activityDot: HTMLElement;
  private readonly activityStatusEl: HTMLElement;

  private readonly btnStart: HTMLButtonElement;
  private readonly btnPause: HTMLButtonElement;
  private readonly btnResume: HTMLButtonElement;
  private readonly btnStop: HTMLButtonElement;
  private readonly btnClear: HTMLButtonElement;
  private readonly btnPreload: HTMLButtonElement;
  private readonly btnRunAudioDiag: HTMLButtonElement;
  private readonly btnVerifyPrivacy: HTMLButtonElement;

  private readonly selectModel: HTMLSelectElement;
  private readonly selectDevice: HTMLSelectElement;
  private readonly selectProfile: HTMLSelectElement;
  private readonly modelTradeoffNote: HTMLElement;

  private readonly meterDbfs: HTMLElement;
  private readonly meterVoiceband: HTMLElement;
  private readonly meterVadPill: HTMLElement;

  private readonly processingIndicator: HTMLElement;
  private readonly processingIndicatorText: HTMLElement;
  private readonly transcriptFeed: HTMLElement;
  private readonly transcriptEmptyState: HTMLElement;
  private readonly transcriptEmptyTitle: HTMLElement;
  private readonly transcriptEmptyDesc: HTMLElement;

  private readonly infoDuration: HTMLElement;
  private readonly infoConnection: HTMLElement;
  private readonly infoEngine: HTMLElement;
  private readonly infoMethod: HTMLElement;
  private readonly infoModelStatus: HTMLElement;
  private readonly infoProcessingStatus: HTMLElement;
  private readonly modelProgressWrap: HTMLElement;
  private readonly modelProgressFill: HTMLElement;
  private readonly modelProgressDetail: HTMLElement;

  private readonly privacyModeIndicator: HTMLElement;
  private readonly privacyStatement: HTMLElement;
  private readonly privacyVerifiedStamp: HTMLElement;
  private readonly privacyAuditResults: HTMLElement;
  private readonly privacyAuditList: HTMLElement;
  private readonly networkAuditLog: HTMLElement;

  private readonly diagChecklist: HTMLElement;
  private readonly diagVerdict: HTMLElement;

  private readonly boundUnloadCleanup: () => void;

  constructor(options: AppControllerOptions = {}) {
    this.root = options.root ?? document;

    this.headerPrivacyBadge = getRequiredElement(this.root, 'header-privacy-badge');
    this.headerEngineBadge = getRequiredElement(this.root, 'header-engine-badge');
    this.headerModeBadge = getRequiredElement(this.root, 'header-mode-badge');
    this.standaloneTabLink = getRequiredElement<HTMLAnchorElement>(
      this.root,
      'standalone-tab-link',
    );

    this.alertRegion = getRequiredElement(this.root, 'alert-region');
    this.alertTitle = getRequiredElement(this.root, 'alert-title');
    this.alertMessage = getRequiredElement(this.root, 'alert-message');
    this.alertRemediation = getRequiredElement(this.root, 'alert-remediation');
    this.alertDismissBtn = getRequiredElement<HTMLButtonElement>(this.root, 'alert-dismiss-btn');

    this.connectionDot = getRequiredElement(this.root, 'connection-status-dot');
    this.connectionStatusEl = getRequiredElement(this.root, 'audio-connection-status');
    this.activityDot = getRequiredElement(this.root, 'activity-status-dot');
    this.activityStatusEl = getRequiredElement(this.root, 'audio-activity-status');

    this.btnStart = getRequiredElement<HTMLButtonElement>(this.root, 'btn-start');
    this.btnPause = getRequiredElement<HTMLButtonElement>(this.root, 'btn-pause');
    this.btnResume = getRequiredElement<HTMLButtonElement>(this.root, 'btn-resume');
    this.btnStop = getRequiredElement<HTMLButtonElement>(this.root, 'btn-stop');
    this.btnClear = getRequiredElement<HTMLButtonElement>(this.root, 'btn-clear');
    this.btnPreload = getRequiredElement<HTMLButtonElement>(this.root, 'btn-preload-model');
    this.btnRunAudioDiag = getRequiredElement<HTMLButtonElement>(this.root, 'btn-run-audio-diag');
    this.btnVerifyPrivacy = getRequiredElement<HTMLButtonElement>(
      this.root,
      'btn-verify-privacy',
    );

    this.selectModel = getRequiredElement<HTMLSelectElement>(this.root, 'select-model');
    this.selectDevice = getRequiredElement<HTMLSelectElement>(this.root, 'select-device');
    this.selectProfile = getRequiredElement<HTMLSelectElement>(this.root, 'select-profile');
    this.modelTradeoffNote = getRequiredElement(this.root, 'model-tradeoff-note');

    this.meterDbfs = getRequiredElement(this.root, 'meter-dbfs');
    this.meterVoiceband = getRequiredElement(this.root, 'meter-voiceband');
    this.meterVadPill = getRequiredElement(this.root, 'meter-vad-pill');

    const canvas = getRequiredElement<HTMLCanvasElement>(this.root, 'audio-level-canvas');
    this.levelMeter = new EphemeralLevelMeter(canvas);

    this.processingIndicator = getRequiredElement(this.root, 'processing-indicator');
    this.processingIndicatorText = getRequiredElement(this.root, 'processing-indicator-text');
    this.transcriptFeed = getRequiredElement(this.root, 'transcript-feed');
    this.transcriptEmptyState = getRequiredElement(this.root, 'transcript-empty-state');
    this.transcriptEmptyTitle = getRequiredElement(this.root, 'transcript-empty-title');
    this.transcriptEmptyDesc = getRequiredElement(this.root, 'transcript-empty-desc');

    this.infoDuration = getRequiredElement(this.root, 'info-duration');
    this.infoConnection = getRequiredElement(this.root, 'info-connection');
    this.infoEngine = getRequiredElement(this.root, 'info-engine');
    this.infoMethod = getRequiredElement(this.root, 'info-method');
    this.infoModelStatus = getRequiredElement(this.root, 'info-model-status');
    this.infoProcessingStatus = getRequiredElement(this.root, 'info-processing-status');
    this.modelProgressWrap = getRequiredElement(this.root, 'model-progress-wrap');
    this.modelProgressFill = getRequiredElement(this.root, 'model-progress-fill');
    this.modelProgressDetail = getRequiredElement(this.root, 'model-progress-detail');

    this.privacyModeIndicator = getRequiredElement(this.root, 'privacy-mode-indicator');
    this.privacyStatement = getRequiredElement(this.root, 'privacy-statement');
    this.privacyVerifiedStamp = getRequiredElement(this.root, 'privacy-verified-stamp');
    this.privacyAuditResults = getRequiredElement(this.root, 'privacy-audit-results');
    this.privacyAuditList = getRequiredElement(this.root, 'privacy-audit-list');
    this.networkAuditLog = getRequiredElement(this.root, 'network-audit-log');

    this.diagChecklist = getRequiredElement(this.root, 'diag-checklist');
    this.diagVerdict = getRequiredElement(this.root, 'diag-verdict');

    this.diagnosticsEngine = new CompatibilityDiagnosticsEngine();
    this.diagnosticsEngine.setProfile(this.selectedProfile);

    this.vadSegmenter = new EphemeralVadSegmenter({
      onSpeechStateChange: (speaking) => {
        if (this.lifecycleState === 'active' && !this.diagnosticsOnlyMode) {
          if (speaking && this.whisperEngine.pendingCount === 0) {
            this.setProcessingStatus('Speech detected — buffering segment');
          } else if (!speaking && this.whisperEngine.pendingCount === 0) {
            this.setProcessingStatus('Listening for speech');
          }
        }
      },
      onSegmentReady: (segment) => {
        if (this.lifecycleState === 'active' && !this.diagnosticsOnlyMode) {
          this.whisperEngine.enqueueSegment(segment);
        } else {
          segment.samples.fill(0);
        }
      },
    });

    this.whisperEngine = new LocalWhisperEngine(
      {
        onModelLoadingStatus: (status, progressPct, detail) => {
          this.modelStatus = status;
          this.infoModelStatus.textContent = status;
          if (progressPct !== null && status !== 'Ready (in local RAM)') {
            this.modelProgressWrap.classList.remove('hidden');
            this.modelProgressFill.style.width = `${Math.max(2, Math.min(100, progressPct))}%`;
            this.modelProgressDetail.textContent = detail ?? '';
          } else if (status === 'Compiling shaders & warming up local model...') {
            this.modelProgressWrap.classList.remove('hidden');
            this.modelProgressFill.style.width = '100%';
            this.modelProgressDetail.textContent = detail ?? 'Compiling shaders...';
          } else {
            this.modelProgressWrap.classList.add('hidden');
            this.modelProgressFill.style.width = '0%';
            this.modelProgressDetail.textContent = '';
          }
        },
        onEngineReady: (modelKey, device) => {
          this.activeDevice = device;
          const spec = WHISPER_MODELS[modelKey];
          const methodLabel =
            device === 'webgpu' ? 'WebGPU (Hardware GPU)' : 'WebAssembly (CPU SIMD)';
          this.headerEngineBadge.textContent = `Engine: ${spec.shortName}`;
          this.headerModeBadge.textContent = `Mode: ${methodLabel}`;
          this.infoEngine.textContent = spec.shortName;
          this.infoMethod.textContent = methodLabel;
        },
        onQueueStateChange: (inFlight, queuedCount) => {
          const totalWaiting = (inFlight ? 1 : 0) + queuedCount;
          if (totalWaiting > 0 && this.lifecycleState === 'active') {
            this.processingIndicator.classList.remove('hidden');
            this.processingIndicatorText.textContent =
              queuedCount > 0
                ? `Recognizing speech locally (${queuedCount} queued)...`
                : 'Recognizing speech locally...';
            this.setProcessingStatus('Recognizing speech locally...');
          } else {
            this.processingIndicator.classList.add('hidden');
            if (this.lifecycleState === 'active' && !this.diagnosticsOnlyMode) {
              this.setProcessingStatus(
                this.vadSegmenter.speaking
                  ? 'Speech detected — buffering segment'
                  : 'Listening for speech',
              );
            }
          }
        },
        onSegmentTranscribed: ({ text, clockTimestamp, processingMs }) => {
          if (this.lifecycleState !== 'active') {
            return;
          }
          this.appendRecognizedSegment(text, clockTimestamp, processingMs);
        },
        onAlert: (alert) => {
          this.showAlert(alert);
        },
      },
      options.workerFactory,
    );

    this.audioCapture = new SystemAudioCaptureController({
      onConnectionStatus: (status) => {
        this.setConnectionStatus(status);
      },
      onActivityStatus: (status) => {
        this.setActivityStatus(status);
      },
      onLevelMetrics: (metrics) => {
        this.handleAudioLevelMetrics(metrics);
      },
      onPcmChunk16k: (chunk) => {
        if (this.lifecycleState === 'active' && !this.diagnosticsOnlyMode) {
          this.vadSegmenter.pushChunk16k(chunk);
        } else {
          chunk.fill(0);
        }
      },
      onAlert: (alert) => {
        this.showAlert(alert);
      },
      onExternalOrUnexpectedStop: (alert) => {
        this.diagnosticsEngine.recordTrackDropout();
        void this.stopSessionAndClearAll(true, alert);
      },
    });

    this.boundUnloadCleanup = () => {
      this.performImmediateSynchronousUnloadCleanup();
    };
  }

  public async initialize(): Promise<void> {
    await purgeApplicationCacheStorage();
    this.verifyAndRenderPrivacyGate();
    this.updateModelTradeoffDescription();
    this.renderDiagnosticsPanel();
    this.bindUiEvents();

    if (typeof window !== 'undefined' && window.self !== window.top) {
      this.standaloneTabLink.href = window.location.href;
      this.standaloneTabLink.classList.remove('hidden');
    }

    // Detect browser page reload using ephemeral PerformanceNavigationTiming (zero storage!)
    this.checkNavigationReloadNotice();
    this.syncControlButtons();
  }

  public destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.boundUnloadCleanup);
      window.removeEventListener('beforeunload', this.boundUnloadCleanup);
    }
    this.performImmediateSynchronousUnloadCleanup();
  }

  private bindUiEvents(): void {
    this.btnStart.addEventListener('click', () => {
      void this.handleStartTranscriptionClick();
    });

    this.btnPause.addEventListener('click', () => {
      this.handlePauseClick();
    });

    this.btnResume.addEventListener('click', () => {
      this.handleResumeClick();
    });

    this.btnStop.addEventListener('click', () => {
      void this.stopSessionAndClearAll(true);
    });

    this.btnClear.addEventListener('click', () => {
      this.clearTranscriptMemoryAndDom('Transcript cleared from active browser memory.');
    });

    this.btnPreload.addEventListener('click', () => {
      void this.handlePreloadModelClick();
    });

    this.btnRunAudioDiag.addEventListener('click', () => {
      void this.handleRunAudioDiagnosticsOnlyClick();
    });

    this.btnVerifyPrivacy.addEventListener('click', () => {
      void this.handleRunPrivacyAuditClick();
    });

    this.alertDismissBtn.addEventListener('click', () => {
      this.hideAlert();
    });

    this.selectModel.addEventListener('change', () => {
      try {
        this.selectedModelKey = validateModelKey(this.selectModel.value);
        this.updateModelTradeoffDescription();
        const spec = WHISPER_MODELS[this.selectedModelKey];
        this.headerEngineBadge.textContent = `Engine: ${spec.shortName}`;
        this.infoEngine.textContent = spec.shortName;
      } catch (err) {
        this.showAlert({
          code: 'TRANSCRIPTION_FAILED',
          severity: 'error',
          title: 'Invalid Model Configuration',
          message: err instanceof Error ? err.message : 'Invalid model selection.',
        });
      }
    });

    this.selectDevice.addEventListener('change', () => {
      try {
        this.selectedDevicePref = validateDevicePreference(this.selectDevice.value);
        const modeLabel =
          this.selectedDevicePref === 'wasm'
            ? 'WebAssembly Only (CPU)'
            : 'Auto (WebGPU / WASM)';
        if (!this.activeDevice) {
          this.headerModeBadge.textContent = `Mode: ${modeLabel}`;
          this.infoMethod.textContent = modeLabel;
        }
      } catch (err) {
        this.showAlert({
          code: 'TRANSCRIPTION_FAILED',
          severity: 'error',
          title: 'Invalid Device Preference',
          message: err instanceof Error ? err.message : 'Invalid device selection.',
        });
      }
    });

    this.selectProfile.addEventListener('change', () => {
      try {
        this.selectedProfile = validateDiagnosticProfile(this.selectProfile.value);
        this.audioCapture.setDiagnosticProfile(this.selectedProfile);
        this.diagnosticsEngine.setProfile(this.selectedProfile);
        this.renderDiagnosticsPanel();
      } catch (err) {
        this.showAlert({
          code: 'TRANSCRIPTION_FAILED',
          severity: 'error',
          title: 'Invalid Diagnostic Profile',
          message: err instanceof Error ? err.message : 'Invalid profile selection.',
        });
      }
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.boundUnloadCleanup);
      window.addEventListener('beforeunload', this.boundUnloadCleanup);
    }
  }

  private verifyAndRenderPrivacyGate(): boolean {
    const verification = verifyLocalProcessingConfiguration();
    if (verification.valid) {
      this.headerPrivacyBadge.textContent = 'PRIVACY MODE ACTIVE';
      this.headerPrivacyBadge.className = 'pill pill-verified';
      this.privacyModeIndicator.classList.remove('hidden');
      this.privacyStatement.textContent =
        'Audio is processed locally in this browser session. This application does not upload or save your conversation recordings or transcripts.';
      return true;
    }

    this.headerPrivacyBadge.textContent = 'LOCAL ENGINE UNAVAILABLE';
    this.headerPrivacyBadge.className = 'pill pill-blocked';
    this.privacyModeIndicator.classList.add('hidden');
    this.privacyStatement.textContent =
      verification.reason ??
      'Local speech recognition cannot be initialized in this browser. Customer audio capture is disabled.';
    this.showAlert({
      code: 'WASM_UNAVAILABLE',
      severity: 'error',
      title: 'Local Recognition Engine Cannot Be Initialized',
      message:
        verification.reason ??
        'Required local browser compute capabilities are unavailable. Cloud fallback is strictly prohibited.',
    });
    return false;
  }

  private checkNavigationReloadNotice(): void {
    try {
      if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
        const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        if (navEntries.length > 0 && navEntries[0].type === 'reload') {
          this.showAlert({
            code: 'TAB_REFRESHED',
            severity: 'info',
            title: 'Browser Tab Refreshed — Clean Ephemeral Session',
            message:
              'Previous session data was not saved or restored, and screen sharing remains off until you manually click START TRANSCRIPTION.',
          });
        }
      }
    } catch {
      // Ignore navigation timing inspection errors
    }
  }

  private async handlePreloadModelClick(): Promise<void> {
    if (!this.verifyAndRenderPrivacyGate()) {
      return;
    }
    this.hideAlert();
    this.btnPreload.disabled = true;
    this.selectModel.disabled = true;
    this.selectDevice.disabled = true;

    const ok = await this.whisperEngine.initializeModel(
      this.selectedModelKey,
      this.selectedDevicePref,
    );

    if (this.lifecycleState === 'idle') {
      this.selectModel.disabled = false;
      this.selectDevice.disabled = false;
    }
    this.btnPreload.disabled = ok;
    if (ok) {
      this.btnPreload.textContent = 'MODEL READY IN RAM';
    }
  }

  private async handleStartTranscriptionClick(): Promise<void> {
    if (this.lifecycleState !== 'idle') {
      return;
    }

    if (!this.verifyAndRenderPrivacyGate()) {
      return;
    }

    // Validate configuration inputs prior to session start
    this.selectedModelKey = validateModelKey(this.selectModel.value);
    this.selectedDevicePref = validateDevicePreference(this.selectDevice.value);
    this.selectedProfile = validateDiagnosticProfile(this.selectProfile.value);
    this.audioCapture.setDiagnosticProfile(this.selectedProfile);
    this.diagnosticsEngine.setProfile(this.selectedProfile);

    this.hideAlert();
    this.diagnosticsOnlyMode = false;
    this.lifecycleState = 'requesting-permission';
    this.syncControlButtons();

    const modelAlreadyReady =
      this.whisperEngine.isReady &&
      this.whisperEngine.currentModelKey === this.selectedModelKey;

    // Initiate Chrome's getDisplayMedia() directly on the user's button click gesture
    const captureStarted = await this.audioCapture.startCapture(modelAlreadyReady);
    if (!captureStarted) {
      const trackInfo = this.audioCapture.getTrackInfo();
      this.diagnosticsEngine.startSession({
        hasAudioTrack: false,
        trackLabel: trackInfo.trackLabel,
        sampleRateHz: trackInfo.sampleRateHz,
        isLive: false,
      });
      this.renderDiagnosticsPanel();
      this.lifecycleState = 'idle';
      this.syncControlButtons();
      return;
    }

    const trackInfo = this.audioCapture.getTrackInfo();
    this.diagnosticsEngine.startSession({
      hasAudioTrack: true,
      trackLabel: trackInfo.trackLabel,
      sampleRateHz: trackInfo.sampleRateHz,
      isLive: trackInfo.isLive,
    });
    this.renderDiagnosticsPanel();

    this.lifecycleState = 'active';
    this.startSessionDurationClock();
    this.transcriptEmptyTitle.textContent = 'Listening to Windows system audio...';
    this.transcriptEmptyDesc.textContent =
      'Play harmless spoken test audio or speak on an authorized call. Recognized sentences will appear here locally and vanish when you click STOP.';
    this.syncControlButtons();

    if (!modelAlreadyReady) {
      this.setProcessingStatus('Waiting for local model initialization');
      const modelLoaded = await this.whisperEngine.initializeModel(
        this.selectedModelKey,
        this.selectedDevicePref,
      );

      if (!modelLoaded) {
        // Strict Section 7G enforcement: if local recognition engine fails to initialize,
        // immediately stop capturing customer audio and clean up!
        await this.stopSessionAndClearAll(false);
        return;
      }

      if (this.lifecycleState === 'active') {
        this.audioCapture.setForwardingSpeechSamples(true);
        this.btnPreload.textContent = 'MODEL READY IN RAM';
        this.setProcessingStatus('Listening for speech');
      }
    } else {
      this.setProcessingStatus('Listening for speech');
    }
  }

  private async handleRunAudioDiagnosticsOnlyClick(): Promise<void> {
    if (this.lifecycleState !== 'idle') {
      return;
    }
    if (!this.verifyAndRenderPrivacyGate()) {
      return;
    }

    this.selectedProfile = validateDiagnosticProfile(this.selectProfile.value);
    this.audioCapture.setDiagnosticProfile(this.selectedProfile);
    this.diagnosticsEngine.setProfile(this.selectedProfile);

    this.hideAlert();
    this.diagnosticsOnlyMode = true;
    this.lifecycleState = 'requesting-permission';
    this.syncControlButtons();

    const started = await this.audioCapture.startCapture(false);
    const trackInfo = this.audioCapture.getTrackInfo();
    this.diagnosticsEngine.startSession({
      hasAudioTrack: started,
      trackLabel: trackInfo.trackLabel,
      sampleRateHz: trackInfo.sampleRateHz,
      isLive: trackInfo.isLive,
    });
    this.renderDiagnosticsPanel();

    if (!started) {
      this.diagnosticsOnlyMode = false;
      this.lifecycleState = 'idle';
      this.syncControlButtons();
      return;
    }

    this.lifecycleState = 'active';
    this.startSessionDurationClock();
    this.setProcessingStatus('Listening for speech');
    this.transcriptEmptyTitle.textContent = `Audio Compatibility Test Active (${DIAGNOSTIC_PROFILES[this.selectedProfile].label})`;
    this.transcriptEmptyDesc.textContent =
      'Playing harmless sample audio now tests Chrome system audio capture, signal strength, and 300–3400 Hz speech clarity without buffering speech. Click STOP when done.';
    this.syncControlButtons();
  }

  private handlePauseClick(): void {
    if (this.lifecycleState !== 'active') {
      return;
    }
    this.lifecycleState = 'paused';
    this.pauseBeganAtMs = Date.now();
    this.audioCapture.pause();
    this.vadSegmenter.clearAndZero();
    this.whisperEngine.setPaused(true);
    this.levelMeter.renderIdle();
    this.setProcessingStatus('Paused — incoming audio discarded');
    this.syncControlButtons();
  }

  private handleResumeClick(): void {
    if (this.lifecycleState !== 'paused') {
      return;
    }
    if (this.pauseBeganAtMs > 0) {
      this.pausedAccumulatedMs += Date.now() - this.pauseBeganAtMs;
      this.pauseBeganAtMs = 0;
    }
    this.lifecycleState = 'active';
    this.whisperEngine.setPaused(false);
    this.audioCapture.resume();
    this.setProcessingStatus('Listening for speech');
    this.syncControlButtons();
  }

  /**
   * Executes the mandatory 11-step session cleanup sequence:
   * 1. Stop screen-sharing audio capture
   * 2. Stop all associated media tracks
   * 3. Disconnect audio-processing nodes
   * 4. Close AudioContext
   * 5. Stop AudioWorklet
   * 6. Terminate transcription worker
   * 7. Discard & zero pending audio buffers
   * 8. Clear all transcript text from RAM & DOM
   * 9. Clear timestamps & session counters
   * 10. Reset interface to initial state
   * 11. Display "Session ended. Temporary session data cleared."
   */
  public async stopSessionAndClearAll(
    showSessionEndedNotice: boolean = true,
    externalAlert?: AppAlert,
  ): Promise<void> {
    this.lifecycleState = 'stopping';
    this.syncControlButtons();

    // Steps 1–5: Stop capture, media tracks, nodes, AudioContext, and AudioWorklet
    await this.audioCapture.stopAndCleanup();

    // Step 6 & 7: Terminate Web Worker and zero/discard all pending audio buffers
    this.vadSegmenter.clearAndZero();
    this.whisperEngine.shutdownAndTerminate();
    await purgeApplicationCacheStorage();

    // Step 8: Clear all transcript text
    this.clearTranscriptMemoryAndDom(
      showSessionEndedNotice ? 'Session ended. Temporary session data cleared.' : undefined,
    );

    // Step 9: Clear timestamps, session counters, and ephemeral diagnostic session data
    this.stopSessionDurationClock();
    this.infoDuration.textContent = '00:00:00';
    this.diagnosticsEngine.resetAndClear();
    this.renderDiagnosticsPanel();

    // Step 10: Reset interface to initial state
    this.diagnosticsOnlyMode = false;
    this.activeDevice = null;
    this.lifecycleState = 'idle';
    this.setConnectionStatus('Not connected');
    this.setActivityStatus('Audio inactive');
    this.setProcessingStatus('Idle');
    this.levelMeter.renderIdle();
    this.meterDbfs.textContent = '-100.0 dBFS';
    this.meterVoiceband.textContent = 'Voice Band: 0%';
    this.meterVadPill.textContent = 'Silence';
    this.meterVadPill.className = 'mini-badge';
    this.processingIndicator.classList.add('hidden');
    this.btnPreload.textContent = 'PRELOAD LOCAL MODEL';

    const modeLabel =
      this.selectedDevicePref === 'wasm'
        ? 'WebAssembly Only (CPU)'
        : 'Auto (WebGPU / WASM)';
    this.headerModeBadge.textContent = `Mode: ${modeLabel}`;
    this.infoMethod.textContent = `Standby (${modeLabel})`;

    this.syncControlButtons();

    // Step 11: Display confirmation message
    if (externalAlert) {
      this.showAlert(externalAlert);
    } else if (showSessionEndedNotice) {
      this.showAlert({
        code: 'EXTERNAL_STOP_SHARING',
        severity: 'info',
        title: 'Session Ended',
        message: 'Session ended. Temporary session data cleared.',
      });
    }
  }

  private performImmediateSynchronousUnloadCleanup(): void {
    this.stopSessionDurationClock();
    this.vadSegmenter.clearAndZero();
    this.whisperEngine.shutdownAndTerminate();
    void this.audioCapture.stopAndCleanup();
    this.clearTranscriptMemoryAndDom();
    this.diagnosticsEngine.resetAndClear();
  }

  private clearTranscriptMemoryAndDom(emptyHeadline?: string): void {
    if (this.recentHighlightTimer !== null) {
      clearTimeout(this.recentHighlightTimer);
      this.recentHighlightTimer = null;
    }

    // Explicitly clear string references in segment objects before dropping array
    for (const seg of this.segments) {
      seg.text = '';
      seg.clockTimestamp = '';
      seg.elapsedTimestamp = '';
    }
    this.segments = [];
    this.nextSegmentId = 1;
    this.whisperEngine.discardPendingBuffers(true);

    // Remove all segment cards from DOM while preserving the empty-state node
    const children = Array.from(this.transcriptFeed.children);
    for (const child of children) {
      if (child.id !== 'transcript-empty-state') {
        child.remove();
      }
    }

    this.transcriptEmptyState.classList.remove('hidden');
    this.transcriptEmptyTitle.textContent =
      emptyHeadline ?? 'No active transcription session';
    this.transcriptEmptyDesc.textContent =
      'Click START TRANSCRIPTION, choose Entire Screen with "Share system audio" enabled, and play harmless test audio first to verify setup. Transcripts exist only in active memory and are erased immediately when stopped.';

    this.syncControlButtons();
  }

  private appendRecognizedSegment(
    text: string,
    clockTimestamp: string,
    processingMs: number,
  ): void {
    // Mark all previously rendered segments as FINALIZED
    for (const prev of this.segments) {
      prev.isRecent = false;
    }
    const existingCards = this.transcriptFeed.querySelectorAll('.segment-card-recent');
    existingCards.forEach((card) => {
      card.classList.remove('segment-card-recent');
      const badge = card.querySelector('.segment-state-badge');
      if (badge) {
        badge.textContent = 'FINALIZED';
        badge.className = 'segment-state-badge state-finalized';
      }
    });

    const elapsedSec = this.getElapsedActiveSeconds();
    const segment: TranscriptSegment = {
      id: this.nextSegmentId++,
      speakerLabel: 'SYSTEM AUDIO',
      clockTimestamp,
      elapsedTimestamp: formatElapsedMmSs(elapsedSec),
      text,
      processingMs,
      isRecent: true,
    };
    this.segments.push(segment);

    this.transcriptEmptyState.classList.add('hidden');

    // Safe DOM construction using textContent ONLY (never innerHTML)
    const card = document.createElement('article');
    card.className = 'segment-card segment-card-recent';
    card.dataset.segmentId = String(segment.id);

    const metaRow = document.createElement('div');
    metaRow.className = 'segment-meta';

    const metaLeft = document.createElement('div');
    metaLeft.className = 'segment-meta-left';

    const speakerEl = document.createElement('span');
    speakerEl.className = 'speaker-tag';
    speakerEl.textContent = segment.speakerLabel;

    const timeEl = document.createElement('span');
    timeEl.className = 'segment-time';
    timeEl.textContent = `${segment.clockTimestamp} (${segment.elapsedTimestamp})`;

    metaLeft.append(speakerEl, timeEl);

    const stateBadge = document.createElement('span');
    stateBadge.className = 'segment-state-badge state-recent';
    stateBadge.textContent = 'NEWLY RECOGNIZED';

    metaRow.append(metaLeft, stateBadge);

    const textPara = document.createElement('p');
    textPara.className = 'segment-text';
    textPara.textContent = segment.text;

    card.append(metaRow, textPara);
    this.transcriptFeed.appendChild(card);

    // Keep scroll pinned smoothly to newest segment
    this.transcriptFeed.scrollTop = this.transcriptFeed.scrollHeight;

    // Transition visual highlight from NEWLY RECOGNIZED to FINALIZED after 4.5s
    if (this.recentHighlightTimer !== null) {
      clearTimeout(this.recentHighlightTimer);
    }
    this.recentHighlightTimer = setTimeout(() => {
      segment.isRecent = false;
      card.classList.remove('segment-card-recent');
      stateBadge.textContent = 'FINALIZED';
      stateBadge.className = 'segment-state-badge state-finalized';
    }, 4500);

    this.syncControlButtons();
  }

  private handleAudioLevelMetrics(metrics: AudioLevelMetrics): void {
    this.levelMeter.update(metrics);
    this.meterDbfs.textContent = `${metrics.dbfs.toFixed(1)} dBFS`;
    this.meterVoiceband.textContent = `Voice Band: ${Math.round(metrics.speechBandRatio * 100)}%`;

    if (metrics.isSpeechActive) {
      this.meterVadPill.textContent = 'Speech Active';
      this.meterVadPill.className = 'mini-badge mini-badge-active';
    } else {
      this.meterVadPill.textContent = 'Silence';
      this.meterVadPill.className = 'mini-badge';
    }

    const trackInfo = this.audioCapture.getTrackInfo();
    this.diagnosticsEngine.ingestMetrics(metrics, trackInfo.isLive);
    this.renderDiagnosticsPanel();
  }

  private renderDiagnosticsPanel(): void {
    const snap = this.diagnosticsEngine.getSnapshot();
    this.diagChecklist.replaceChildren();

    for (const item of snap.checks) {
      const li = document.createElement('li');
      li.className = 'diag-item';

      const header = document.createElement('div');
      header.className = 'diag-item-header';

      const labelSpan = document.createElement('span');
      labelSpan.textContent = item.label;

      const tagSpan = document.createElement('span');
      tagSpan.className = `diag-tag diag-${item.state}`;
      tagSpan.textContent = item.state.toUpperCase();

      header.append(labelSpan, tagSpan);

      const detailP = document.createElement('p');
      detailP.className = 'diag-item-detail';
      detailP.textContent = item.detail;

      li.append(header, detailP);
      this.diagChecklist.appendChild(li);
    }

    this.diagVerdict.textContent = snap.summaryVerdict;
  }

  private async handleRunPrivacyAuditClick(): Promise<void> {
    const report = await runLivePrivacyAudit();
    this.privacyVerifiedStamp.textContent = report.allChecksPassed
      ? `Verified ${report.verifiedAt} — All checks passed`
      : `Checked ${report.verifiedAt} — Review items below`;

    this.privacyAuditResults.classList.remove('hidden');
    this.privacyAuditList.replaceChildren();

    const rows: Array<[string, string]> = [
      ['Local recognition engine verified', report.localProcessingConfigured ? 'YES (Local ONNX)' : 'NO'],
      ['External audio / transcript bytes sent', `${report.outboundAudioOrTextBytesSent} bytes`],
      ['localStorage / sessionStorage entries', `${report.localStorageEntries} / ${report.sessionStorageEntries}`],
      ['IndexedDB / OPFS / Cookies', `${report.indexedDbDatabases} / ${report.opfsEntries} / ${report.cookieBytes} B`],
      ['Application Cache Storage buckets', `${report.cacheStorageBuckets} (disabled)`],
      ['Service Workers / MediaRecorder / Mic', `${report.serviceWorkersRegistered} / ${report.mediaRecorderCount} / ${report.microphoneRequestsCount}`],
      ['Blocked non-GET or unauthorized calls', `${report.blockedNetworkAttempts}`],
    ];

    for (const [label, val] of rows) {
      const li = document.createElement('li');
      li.className = 'audit-item';
      const k = document.createElement('span');
      k.textContent = label;
      const v = document.createElement('strong');
      v.textContent = val;
      li.append(k, v);
      this.privacyAuditList.appendChild(li);
    }

    this.networkAuditLog.replaceChildren();
    if (report.networkEntries.length === 0) {
      const li = document.createElement('li');
      li.className = 'network-log-item';
      li.textContent = '0 software-asset network requests recorded in this session so far.';
      this.networkAuditLog.appendChild(li);
    } else {
      for (const entry of report.networkEntries) {
        const li = document.createElement('li');
        li.className = 'network-log-item';
        li.textContent = `[${entry.timestamp}] ${entry.method} (${entry.category}, sent ${entry.bytesSent}B, ${entry.status}): ${entry.url}`;
        this.networkAuditLog.appendChild(li);
      }
    }
  }

  private updateModelTradeoffDescription(): void {
    const spec = WHISPER_MODELS[this.selectedModelKey];
    this.modelTradeoffNote.textContent = `${spec.parameters} · ${spec.license} · Download ~${spec.approxDownloadWasmMb} MB (WASM q8) / ~${spec.approxDownloadWebGpuMb} MB (WebGPU). ${spec.accuracySummary} ${spec.performanceSummary}`;
  }

  private setConnectionStatus(status: AudioConnectionStatus): void {
    this.connectionStatus = status;
    this.connectionStatusEl.textContent = status;
    this.infoConnection.textContent = status;

    if (status === 'System audio detected' || status === 'Screen sharing active') {
      this.connectionDot.className = 'status-dot dot-active';
    } else if (status === 'Requesting screen-sharing permission') {
      this.connectionDot.className = 'status-dot dot-pending';
    } else if (status === 'No system audio detected') {
      this.connectionDot.className = 'status-dot dot-error';
    } else {
      this.connectionDot.className = 'status-dot dot-idle';
    }
  }

  private setActivityStatus(status: AudioActivityStatus): void {
    this.activityStatus = status;
    this.activityStatusEl.textContent = status;
    this.activityDot.className =
      status === 'Audio activity detected' ? 'status-dot dot-active' : 'status-dot dot-idle';
  }

  private setProcessingStatus(status: ProcessingStatus): void {
    this.processingStatus = status;
    this.infoProcessingStatus.textContent = status;
  }

  private startSessionDurationClock(): void {
    this.stopSessionDurationClock();
    this.sessionStartedAtMs = Date.now();
    this.pausedAccumulatedMs = 0;
    this.pauseBeganAtMs = 0;
    this.infoDuration.textContent = '00:00:00';

    this.sessionTimer = setInterval(() => {
      const secs = this.getElapsedActiveSeconds();
      this.infoDuration.textContent = formatDurationHhMmSs(secs);
      if (this.lifecycleState === 'active') {
        this.renderDiagnosticsPanel();
      }
    }, 1000);
  }

  private getElapsedActiveSeconds(): number {
    if (this.sessionStartedAtMs === 0) {
      return 0;
    }
    const now = this.lifecycleState === 'paused' && this.pauseBeganAtMs > 0
      ? this.pauseBeganAtMs
      : Date.now();
    const activeMs = Math.max(0, now - this.sessionStartedAtMs - this.pausedAccumulatedMs);
    return Math.floor(activeMs / 1000);
  }

  private stopSessionDurationClock(): void {
    if (this.sessionTimer !== null) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.sessionStartedAtMs = 0;
    this.pausedAccumulatedMs = 0;
    this.pauseBeganAtMs = 0;
  }

  private syncControlButtons(): void {
    const localOk = verifyLocalProcessingConfiguration().valid;
    const isIdle = this.lifecycleState === 'idle';
    const isActive = this.lifecycleState === 'active';
    const isPaused = this.lifecycleState === 'paused';

    this.btnStart.disabled = !localOk || !isIdle;
    this.btnRunAudioDiag.disabled = !localOk || !isIdle;

    this.btnPause.disabled = !isActive;
    this.btnPause.classList.toggle('hidden', isPaused);

    this.btnResume.disabled = !isPaused;
    this.btnResume.classList.toggle('hidden', !isPaused);

    this.btnStop.disabled = isIdle || this.lifecycleState === 'stopping';
    this.btnClear.disabled = this.segments.length === 0;

    this.btnPreload.disabled = !localOk || !isIdle || this.whisperEngine.isReady;
    this.selectModel.disabled = !isIdle;
    this.selectDevice.disabled = !isIdle;
  }

  public showAlert(alert: AppAlert): void {
    this.alertRegion.className = `alert-region alert-${alert.severity}`;
    this.alertTitle.textContent = alert.title;
    this.alertMessage.textContent = alert.message;

    if (alert.remediation) {
      this.alertRemediation.textContent = alert.remediation;
      this.alertRemediation.classList.remove('hidden');
    } else {
      this.alertRemediation.textContent = '';
      this.alertRemediation.classList.add('hidden');
    }
  }

  public hideAlert(): void {
    this.alertRegion.classList.add('hidden');
    this.alertTitle.textContent = '';
    this.alertMessage.textContent = '';
    this.alertRemediation.textContent = '';
  }

  // Getters exposed for automated verification tests
  public getTestSnapshot(): {
    lifecycleState: SessionLifecycleState;
    connectionStatus: AudioConnectionStatus;
    activityStatus: AudioActivityStatus;
    modelStatus: ModelLoadingStatus;
    processingStatus: ProcessingStatus;
    segmentCount: number;
    bufferedSamples: number;
  } {
    return {
      lifecycleState: this.lifecycleState,
      connectionStatus: this.connectionStatus,
      activityStatus: this.activityStatus,
      modelStatus: this.modelStatus,
      processingStatus: this.processingStatus,
      segmentCount: this.segments.length,
      bufferedSamples: this.vadSegmenter.bufferedSamplesCount,
    };
  }
}
