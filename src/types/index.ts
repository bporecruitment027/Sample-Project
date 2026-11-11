export type ModelKey = 'small.en' | 'base.en' | 'tiny.en';

export type ProcessingDevice = 'webgpu' | 'wasm';

export type PreferredDeviceSetting = 'auto' | 'webgpu' | 'wasm';

export type DiagnosticProfileId = 'standard' | 'nice-cxone' | 'avaya' | 'combined';

export type CaptureSourceMode =
  | 'entire-screen-system'
  | 'window-app-audio'
  | 'window-system-audio';

export type ChannelSelectionMode = 'auto' | 'left' | 'right' | 'stereo-sum';

export type ChannelTopology =
  | 'mono-input'
  | 'identical-stereo'
  | 'left-dominant'
  | 'right-dominant'
  | 'dual-independent'
  | 'phase-inverted'
  | 'silent';

export type AudioEnhancementMode = 'gentle' | 'quiet-boost' | 'off';

export type DiagnosticHealthColor = 'GREEN' | 'YELLOW' | 'RED';

export type TranscriptConfidenceTier = 'confirmed' | 'uncertain';

export type AudioConnectionStatus =
  | 'Not connected'
  | 'Requesting screen-sharing permission'
  | 'Screen sharing active'
  | 'System audio detected'
  | 'No system audio detected';

export type AudioActivityStatus = 'Audio activity detected' | 'Audio inactive';

export type SessionLifecycleState =
  | 'idle'
  | 'requesting-permission'
  | 'active'
  | 'paused'
  | 'stopping';

export type ModelLoadingStatus =
  | 'Not loaded (on-demand or preload)'
  | 'Probing local compute engine...'
  | 'Downloading software model assets...'
  | 'Compiling shaders & warming up local model...'
  | 'Ready (in local RAM)'
  | 'Failed to load';

export type ProcessingStatus =
  | 'Idle'
  | 'Waiting for local model initialization'
  | 'Listening for speech'
  | 'Speech detected — buffering segment'
  | 'Recognizing speech locally...'
  | 'Paused — incoming audio discarded'
  | 'Stopped';

export type AppErrorCode =
  | 'SCREEN_CAPTURE_UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'SYSTEM_AUDIO_NOT_SELECTED'
  | 'NO_AUDIO_TRACK'
  | 'NO_AUDIO_ACTIVITY'
  | 'CAPTURE_STOPPED_UNEXPECTEDLY'
  | 'MODEL_LOAD_FAILED'
  | 'WEBGPU_UNAVAILABLE'
  | 'WASM_UNAVAILABLE'
  | 'INSUFFICIENT_RESOURCES'
  | 'TRANSCRIPTION_FAILED'
  | 'TAB_REFRESHED'
  | 'EXTERNAL_STOP_SHARING';

export interface AppAlert {
  code: AppErrorCode;
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  remediation?: string;
}

export interface WhisperModelSpec {
  key: ModelKey;
  modelId: string;
  label: string;
  shortName: string;
  parameters: string;
  license: string;
  approxDownloadWasmMb: number;
  approxDownloadWebGpuMb: number;
  accuracySummary: string;
  performanceSummary: string;
  recommendedFor: string;
}

export interface VadTuningConfig {
  maxSegmentSec: number;
  overlapSec: number;
  silenceSplitSec: number;
}

export interface AudioLevelMetrics {
  rms: number;
  peak: number;
  dbfs: number;
  peakDbfs?: number;
  leftRms?: number;
  rightRms?: number;
  leftDbfs?: number;
  rightDbfs?: number;
  channelCount?: number;
  channelTopology?: ChannelTopology;
  channelCorrelation?: number;
  sourceSampleRate?: number;
  outputSampleRate?: number;
  enhancementMode?: AudioEnhancementMode;
  enhancementGainDb?: number;
  speechBandRatio: number;
  clipping: boolean;
  isSpeechActive: boolean;
}

export interface WhisperTimestampChunk {
  timestamp: [number | null, number | null];
  text: string;
}

export interface TranscriptSegment {
  id: number;
  speakerLabel: 'SYSTEM AUDIO';
  clockTimestamp: string;
  elapsedTimestamp: string;
  text: string;
  processingMs: number;
  isRecent: boolean;
  confidenceTier: TranscriptConfidenceTier;
  qualityNote?: string;
}

export interface NetworkAuditEntry {
  timestamp: string;
  method: string;
  url: string;
  category: 'wasm-runtime' | 'model-config' | 'model-weights' | 'app-static';
  status: 'allowed-readonly' | 'blocked';
  bytesSent: 0;
}

export interface PrivacyAuditReport {
  verifiedAt: string;
  localProcessingConfigured: boolean;
  localStorageEntries: number;
  sessionStorageEntries: number;
  cookieBytes: number;
  cacheStorageBuckets: number;
  indexedDbDatabases: number;
  opfsEntries: number;
  serviceWorkersRegistered: number;
  outboundAudioOrTextBytesSent: number;
  blockedNetworkAttempts: number;
  webSocketCount: number;
  mediaRecorderCount: number;
  microphoneRequestsCount: number;
  networkEntries: NetworkAuditEntry[];
  allChecksPassed: boolean;
}

export type DiagnosticCheckState = 'pending' | 'running' | 'pass' | 'fail' | 'warn';

export interface CompatibilityCheckItem {
  id:
    | 'browser-api'
    | 'audio-track'
    | 'signal-activity'
    | 'speech-clarity'
    | 'track-stability'
    | 'hold-interruption';
  label: string;
  state: DiagnosticCheckState;
  detail: string;
}

export interface RealtimeAudioDiagnosticsView {
  healthColor: DiagnosticHealthColor;
  healthSummary: string;
  captureSourceLabel: string;
  audioTrackAvailable: string;
  trackStateLabel: string;
  sampleRateConversionLabel: string;
  channelHandlingLabel: string;
  leftLevelDbfs: string;
  rightLevelDbfs: string;
  avgRmsDbfs: string;
  peakLevelDbfs: string;
  silenceDetectionLabel: string;
  clippingDetectionLabel: string;
  audioActivityLabel: string;
  audioProcessingLabel: string;
  recognitionQueueLabel: string;
  niceCxoneIndicator: { color: DiagnosticHealthColor | 'IDLE'; text: string };
  avayaIndicator: { color: DiagnosticHealthColor | 'IDLE'; text: string };
}

export interface QualityControlSnapshot {
  overallHealth: DiagnosticHealthColor;
  statusSummary: string;
  veryQuietSegments: number;
  clippedSegments: number;
  extendedSilenceActive: boolean;
  silenceDurationSec: number;
  highDelayEvents: number;
  lastProcessingMs: number;
  recognitionFailures: number;
  suppressedRepetitions: number;
  blockedHallucinations: number;
  droppedOrMissingSegments: number;
  uncertainSegmentsCount: number;
}

export interface CompatibilityDiagnosticSnapshot {
  profile: DiagnosticProfileId;
  profileLabel: string;
  running: boolean;
  elapsedSeconds: number;
  peakRmsObserved: number;
  peakDbfsObserved: number;
  avgSpeechBandRatio: number;
  holdTransitionsObserved: number;
  trackDropoutsObserved: number;
  trackLabel: string;
  sampleRateHz: number | null;
  realtimeTelemetry: RealtimeAudioDiagnosticsView;
  checks: CompatibilityCheckItem[];
  summaryVerdict: string;
}
