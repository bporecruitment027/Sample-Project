import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers';
import { createGuardedFetch } from '../privacy/networkGuard.ts';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from '../transcription/workerProtocol.ts';
import type {
  ModelKey,
  PreferredDeviceSetting,
  ProcessingDevice,
} from '../types/index.ts';

declare const self: DedicatedWorkerGlobalScope;

// Strict privacy configuration: disable application-managed persistent Cache Storage / FS Cache
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = false;
env.useWasmCache = false;
env.useFSCache = false;
env.useCustomCache = false;
env.experimental_useCrossOriginStorage = false;

let activeTranscriber: AutomaticSpeechRecognitionPipeline | null = null;
let loadedModelId = '';
let loadedModelKey: ModelKey | null = null;
let loadedDevice: ProcessingDevice | null = null;
let fetchGuardInstalled = false;

function post(msg: WorkerToMainMessage): void {
  self.postMessage(msg);
}

function installWorkerNetworkGuard(appOrigin: string): void {
  if (fetchGuardInstalled) {
    return;
  }
  const baseFetch = self.fetch.bind(self);
  const guarded = createGuardedFetch(baseFetch, appOrigin, (entry) => {
    post({ type: 'network-audit', entry });
  });
  self.fetch = guarded;
  env.fetch = guarded;
  fetchGuardInstalled = true;
}

async function probeWebGpuInWorker(): Promise<{ supported: boolean; reason?: string }> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return {
      supported: false,
      reason: 'WebGPU API (navigator.gpu) is not exposed in this browser/GPU configuration.',
    };
  }
  try {
    const gpu = (navigator as Navigator & { gpu: { requestAdapter: () => Promise<unknown> } }).gpu;
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return {
        supported: false,
        reason: 'Chrome reported no compatible hardware WebGPU adapter on this Windows system.',
      };
    }
    return { supported: true };
  } catch (err) {
    return {
      supported: false,
      reason: err instanceof Error ? err.message : 'WebGPU adapter probe failed.',
    };
  }
}

async function createWhisperPipeline(
  modelId: string,
  device: ProcessingDevice,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const dtype =
    device === 'webgpu'
      ? ({
          encoder_model: 'fp32',
          decoder_model_merged: 'q4',
        } as const)
      : ('q8' as const);

  const transcriber = await pipeline('automatic-speech-recognition', modelId, {
    device,
    dtype,
    progress_callback: (info: {
      status?: string;
      file?: string;
      progress?: number;
      loaded?: number;
      total?: number;
    }) => {
      if (info.status === 'progress' && typeof info.progress === 'number') {
        post({
          type: 'progress',
          file: info.file ?? 'model-asset',
          progress: info.progress,
          loaded: info.loaded,
          total: info.total,
        });
      }
    },
  });

  if (device === 'webgpu') {
    post({
      type: 'status',
      phase: 'warming-up',
      detail: 'Compiling WebGPU shaders and warming up local Whisper encoder/decoder...',
    });
    const dummy = new Float32Array(16_000);
    try {
      await transcriber(dummy, { max_new_tokens: 1, return_timestamps: false });
    } finally {
      dummy.fill(0);
    }
  }

  return transcriber;
}

