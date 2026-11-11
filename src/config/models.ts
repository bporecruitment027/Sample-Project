import type {
  AudioEnhancementMode,
  CaptureSourceMode,
  ChannelSelectionMode,
  DiagnosticProfileId,
  ModelKey,
  PreferredDeviceSetting,
  VadTuningConfig,
  WhisperModelSpec,
} from '../types/index.ts';

export const WHISPER_MODELS: Readonly<Record<ModelKey, WhisperModelSpec>> = Object.freeze({
  'small.en': {
    key: 'small.en',
    modelId: 'Xenova/whisper-small.en',
    label: 'Whisper Small.en — High Accuracy Telephony & Automotive (Preferred)',
    shortName: 'Whisper Small.en (Local ONNX)',
    parameters: '244M parameters',
    license: 'MIT (OpenAI Whisper weights / Xenova ONNX conversion)',
    approxDownloadWasmMb: 248,
    approxDownloadWebGpuMb: 412,
    accuracySummary:
      'Highest local English accuracy for Australian & international accents, narrowband telephone speech, customer names, vehicle makes/models, rego numbers, and dealership booking details.',
    performanceSummary:
      'Real-time with WebGPU; ~3.5–8s per speech segment on modern multi-core CPU WebAssembly (q8).',
    recommendedFor:
      'Preferred choice for accuracy testing and automotive customer service conversations (switch to Base.en if CPU lags).',
  },
  'base.en': {
    key: 'base.en',
    modelId: 'Xenova/whisper-base.en',
    label: 'Whisper Base.en — Balanced Speed & Accuracy Alternative',
    shortName: 'Whisper Base.en (Local ONNX)',
    parameters: '74M parameters',
    license: 'MIT (OpenAI Whisper weights / Xenova ONNX conversion)',
    approxDownloadWasmMb: 78,
    approxDownloadWebGpuMb: 145,
    accuracySummary:
      'Solid conversational accuracy on English telephony speech when Small.en is too demanding for the computer.',
    performanceSummary:
      '~2.8x faster than Small.en on CPU WebAssembly with ~68% lower RAM footprint.',
    recommendedFor:
      'Recommended alternative when WebGPU is unavailable and Small.en exceeds CPU capacity alongside NICE CXone + Avaya.',
  },
  'tiny.en': {
    key: 'tiny.en',
    modelId: 'Xenova/whisper-tiny.en',
    label: 'Whisper Tiny.en — Emergency Low-Resource Fallback Only',
    shortName: 'Whisper Tiny.en (Local ONNX)',
    parameters: '39M parameters',
    license: 'MIT (OpenAI Whisper weights / Xenova ONNX conversion)',
    approxDownloadWasmMb: 42,
    approxDownloadWebGpuMb: 85,
    accuracySummary:
      'Basic intelligibility only; higher error rate on telephone speech, names, and alphanumeric regos.',
    performanceSummary:
      'Fastest CPU inference (~5.5x faster than Small.en) for constrained hardware where neither Small.en nor Base.en can run.',
    recommendedFor:
      'Use only if both Small.en and Base.en cannot keep up on an older CPU.',
  },
});

export const DEFAULT_MODEL_KEY: ModelKey = 'small.en';

export const DEFAULT_VAD_CONFIG: Readonly<VadTuningConfig> = Object.freeze({
  maxSegmentSec: 20,
  overlapSec: 3,
  silenceSplitSec: 1.2,
});

export interface CaptureSourceModeMeta {
  id: CaptureSourceMode;
  label: string;
  chromeStepHint: string;
}

export const CAPTURE_SOURCE_MODES: Readonly<Record<CaptureSourceMode, CaptureSourceModeMeta>> =
  Object.freeze({
    'entire-screen-system': {
      id: 'entire-screen-system',
      label: 'A. Entire Screen + System Audio (Recommended on Windows)',
      chromeStepHint:
        'Select "Entire Screen" → pick your monitor → turn ON "Also share system audio" → Share',
    },
    'window-app-audio': {
      id: 'window-app-audio',
      label: 'B. Application Window + Application Audio (Win 11 / Chrome Support Required)',
      chromeStepHint:
        'Select "Window" → pick NICE CXone or Avaya window → enable Window/Application Audio if shown by Chrome',
    },
    'window-system-audio': {
      id: 'window-system-audio',
      label: 'C. Application Window + System Audio (Where Supported)',
      chromeStepHint:
        'Select "Window" → enable "Share system audio" if offered (falls back to explicit alert if OS omits audio track)',
    },
  });

export interface DiagnosticProfileMeta {
  id: DiagnosticProfileId;
  label: string;
  description: string;
  routingGuidance: string;
}

