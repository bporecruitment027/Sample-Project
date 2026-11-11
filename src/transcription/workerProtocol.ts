import type {
  AppErrorCode,
  ModelKey,
  NetworkAuditEntry,
  PreferredDeviceSetting,
  ProcessingDevice,
  WhisperTimestampChunk,
} from '../types/index.ts';

export type MainToWorkerMessage =
  | {
      type: 'load';
      modelKey: ModelKey;
      modelId: string;
      preferredDevice: PreferredDeviceSetting;
      wasmBaseUrl: string;
      appOrigin: string;
    }
  | {
      type: 'transcribe';
      requestId: number;
      audio: Float32Array;
    }
  | {
      type: 'dispose';
    };

export type WorkerToMainMessage =
  | {
      type: 'status';
      phase: 'probing' | 'downloading' | 'warming-up';
      detail: string;
    }
  | {
      type: 'progress';
      file: string;
      progress: number;
      loaded?: number;
      total?: number;
    }
  | {
      type: 'webgpu-fallback';
      reason: string;
    }
  | {
      type: 'ready';
      modelKey: ModelKey;
      modelId: string;
      activeDevice: ProcessingDevice;
    }
  | {
      type: 'transcription-result';
      requestId: number;
      text: string;
      chunks?: WhisperTimestampChunk[];
      processingMs: number;
    }
  | {
      type: 'network-audit';
      entry: NetworkAuditEntry;
    }
  | {
      type: 'error';
      code: AppErrorCode;
      message: string;
      requestId?: number;
    };