async function handleLoad(
  modelKey: ModelKey,
  modelId: string,
  preferredDevice: PreferredDeviceSetting,
  wasmBaseUrl: string,
  appOrigin: string,
): Promise<void> {
  installWorkerNetworkGuard(appOrigin);

  if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
    post({
      type: 'error',
      code: 'WASM_UNAVAILABLE',
      message:
        'WebAssembly is unavailable in this browser. Local speech recognition cannot run without WebAssembly, and cloud fallback is strictly prohibited.',
    });
    return;
  }

  // Configure local same-origin ONNX Runtime Web WASM binaries
  const onnxWasm = env.backends?.onnx?.wasm;
  if (onnxWasm) {
    onnxWasm.wasmPaths = {
      mjs: `${wasmBaseUrl}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${wasmBaseUrl}ort-wasm-simd-threaded.asyncify.wasm`,
    };
    onnxWasm.proxy = false;
  }

  if (
    activeTranscriber &&
    loadedModelId === modelId &&
    loadedDevice &&
    (preferredDevice === 'auto' || preferredDevice === loadedDevice)
  ) {
    post({
      type: 'ready',
      modelKey,
      modelId,
      activeDevice: loadedDevice,
    });
    return;
  }

  if (activeTranscriber) {
    try {
      await activeTranscriber.dispose();
    } catch {
      // Ignore disposal errors when switching models
    }
    activeTranscriber = null;
  }

  post({
    type: 'status',
    phase: 'probing',
    detail: 'Checking local WebGPU / WebAssembly acceleration capabilities...',
  });

  let targetDevice: ProcessingDevice = 'wasm';

  if (preferredDevice === 'webgpu' || preferredDevice === 'auto') {
    const gpuProbe = await probeWebGpuInWorker();
    if (gpuProbe.supported) {
      targetDevice = 'webgpu';
    } else {
      post({
        type: 'webgpu-fallback',
        reason:
          gpuProbe.reason ??
          'WebGPU unavailable — using CPU WebAssembly (SIMD) local processing.',
      });
      if (preferredDevice === 'webgpu') {
        targetDevice = 'wasm';
      }
    }
  }

  post({
    type: 'status',
    phase: 'downloading',
    detail: `Loading ${modelId} (${targetDevice === 'webgpu' ? 'WebGPU' : 'WebAssembly q8'})...`,
  });

  try {
    activeTranscriber = await createWhisperPipeline(modelId, targetDevice);
    loadedModelId = modelId;
    loadedModelKey = modelKey;
    loadedDevice = targetDevice;
    post({
      type: 'ready',
      modelKey,
      modelId,
      activeDevice: targetDevice,
    });
  } catch (primaryErr) {
    if (targetDevice === 'webgpu') {
      // Resilient fallback from WebGPU to CPU/WebAssembly if GPU shader/buffer creation fails
      const gpuErrMsg =
        primaryErr instanceof Error ? primaryErr.message : 'WebGPU session initialization failed';
      post({
        type: 'webgpu-fallback',
        reason: `WebGPU initialization failed (${gpuErrMsg}). Automatically falling back to local CPU WebAssembly.`,
      });

      try {
        post({
          type: 'status',
          phase: 'downloading',
          detail: `Loading ${modelId} via CPU WebAssembly fallback...`,
        });
        activeTranscriber = await createWhisperPipeline(modelId, 'wasm');
        loadedModelId = modelId;
        loadedModelKey = modelKey;
        loadedDevice = 'wasm';
        post({
          type: 'ready',
          modelKey,
          modelId,
          activeDevice: 'wasm',
        });
        return;
      } catch (wasmErr) {
        const msg =
          wasmErr instanceof Error ? wasmErr.message : 'Failed to load local Whisper model.';
        const isOom = /memory|allocation|oom/i.test(msg);
        post({
          type: 'error',
          code: isOom ? 'INSUFFICIENT_RESOURCES' : 'MODEL_LOAD_FAILED',
          message: `Local Whisper model failed to load (${msg}). Cloud fallback is disabled.`,
        });
        return;
      }
    }

    const msg =
      primaryErr instanceof Error ? primaryErr.message : 'Failed to load local Whisper model.';
    const isOom = /memory|allocation|oom/i.test(msg);
    post({
      type: 'error',
      code: isOom ? 'INSUFFICIENT_RESOURCES' : 'MODEL_LOAD_FAILED',
      message: `Local Whisper model failed to load (${msg}). Cloud fallback is disabled.`,
    });
  }
}

async function handleTranscribe(requestId: number, audio: Float32Array): Promise<void> {
  try {
    if (!activeTranscriber || !loadedModelKey) {
      post({
        type: 'error',
        code: 'TRANSCRIPTION_FAILED',
        requestId,
        message: 'Local Whisper model is not initialized.',
      });
      return;
    }

    const startMs = performance.now();

    const isMultilingual = Boolean(
      (
        activeTranscriber as unknown as {
          model?: { generation_config?: { is_multilingual?: boolean } };
        }
      )?.model?.generation_config?.is_multilingual,
    );

    const options = isMultilingual
      ? {
          language: 'english',
          task: 'transcribe',
          return_timestamps: false,
          max_new_tokens: 128,
        }
      : {
          return_timestamps: false,
          max_new_tokens: 128,
        };

    const output = await activeTranscriber(audio, options);
    const processingMs = Math.round(performance.now() - startMs);

    const rawText = Array.isArray(output)
      ? output.map((item) => item.text).join(' ')
      : output.text;

    post({
      type: 'transcription-result',
      requestId,
      text: rawText ?? '',
      processingMs,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Local Whisper inference error.';
    const isOom = /memory|allocation|oom/i.test(errMsg);
    post({
      type: 'error',
      code: isOom ? 'INSUFFICIENT_RESOURCES' : 'TRANSCRIPTION_FAILED',
      requestId,
      message: isOom
        ? 'Insufficient computer memory/GPU resources during local speech recognition. Try switching to Whisper Tiny.en.'
        : 'A speech segment could not be processed by the local Whisper engine.',
    });
  } finally {
    // Always overwrite temporary PCM audio samples in Worker RAM immediately after inference
    audio.fill(0);
  }
}

async function handleDispose(): Promise<void> {
  if (activeTranscriber) {
    try {
      await activeTranscriber.dispose();
    } catch {
      // Ignore
    }
    activeTranscriber = null;
  }
  loadedModelId = '';
  loadedModelKey = null;
  loadedDevice = null;
}

self.addEventListener('message', (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') {
    return;
  }

  switch (msg.type) {
    case 'load':
      void handleLoad(
        msg.modelKey,
        msg.modelId,
        msg.preferredDevice,
        msg.wasmBaseUrl,
        msg.appOrigin,
      );
      break;
    case 'transcribe':
      void handleTranscribe(msg.requestId, msg.audio);
      break;
    case 'dispose':
      void handleDispose();
      break;
  }
});