export const DIAGNOSTIC_PROFILES: Readonly<Record<DiagnosticProfileId, DiagnosticProfileMeta>> =
  Object.freeze({
    standard: {
      id: 'standard',
      label: 'Standard System Audio',
      description:
        'General Windows desktop output verification using harmless test audio before live calls.',
      routingGuidance:
        'Ensure your active Windows output device matches the headset or speaker receiving audio.',
    },
    'nice-cxone': {
      id: 'nice-cxone',
      label: 'NICE CXone Test (Diagnostic Label Only)',
      description:
        'Diagnostic label for verifying Windows output audio while NICE CXone softphone/agent audio plays through your headset. Does NOT connect to NICE CXone APIs.',
      routingGuidance:
        'If Chrome shares screen without sound, verify NICE CXone Integrated Softphone / WebRTC audio output uses the active Windows playback device rather than an isolated secondary USB endpoint.',
    },
    avaya: {
      id: 'avaya',
      label: 'Avaya Test (Diagnostic Label Only)',
      description:
        'Diagnostic label for verifying Windows output audio while Avaya Workplace / softphone audio plays through your headset. Does NOT connect to Avaya APIs.',
      routingGuidance:
        'Ensure Avaya\'s "Mute background sound" / Windows Communications ducking setting is turned OFF, and verify your headset is set as both Default Device and Default Communications Device.',
    },
    combined: {
      id: 'combined',
      label: 'Combined Audio Test (NICE CXone + Avaya)',
      description:
        'Diagnostic label for environments running NICE CXone and Avaya concurrently. Verifies system audio capture without touching either phone application.',
      routingGuidance:
        'When both softphones are open simultaneously, confirm both route speaker output to the same headset selected in the Windows taskbar sound flyout and background muting is disabled.',
    },
  });

const VALID_MODEL_KEYS = new Set<string>(['small.en', 'base.en', 'tiny.en']);
const VALID_DEVICES = new Set<string>(['auto', 'webgpu', 'wasm']);
const VALID_PROFILES = new Set<string>(['standard', 'nice-cxone', 'avaya', 'combined']);
const VALID_CAPTURE_MODES = new Set<string>([
  'entire-screen-system',
  'window-app-audio',
  'window-system-audio',
]);
const VALID_CHANNEL_MODES = new Set<string>(['auto', 'left', 'right', 'stereo-sum']);
const VALID_ENHANCEMENT_MODES = new Set<string>(['gentle', 'quiet-boost', 'off']);

export function validateModelKey(input: unknown): ModelKey {
  if (typeof input === 'string' && VALID_MODEL_KEYS.has(input)) {
    return input as ModelKey;
  }
  throw new Error(`Invalid model selection: ${String(input)}. Allowed: small.en, base.en, tiny.en.`);
}

export function validateDevicePreference(input: unknown): PreferredDeviceSetting {
  if (typeof input === 'string' && VALID_DEVICES.has(input)) {
    return input as PreferredDeviceSetting;
  }
  throw new Error(`Invalid processing device preference: ${String(input)}. Allowed: auto, webgpu, wasm.`);
}

export function validateDiagnosticProfile(input: unknown): DiagnosticProfileId {
  if (typeof input === 'string' && VALID_PROFILES.has(input)) {
    return input as DiagnosticProfileId;
  }
  throw new Error(
    `Invalid diagnostic profile: ${String(input)}. Allowed: standard, nice-cxone, avaya, combined.`,
  );
}

export function validateCaptureSourceMode(input: unknown): CaptureSourceMode {
  if (typeof input === 'string' && VALID_CAPTURE_MODES.has(input)) {
    return input as CaptureSourceMode;
  }
  throw new Error(
    `Invalid capture source mode: ${String(input)}. Allowed: entire-screen-system, window-app-audio, window-system-audio.`,
  );
}

export function validateChannelSelectionMode(input: unknown): ChannelSelectionMode {
  if (typeof input === 'string' && VALID_CHANNEL_MODES.has(input)) {
    return input as ChannelSelectionMode;
  }
  throw new Error(
    `Invalid channel mode: ${String(input)}. Allowed: auto, left, right, stereo-sum.`,
  );
}

export function validateEnhancementMode(input: unknown): AudioEnhancementMode {
  if (typeof input === 'string' && VALID_ENHANCEMENT_MODES.has(input)) {
    return input as AudioEnhancementMode;
  }
  throw new Error(
    `Invalid audio enhancement mode: ${String(input)}. Allowed: gentle, quiet-boost, off.`,
  );
}

export function validateVadConfig(partial: Partial<VadTuningConfig>): VadTuningConfig {
  const maxSegmentSec = Number(partial.maxSegmentSec ?? DEFAULT_VAD_CONFIG.maxSegmentSec);
  const overlapSec = Number(partial.overlapSec ?? DEFAULT_VAD_CONFIG.overlapSec);
  const silenceSplitSec = Number(partial.silenceSplitSec ?? DEFAULT_VAD_CONFIG.silenceSplitSec);

  if (!Number.isFinite(maxSegmentSec) || maxSegmentSec < 8 || maxSegmentSec > 29) {
    throw new Error('Segment length must be between 8 and 29 seconds (Whisper 30s encoder window).');
  }
  if (!Number.isFinite(overlapSec) || overlapSec < 0.5 || overlapSec >= maxSegmentSec * 0.5) {
    throw new Error('Segment overlap must be between 0.5s and half the segment length.');
  }
  if (!Number.isFinite(silenceSplitSec) || silenceSplitSec < 0.4 || silenceSplitSec > 3.0) {
    throw new Error('Silence threshold must be between 0.4 and 3.0 seconds.');
  }

  return { maxSegmentSec, overlapSec, silenceSplitSec };
}
