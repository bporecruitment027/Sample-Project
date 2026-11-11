import {
  CAPTURE_SOURCE_MODES,
  DEFAULT_MODEL_KEY,
  DEFAULT_VAD_CONFIG,
  DIAGNOSTIC_PROFILES,
  WHISPER_MODELS,
  validateCaptureSourceMode,
  validateChannelSelectionMode,
  validateDevicePreference,
  validateDiagnosticProfile,
  validateEnhancementMode,
  validateModelKey,
  validateVadConfig,
} from '../config/models.ts';
import { CompatibilityDiagnosticsEngine } from '../audio/compatibilityDiagnostics.ts';
import { SystemAudioCaptureController } from '../audio/systemAudioCapture.ts';
import { EphemeralVadSegmenter } from '../audio/vadSegmenter.ts';
import {
  purgeApplicationCacheStorage,
  runLivePrivacyAudit,
  verifyLocalProcessingConfiguration,
} from '../privacy/storageAudit.ts';
import { TranscriptionQualityController } from '../transcription/qualityControl.ts';
import {
  LocalWhisperEngine,
  type TranscribedSegmentMetaPayload,
  type WorkerLike,
} from '../transcription/whisperEngine.ts';
import type {
  AppAlert,
  AudioActivityStatus,
  AudioConnectionStatus,
  AudioEnhancementMode,
  AudioLevelMetrics,
  CaptureSourceMode,
  ChannelSelectionMode,
  DiagnosticProfileId,
  ModelKey,
  ModelLoadingStatus,
  PreferredDeviceSetting,
  ProcessingDevice,
  ProcessingStatus,
  SessionLifecycleState,
  TranscriptConfidenceTier,
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
  private readonly qualityController: TranscriptionQualityController;
  private readonly levelMeter: EphemeralLevelMeter;

  // Ephemeral active-session state (cleared completely on STOP / unload)
  private lifecycleState: SessionLifecycleState = 'idle';
  private diagnosticsOnlyMode = false;
  private selectedModelKey: ModelKey = DEFAULT_MODEL_KEY;
  private selectedDevicePref: PreferredDeviceSetting = 'auto';
  private selectedCaptureMode: CaptureSourceMode = 'entire-screen-system';
  private selectedEnhancementMode: AudioEnhancementMode = 'gentle';
  private selectedChannelMode: ChannelSelectionMode = 'auto';
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
  private readonly chromeStepHint: HTMLElement;

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
  private readonly selectCaptureMode: HTMLSelectElement;
  private readonly selectEnhancement: HTMLSelectElement;
  private readonly selectProfile: HTMLSelectElement;
  private readonly selectChannelMode: HTMLSelectElement;
  private readonly selectSegLength: HTMLSelectElement;
  private readonly selectSegOverlap: HTMLSelectElement;
  private readonly selectSilenceSplit: HTMLSelectElement;
  private readonly modelTradeoffNote: HTMLElement;

  private readonly meterLrDbfs: HTMLElement;
  private readonly meterDbfs: HTMLElement;
  private readonly meterVoiceband: HTMLElement;
  private readonly meterVadPill: HTMLElement;

  private readonly processingIndicator: HTMLElement;
  private readonly processingIndicatorText: HTMLElement;
  private readonly transcriptFeed: HTMLElement;
  private readonly transcriptEmptyState: HTMLElement;
  private readonly transcriptEmptyTitle: HTMLElement;
  private readonly transcriptEmptyDesc: HTMLElement;

  // Real-time Audio Diagnostics Panel elements
  private readonly rtDiagHealthBadge: HTMLElement;
  private readonly rtDiagHealthSummary: HTMLElement;
  private readonly diagCxonePill: HTMLElement;
  private readonly diagAvayaPill: HTMLElement;
  private readonly rtCaptureSource: HTMLElement;
  private readonly rtTrackAvail: HTMLElement;
  private readonly rtTrackState: HTMLElement;
  private readonly rtSampleRate: HTMLElement;
  private readonly rtChannelInfo: HTMLElement;
  private readonly rtLrLevels: HTMLElement;
  private readonly rtRmsPeak: HTMLElement;
  private readonly rtSilenceClip: HTMLElement;
  private readonly rtActivity: HTMLElement;
  private readonly rtEnhancement: HTMLElement;
  private readonly rtQueue: HTMLElement;

  // Quality Control Panel elements
  private readonly qcHealthBadge: HTMLElement;
  private readonly qcSummary: HTMLElement;
  private readonly qcQuietClip: HTMLElement;
  private readonly qcUncertain: HTMLElement;
  private readonly qcSuppressed: HTMLElement;
  private readonly qcDelaysDrops: HTMLElement;

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
    this.chromeStepHint = getRequiredElement(this.root, 'chrome-step-hint');

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
    this.selectCaptureMode = getRequiredElement<HTMLSelectElement>(
      this.root,
      'select-capture-mode',
    );
    this.selectEnhancement = getRequiredElement<HTMLSelectElement>(
      this.root,
      'select-enhancement',
    );
    this.selectProfile = getRequiredElement<HTMLSelectElement>(this.root, 'select-profile');
    this.selectChannelMode = getRequiredElement<HTMLSelectElement>(
      this.root,
      'select-channel-mode',
    );
    this.selectSegLength = getRequiredElement<HTMLSelectElement>(this.root, 'select-seg-length');
    this.selectSegOverlap = getRequiredElement<HTMLSelectElement>(
      this.root,
      'select-seg-overlap',
    );
    this.selectSilenceSplit = getRequiredElement<HTMLSelectElement>(
      this.root,
      'select-silence-split',
    );
    this.modelTradeoffNote = getRequiredElement(this.root, 'model-tradeoff-note');

    this.meterLrDbfs = getRequiredElement(this.root, 'meter-lr-dbfs');
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

    this.rtDiagHealthBadge = getRequiredElement(this.root, 'rt-diag-health-badge');
    this.rtDiagHealthSummary = getRequiredElement(this.root, 'rt-diag-health-summary');
    this.diagCxonePill = getRequiredElement(this.root, 'diag-cxone-pill');
    this.diagAvayaPill = getRequiredElement(this.root, 'diag-avaya-pill');
    this.rtCaptureSource = getRequiredElement(this.root, 'rt-capture-source');
    this.rtTrackAvail = getRequiredElement(this.root, 'rt-track-avail');
    this.rtTrackState = getRequiredElement(this.root, 'rt-track-state');
    this.rtSampleRate = getRequiredElement(this.root, 'rt-sample-rate');
    this.rtChannelInfo = getRequiredElement(this.root, 'rt-channel-info');
    this.rtLrLevels = getRequiredElement(this.root, 'rt-lr-levels');
    this.rtRmsPeak = getRequiredElement(this.root, 'rt-rms-peak');
    this.rtSilenceClip = getRequiredElement(this.root, 'rt-silence-clip');
    this.rtActivity = getRequiredElement(this.root, 'rt-activity');
    this.rtEnhancement = getRequiredElement(this.root, 'rt-enhancement');
    this.rtQueue = getRequiredElement(this.root, 'rt-queue');

    this.qcHealthBadge = getRequiredElement(this.root, 'qc-health-badge');
    this.qcSummary = getRequiredElement(this.root, 'qc-summary');
    this.qcQuietClip = getRequiredElement(this.root, 'qc-quiet-clip');
    this.qcUncertain = getRequiredElement(this.root, 'qc-uncertain');
    this.qcSuppressed = getRequiredElement(this.root, 'qc-suppressed');
    this.qcDelaysDrops = getRequiredElement(this.root, 'qc-delays-drops');

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
    this.qualityController = new TranscriptionQualityController();

    this.vadSegmenter = new EphemeralVadSegmenter({
      maxSegmentSec: DEFAULT_VAD_CONFIG.maxSegmentSec,
      overlapSec: DEFAULT_VAD_CONFIG.overlapSec,
      silenceSplitSec: DEFAULT_VAD_CONFIG.silenceSplitSec,
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
          const qSnap = this.whisperEngine.queueSnapshot;
          this.diagnosticsEngine.updateQueueTelemetry(
            inFlight,
            queuedCount,
            qSnap.lastProcessingMs,
          );
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
          this.renderDiagnosticsPanel();
        },
        onSegmentTranscribed: (payload) => {
          if (this.lifecycleState !== 'active') {
            return;
          }
          this.handleRecognizedSegmentPayload(payload);
        },
        onSegmentDroppedByBackpressure: () => {
          this.qualityController.recordDroppedSegment();
          this.renderQualityControlPanel();
        },
        onRecognitionFailure: () => {
          this.qualityController.recordRecognitionFailure();
          this.renderQualityControlPanel();
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
    this.renderQualityControlPanel();
    this.bindUiEvents();

    if (typeof window !== 'undefined' && window.self !== window.top) {
      this.standaloneTabLink.href = window.location.href;
      this.standaloneTabLink.classList.remove('hidden');
    }

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

    this.selectCaptureMode.addEventListener('change', () => {
      try {
        this.selectedCaptureMode = validateCaptureSourceMode(this.selectCaptureMode.value);
        this.audioCapture.setCaptureMode(this.selectedCaptureMode);
        this.chromeStepHint.textContent =
          CAPTURE_SOURCE_MODES[this.selectedCaptureMode].chromeStepHint;
      } catch (err) {
        this.showAlert({
          code: 'TRANSCRIPTION_FAILED',
          severity: 'error',
          title: 'Invalid Capture Mode',
          message: err instanceof Error ? err.message : 'Invalid capture mode.',
        });
      }
    });

    this.selectEnhancement.addEventListener('change', () => {
      try {
        this.selectedEnhancementMode = validateEnhancementMode(this.selectEnhancement.value);
        this.audioCapture.setEnhancementMode(this.selectedEnhancementMode);
        this.renderDiagnosticsPanel();
      } catch (err) {
        this.showAlert({
          code: 'TRANSCRIPTION_FAILED',
          severity: 'error',
          title: 'Invalid Enhancement Mode',
          message: err instanceof Error ? err.message : 'Invalid enhancement mode.',
        });
      }
    });

    this.selectChannelMode.addEventListener('change', () => {
      try {
        this.selectedChannelMode = validateChannelSelectionMode(this.selectChannelMode.value);
        this.audioCapture.setChannelSelectionMode(this.selectedChannelMode);
      } catch (err) {
        this.showAlert({
          code: 'TRANSCRIPTION_FAILED',
          severity: 'error',
          title: 'Invalid Channel Mode',
          message: err instanceof Error ? err.message : 'Invalid channel selection mode.',
        });
      }
    });

    const handleVadTuningChange = () => {
      try {
        const validated = validateVadConfig({
          maxSegmentSec: Number(this.selectSegLength.value),
          overlapSec: Number(this.selectSegOverlap.value),
          silenceSplitSec: Number(this.selectSilenceSplit.value),
        });
        this.vadSegmenter.updateTuning(validated);
      } catch (err) {
        this.showAlert({
          code: 'TRANSCRIPTION_FAILED',
          severity: 'error',
          title: 'Invalid Segmentation Parameter',
          message: err instanceof Error ? err.message : 'Invalid segmentation parameter.',
        });
      }
    };

    this.selectSegLength.addEventListener('change', handleVadTuningChange);
    this.selectSegOverlap.addEventListener('change', handleVadTuningChange);
    this.selectSilenceSplit.addEventListener('change', handleVadTuningChange);

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
      if (
        typeof performance !== 'undefined' &&
        typeof performance.getEntriesByType === 'function'
      ) {
        const navEntries = performance.getEntriesByType(
          'navigation',
        ) as PerformanceNavigationTiming[];
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

    this.selectedModelKey = validateModelKey(this.selectModel.value);
    this.selectedDevicePref = validateDevicePreference(this.selectDevice.value);
    this.selectedCaptureMode = validateCaptureSourceMode(this.selectCaptureMode.value);
    this.selectedEnhancementMode = validateEnhancementMode(this.selectEnhancement.value);
    this.selectedChannelMode = validateChannelSelectionMode(this.selectChannelMode.value);
    this.selectedProfile = validateDiagnosticProfile(this.selectProfile.value);

    const validatedVad = validateVadConfig({
      maxSegmentSec: Number(this.selectSegLength.value),
      overlapSec: Number(this.selectSegOverlap.value),
      silenceSplitSec: Number(this.selectSilenceSplit.value),
    });
    this.vadSegmenter.updateTuning(validatedVad);

    this.audioCapture.setCaptureMode(this.selectedCaptureMode);
    this.audioCapture.setEnhancementMode(this.selectedEnhancementMode);
    this.audioCapture.setChannelSelectionMode(this.selectedChannelMode);
    this.audioCapture.setDiagnosticProfile(this.selectedProfile);
    this.diagnosticsEngine.setProfile(this.selectedProfile);

    this.hideAlert();
    this.diagnosticsOnlyMode = false;
    this.lifecycleState = 'requesting-permission';
    this.syncControlButtons();

    const modelAlreadyReady =
      this.whisperEngine.isReady &&
      this.whisperEngine.currentModelKey === this.selectedModelKey;

    const captureStarted = await this.audioCapture.startCapture(modelAlreadyReady);
    const trackInfo = this.audioCapture.getTrackInfo();

    if (!captureStarted) {
      this.diagnosticsEngine.startSession({
        hasAudioTrack: false,
        trackLabel: trackInfo.trackLabel,
        sampleRateHz: trackInfo.sampleRateHz,
        isLive: false,
        captureMode: trackInfo.captureMode,
        displaySurface: trackInfo.displaySurface,
        channelCount: trackInfo.channelCount,
        trackReadyState: trackInfo.trackReadyState,
        trackMuted: trackInfo.trackMuted,
      });
      this.renderDiagnosticsPanel();
      this.lifecycleState = 'idle';
      this.syncControlButtons();
      return;
    }

    this.diagnosticsEngine.startSession({
      hasAudioTrack: true,
      trackLabel: trackInfo.trackLabel,
      sampleRateHz: trackInfo.sampleRateHz,
      isLive: trackInfo.isLive,
      captureMode: trackInfo.captureMode,
      displaySurface: trackInfo.displaySurface,
      channelCount: trackInfo.channelCount,
      trackReadyState: trackInfo.trackReadyState,
      trackMuted: trackInfo.trackMuted,
    });
    this.qualityController.startSession();
    this.renderDiagnosticsPanel();
    this.renderQualityControlPanel();

    this.lifecycleState = 'active';
    this.startSessionDurationClock();
    this.transcriptEmptyTitle.textContent = 'Listening to Windows system audio...';
    this.transcriptEmptyDesc.textContent =
      'Play harmless spoken test audio or speak on an authorized call. Recognized sentences appear locally and are erased when you click STOP.';
    this.syncControlButtons();

    if (!modelAlreadyReady) {
      this.setProcessingStatus('Waiting for local model initialization');
      const modelLoaded = await this.whisperEngine.initializeModel(
        this.selectedModelKey,
        this.selectedDevicePref,
      );

      if (!modelLoaded) {
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

    this.selectedCaptureMode = validateCaptureSourceMode(this.selectCaptureMode.value);
    this.selectedEnhancementMode = validateEnhancementMode(this.selectEnhancement.value);
    this.selectedChannelMode = validateChannelSelectionMode(this.selectChannelMode.value);
    this.selectedProfile = validateDiagnosticProfile(this.selectProfile.value);

    this.audioCapture.setCaptureMode(this.selectedCaptureMode);
    this.audioCapture.setEnhancementMode(this.selectedEnhancementMode);
    this.audioCapture.setChannelSelectionMode(this.selectedChannelMode);
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
      captureMode: trackInfo.captureMode,
      displaySurface: trackInfo.displaySurface,
      channelCount: trackInfo.channelCount,
      trackReadyState: trackInfo.trackReadyState,
      trackMuted: trackInfo.trackMuted,
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
      'Play harmless sample audio to inspect Left/Right dBFS levels, sample-rate conversion, and 300–3400 Hz speech clarity without buffering speech. Click STOP when done.';
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

  public async stopSessionAndClearAll(
    showSessionEndedNotice: boolean = true,
    externalAlert?: AppAlert,
  ): Promise<void> {
    this.lifecycleState = 'stopping';
    this.syncControlButtons();

    await this.audioCapture.stopAndCleanup();

    this.vadSegmenter.clearAndZero();
    this.whisperEngine.shutdownAndTerminate();
    await purgeApplicationCacheStorage();

    this.clearTranscriptMemoryAndDom(
      showSessionEndedNotice ? 'Session ended. Temporary session data cleared.' : undefined,
    );

    this.stopSessionDurationClock();
    this.infoDuration.textContent = '00:00:00';
    this.diagnosticsEngine.resetAndClear();
    this.qualityController.resetAndClear();
    this.renderDiagnosticsPanel();
    this.renderQualityControlPanel();

    this.diagnosticsOnlyMode = false;
    this.activeDevice = null;
    this.lifecycleState = 'idle';
    this.setConnectionStatus('Not connected');
    this.setActivityStatus('Audio inactive');
    this.setProcessingStatus('Idle');
    this.levelMeter.renderIdle();
    this.meterLrDbfs.textContent = 'L: -100.0 / R: -100.0 dBFS';
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
    this.qualityController.resetAndClear();
  }

  private clearTranscriptMemoryAndDom(emptyHeadline?: string): void {
    if (this.recentHighlightTimer !== null) {
      clearTimeout(this.recentHighlightTimer);
      this.recentHighlightTimer = null;
    }

    for (const seg of this.segments) {
      seg.text = '';
      seg.clockTimestamp = '';
      seg.elapsedTimestamp = '';
      seg.qualityNote = undefined;
    }
    this.segments = [];
    this.nextSegmentId = 1;
    this.whisperEngine.discardPendingBuffers(true);

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
      'Click START TRANSCRIPTION, choose Entire Screen with "Also share system audio" enabled, and play harmless test audio first to verify setup. Transcripts exist only in active memory and are erased immediately when stopped.';

    this.syncControlButtons();
  }

  private handleRecognizedSegmentPayload(payload: TranscribedSegmentMetaPayload): void {
    const qcEval = this.qualityController.evaluateTranscribedSegment({
      text: payload.text,
      durationSec: payload.durationSec,
      rms: payload.rms,
      peak: payload.peak,
      speechBandRatio: payload.speechBandRatio,
      clippedRatio: payload.clippedRatio,
      processingMs: payload.processingMs,
      wasHallucinationBlocked: payload.wasHallucinationBlocked,
      wasRepetitionSuppressed: payload.wasRepetitionSuppressed,
    });

    this.renderQualityControlPanel();

    if (!qcEval.shouldEmit || !payload.text.trim()) {
      return;
    }

    this.appendRecognizedSegment(
      payload.text,
      payload.clockTimestamp,
      payload.processingMs,
      qcEval.confidenceTier,
      qcEval.qualityNote,
    );
  }

  private appendRecognizedSegment(
    text: string,
    clockTimestamp: string,
    processingMs: number,
    confidenceTier: TranscriptConfidenceTier = 'confirmed',
    qualityNote?: string,
  ): void {
    for (const prev of this.segments) {
      prev.isRecent = false;
    }
    const existingCards = this.transcriptFeed.querySelectorAll('.segment-card-recent');
    existingCards.forEach((card) => {
      card.classList.remove('segment-card-recent');
      const badge = card.querySelector('.segment-state-badge');
      if (badge && !badge.classList.contains('state-uncertain')) {
        badge.textContent = 'CONFIRMED';
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
      confidenceTier,
      qualityNote,
    };
    this.segments.push(segment);

    this.transcriptEmptyState.classList.add('hidden');

    // Safe DOM construction using textContent ONLY (never innerHTML)
    const card = document.createElement('article');
    card.className =
      confidenceTier === 'uncertain'
        ? 'segment-card segment-card-recent segment-card-uncertain'
        : 'segment-card segment-card-recent';
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
    if (confidenceTier === 'uncertain') {
      stateBadge.className = 'segment-state-badge state-uncertain';
      stateBadge.textContent = 'UNCERTAIN — VERIFY';
    } else {
      stateBadge.className = 'segment-state-badge state-recent';
      stateBadge.textContent = 'NEWLY RECOGNIZED';
    }

    metaRow.append(metaLeft, stateBadge);

    const textPara = document.createElement('p');
    textPara.className = 'segment-text';
    textPara.textContent = segment.text;

    card.append(metaRow, textPara);

    if (qualityNote) {
      const noteEl = document.createElement('p');
      noteEl.className = 'segment-quality-note';
      noteEl.textContent = qualityNote;
      card.appendChild(noteEl);
    }

    this.transcriptFeed.appendChild(card);
    this.transcriptFeed.scrollTop = this.transcriptFeed.scrollHeight;

    if (this.recentHighlightTimer !== null) {
      clearTimeout(this.recentHighlightTimer);
    }
    this.recentHighlightTimer = setTimeout(() => {
      segment.isRecent = false;
      card.classList.remove('segment-card-recent');
      if (confidenceTier === 'confirmed') {
        stateBadge.textContent = 'CONFIRMED';
        stateBadge.className = 'segment-state-badge state-finalized';
      }
    }, 4500);

    this.syncControlButtons();
  }

  private handleAudioLevelMetrics(metrics: AudioLevelMetrics): void {
    this.levelMeter.update(metrics);
    const lDb = (metrics.leftDbfs ?? metrics.dbfs).toFixed(1);
    const rDb = (metrics.rightDbfs ?? metrics.dbfs).toFixed(1);
    this.meterLrDbfs.textContent = `L: ${lDb} / R: ${rDb} dBFS`;
    this.meterDbfs.textContent = `${metrics.dbfs.toFixed(1)} dBFS`;
    this.meterVoiceband.textContent = `Voice Band: ${Math.round(metrics.speechBandRatio * 100)}%`;

    if (metrics.isSpeechActive) {
      this.meterVadPill.textContent = 'Speech Active';
      this.meterVadPill.className = 'mini-badge mini-badge-active';
    } else {
      this.meterVadPill.textContent = 'Silence';
      this.meterVadPill.className = 'mini-badge';
    }

    this.qualityController.notifyLiveAudioFrame(metrics.rms);
    const trackInfo = this.audioCapture.getTrackInfo();
    this.diagnosticsEngine.ingestMetrics(metrics, trackInfo.isLive, {
      readyState: trackInfo.trackReadyState,
      muted: trackInfo.trackMuted,
      displaySurface: trackInfo.displaySurface,
    });
    this.renderDiagnosticsPanel();
    this.renderQualityControlPanel();
  }

  private renderDiagnosticsPanel(): void {
    const snap = this.diagnosticsEngine.getSnapshot();
    const rt = snap.realtimeTelemetry;

    // Update Real-Time Audio Diagnostics Card (Section 4)
    this.rtDiagHealthBadge.textContent = `${rt.healthColor} · ${rt.healthColor === 'GREEN' ? 'HEALTHY' : rt.healthColor === 'RED' ? 'ISSUE' : 'CHECK'}`;
    this.rtDiagHealthBadge.className = `health-pill health-${rt.healthColor.toLowerCase()}`;
    this.rtDiagHealthSummary.textContent = rt.healthSummary;

    this.diagCxonePill.textContent = `${rt.niceCxoneIndicator.color} · ${rt.niceCxoneIndicator.text}`;
    this.diagCxonePill.className = `softphone-pill sp-${rt.niceCxoneIndicator.color.toLowerCase()}`;

    this.diagAvayaPill.textContent = `${rt.avayaIndicator.color} · ${rt.avayaIndicator.text}`;
    this.diagAvayaPill.className = `softphone-pill sp-${rt.avayaIndicator.color.toLowerCase()}`;

    this.rtCaptureSource.textContent = rt.captureSourceLabel;
    this.rtTrackAvail.textContent = rt.audioTrackAvailable;
    this.rtTrackState.textContent = rt.trackStateLabel;
    this.rtSampleRate.textContent = rt.sampleRateConversionLabel;
    this.rtChannelInfo.textContent = rt.channelHandlingLabel;
    this.rtLrLevels.textContent = `${rt.leftLevelDbfs} / ${rt.rightLevelDbfs}`;
    this.rtRmsPeak.textContent = `${rt.avgRmsDbfs} / ${rt.peakLevelDbfs}`;
    this.rtSilenceClip.textContent = `${rt.silenceDetectionLabel} · ${rt.clippingDetectionLabel}`;
    this.rtActivity.textContent = rt.audioActivityLabel;
    this.rtEnhancement.textContent = rt.audioProcessingLabel;
    this.rtQueue.textContent = rt.recognitionQueueLabel;

    // Update 6-step Softphone Compatibility Checklist
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

  private renderQualityControlPanel(): void {
    const qc = this.qualityController.getSnapshot();
    const stateWord =
      qc.overallHealth === 'GREEN'
        ? 'HEALTHY'
        : qc.overallHealth === 'YELLOW'
          ? 'ATTENTION'
          : 'DEGRADED';

    this.qcHealthBadge.textContent = `${qc.overallHealth} · ${stateWord}`;
    this.qcHealthBadge.className = `health-pill health-${qc.overallHealth.toLowerCase()}`;
    this.qcSummary.textContent = qc.statusSummary;
    this.qcQuietClip.textContent = `${qc.veryQuietSegments} quiet · ${qc.clippedSegments} clipped`;
    this.qcUncertain.textContent = `${qc.uncertainSegmentsCount} flagged`;
    this.qcSuppressed.textContent = `${qc.blockedHallucinations} blocked · ${qc.suppressedRepetitions} loops`;
    this.qcDelaysDrops.textContent = `${qc.highDelayEvents} slow · ${qc.droppedOrMissingSegments} dropped · ${qc.recognitionFailures} err`;
  }

  private async handleRunPrivacyAuditClick(): Promise<void> {
    const report = await runLivePrivacyAudit();
    this.privacyVerifiedStamp.textContent = report.allChecksPassed
      ? `Verified ${report.verifiedAt} — All checks passed`
      : `Checked ${report.verifiedAt} — Review items below`;

    this.privacyAuditResults.classList.remove('hidden');
    this.privacyAuditList.replaceChildren();

    const rows: Array<[string, string]> = [
      [
        'Local recognition engine verified',
        report.localProcessingConfigured ? 'YES (Local ONNX)' : 'NO',
      ],
      ['External audio / transcript bytes sent', `${report.outboundAudioOrTextBytesSent} bytes`],
      [
        'localStorage / sessionStorage entries',
        `${report.localStorageEntries} / ${report.sessionStorageEntries}`,
      ],
      [
        'IndexedDB / OPFS / Cookies',
        `${report.indexedDbDatabases} / ${report.opfsEntries} / ${report.cookieBytes} B`,
      ],
      ['Application Cache Storage buckets', `${report.cacheStorageBuckets} (disabled)`],
      [
        'Service Workers / MediaRecorder / Mic',
        `${report.serviceWorkersRegistered} / ${report.mediaRecorderCount} / ${report.microphoneRequestsCount}`,
      ],
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
    this.modelTradeoffNote.textContent = `${spec.parameters} · ${spec.license} · Download ~${spec.approxDownloadWasmMb} MB (WASM q8) / ~${spec.approxDownloadWebGpuMb} MB (WebGPU fp32+q8). ${spec.accuracySummary} ${spec.performanceSummary}`;
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
        this.renderQualityControlPanel();
      }
    }, 1000);
  }

  private getElapsedActiveSeconds(): number {
    if (this.sessionStartedAtMs === 0) {
      return 0;
    }
    const now =
      this.lifecycleState === 'paused' && this.pauseBeganAtMs > 0
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
    this.selectCaptureMode.disabled = !isIdle;
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
