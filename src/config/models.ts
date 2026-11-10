import type {
  DiagnosticProfileId,
  ModelKey,
  PreferredDeviceSetting,
  WhisperModelSpec,
} from '../types/index.ts';

export const WHISPER_MODELS: Readonly<Record<ModelKey, WhisperModelSpec>> = Object.freeze({
  'base.en': {
    key: 'base.en',
    modelId: 'onnx-community/whisper-base.en',
    label: 'Whisper Base.en — Balanced Accuracy (Default)',
    shortName: 'Whisper Base.en (Local ONNX)',
    parameters: '74M parameters',
    license: 'MIT (OpenAI Whisper weights / ONNX conversion)',
    approxDownloadWasmMb: 78,
    approxDownloadWebGpuMb: 196,
    accuracySummary:
      'Higher conversational accuracy for natural English speech, Australian English pronunciation, telephony bandwidth, and domain terms.',
    performanceSummary:
      'Near real-time with WebGPU; ~1.5–4s per speech segment on modern multi-core CPU WebAssembly.',
    recommendedFor:
      'Default choice for Windows desktops with WebGPU enabled or modern Core i5/i7 / Ryzen 5/7 CPUs.',
  },
  'tiny.en': {
    key: 'tiny.en',
    modelId: 'onnx-community/whisper-tiny.en',
    label: 'Whisper Tiny.en — Fast Performance Fallback',
    shortName: 'Whisper Tiny.en (Local ONNX)',
    parameters: '39M parameters',
    license: 'MIT (OpenAI Whisper weights / ONNX conversion)',
    approxDownloadWasmMb: 42,
    approxDownloadWebGpuMb: 108,
    accuracySummary:
      'Good intelligibility on clear conversational English; slightly higher word error rate on fast or noisy telephony audio than Base.en.',
    performanceSummary:
      '~2–2.5x faster inference and ~45% lower RAM/download footprint than Base.en — ideal for CPU/WebAssembly fallback.',
    recommendedFor:
      'Recommended when WebGPU is unavailable or when running alongside heavy NICE CXone + Avaya desktop workloads.',
  },
});

export const DEFAULT_MODEL_KEY: ModelKey = 'base.en';

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
        'If Chrome shares screen without sound, verify NICE CXone Integrated Softphone / WebRTC audio output is using the active Windows playback device rather than an isolated secondary USB endpoint.',
    },
    avaya: {
      id: 'avaya',
      label: 'Avaya Test (Diagnostic Label Only)',
      description:
        'Diagnostic label for verifying Windows output audio while Avaya Workplace / softphone audio plays through your headset. Does NOT connect to Avaya APIs.',
      routingGuidance:
        'Avaya softphones frequently bind to the Windows "Default Communications Device". Ensure your headset is also the active Windows playback output so Chrome system audio capture can hear it.',
    },
    combined: {
      id: 'combined',
      label: 'Combined Audio Test (NICE CXone + Avaya)',
      description:
        'Diagnostic label for environments running NICE CXone and Avaya concurrently. Verifies system audio capture without touching either phone application.',
      routingGuidance:
        'When both softphones are open simultaneously, confirm both route speaker output to the same headset selected in the Windows taskbar sound flyout.',
    },
  });

const VALID_MODEL_KEYS = new Set<string>(['base.en', 'tiny.en']);
const VALID_DEVICES = new Set<string>(['auto', 'webgpu', 'wasm']);
const VALID_PROFILES = new Set<string>(['standard', 'nice-cxone', 'avaya', 'combined']);

export function validateModelKey(input: unknown): ModelKey {
  if (typeof input === 'string' && VALID_MODEL_KEYS.has(input)) {
    return input as ModelKey;
  }
  throw new Error(`Invalid model selection: ${String(input)}. Allowed: base.en, tiny.en.`);
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
