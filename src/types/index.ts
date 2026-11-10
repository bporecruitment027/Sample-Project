export type ModelKey = 'base.en' | 'tiny.en';

export type ProcessingDevice = 'webgpu' | 'wasm';

export type PreferredDeviceSetting = 'auto' | 'webgpu' | 'wasm';

export type DiagnosticProfileId = 'standard' | 'nice-cxone' | 'avaya' | 'combined';

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

export interface AudioLevelMetrics {
  rms: number;
  peak: number;
  dbfs: number;
  speechBandRatio: number;
  clipping: boolean;
  isSpeechActive: boolean;
}

export interface TranscriptSegment {
  id: number;
  speakerLabel: 'SYSTEM AUDIO';
  clockTimestamp: string;
  elapsedTimestamp: string;
  text: string;
  processingMs: number;
  isRecent: boolean;
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
  checks: CompatibilityCheckItem[];
  summaryVerdict: string;
}
