import { WHISPER_MODELS } from '../config/models.ts';
import { deduplicateSegmentDetailed } from '../audio/deduplicator.ts';
import { secureZeroFloat32 } from '../audio/dsp.ts';
import type { SpeechSegmentPayload } from '../audio/vadSegmenter.ts';
import { recordWorkerAuditEntry } from '../privacy/networkGuard.ts';
import type {
  AppAlert,
  ModelKey,
  ModelLoadingStatus,
  PreferredDeviceSetting,
  ProcessingDevice,
} from '../types/index.ts';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from './workerProtocol.ts';

interface QueuedSegmentItem {
  requestId: number;
  samples: Float32Array;
  durationSec: number;
  hadBoundaryOverlap: boolean;
  overlapDurationSec: number;
  rms: number;
  peak: number;
  speechBandRatio: number;
  clippedRatio: number;
  enqueuedAtClock: string;
}

export interface TranscribedSegmentMetaPayload {
  text: string;
  clockTimestamp: string;
  processingMs: number;
  durationSec: number;
  rms: number;
  peak: number;
  speechBandRatio: number;
  clippedRatio: number;
  wasHallucinationBlocked: boolean;
  wasRepetitionSuppressed: boolean;
}

export interface WhisperEngineCallbacks {
  onModelLoadingStatus: (
    status: ModelLoadingStatus,
    progressPct: number | null,
    detail?: string,
  ) => void;
  onEngineReady: (modelKey: ModelKey, device: ProcessingDevice) => void;
  onQueueStateChange: (inFlight: boolean, queuedCount: number) => void;
  onSegmentTranscribed: (payload: TranscribedSegmentMetaPayload) => void;
  onSegmentDroppedByBackpressure?: () => void;
  onRecognitionFailure?: () => void;
  onAlert: (alert: AppAlert) => void;
}

const BACKPRESSURE_WARN_THRESHOLD = 3;
const MAX_QUEUE_HARD_CAP = 5;

export type WorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;

export class LocalWhisperEngine {
  private readonly callbacks: WhisperEngineCallbacks;
  private readonly createWorkerFn: () => WorkerLike;

  private worker: WorkerLike | null = null;
  private ready = false;
  private loadingPromise: Promise<boolean> | null = null;
  private resolveLoading: ((ok: boolean) => void) | null = null;

  private loadedModelKey: ModelKey | null = null;
  private activeDevice: ProcessingDevice | null = null;

  private queue: QueuedSegmentItem[] = [];
  private inFlightItem: Omit<QueuedSegmentItem, 'samples'> | null = null;
  private nextRequestId = 1;
  private acceptingResults = true;
  private lastTranscribedText = '';
  private lastProcessingMs = 0;
  private fileProgressMap = new Map<string, number>();

  constructor(
    callbacks: WhisperEngineCallbacks,
    customWorkerFactory?: () => WorkerLike,
  ) {
    this.callbacks = callbacks;
    this.createWorkerFn =
      customWorkerFactory ??
      (() =>
        new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), {
          type: 'module',
          name: 'local-whisper-worker',
        }));
  }

  public get isReady(): boolean {
    return this.ready;
  }

  public get currentDevice(): ProcessingDevice | null {
    return this.activeDevice;
  }

  public get currentModelKey(): ModelKey | null {
    return this.loadedModelKey;
  }

  public get pendingCount(): number {
    return this.queue.length + (this.inFlightItem ? 1 : 0);
  }

  public get queueSnapshot(): {
    inFlight: boolean;
    queuedCount: number;
    lastProcessingMs: number;
  } {
    return {
      inFlight: Boolean(this.inFlightItem),
      queuedCount: this.queue.length,
      lastProcessingMs: this.lastProcessingMs,
    };
  }

  public async initializeModel(
    modelKey: ModelKey,
    preferredDevice: PreferredDeviceSetting,
  ): Promise<boolean> {
    if (
      this.ready &&
      this.worker &&
      this.loadedModelKey === modelKey &&
      (preferredDevice === 'auto' || preferredDevice === this.activeDevice)
    ) {
      return true;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.ensureWorker();
    this.fileProgressMap.clear();
    this.acceptingResults = true;

    const spec = WHISPER_MODELS[modelKey];
    const wasmBaseUrl =
      typeof window !== 'undefined'
        ? new URL('./wasm/', window.location.href).href
        : 'https://localhost/wasm/';
    const appOrigin =
      typeof window !== 'undefined' ? window.location.origin : 'https://localhost';

    this.callbacks.onModelLoadingStatus(
      'Probing local compute engine...',
      0,
      `Preparing ${spec.shortName}`,
    );

    this.loadingPromise = new Promise<boolean>((resolve) => {
      this.resolveLoading = resolve;
    });

    const loadMsg: MainToWorkerMessage = {
      type: 'load',
      modelKey,
      modelId: spec.modelId,
      preferredDevice,
      wasmBaseUrl,
      appOrigin,
    };
    this.worker!.postMessage(loadMsg);

    return this.loadingPromise;
  }

  public enqueueSegment(segment: SpeechSegmentPayload): void {
    if (!this.acceptingResults || !this.worker || !this.ready) {
      secureZeroFloat32(segment.samples);
      return;
    }

    if (this.queue.length >= MAX_QUEUE_HARD_CAP) {
      const dropped = this.queue.shift();
      if (dropped) {
        secureZeroFloat32(dropped.samples);
      }
      this.callbacks.onSegmentDroppedByBackpressure?.();
      this.callbacks.onAlert({
        code: 'INSUFFICIENT_RESOURCES',
        severity: 'warning',
        title: 'Computer Cannot Keep Up With Live Speech Rate',
        message:
          'Local recognition queue reached its temporary memory safety limit (5 segments), so an older queued segment was discarded to prevent memory buildup.',
        remediation:
          this.loadedModelKey === 'small.en'
            ? 'Switch the model selector to "Whisper Base.en — Balanced Speed & Accuracy" for ~2.8x faster CPU processing.'
            : 'Switch to "Whisper Tiny.en" or close unneeded browser tabs to free CPU/GPU cycles.',
      });
    } else if (this.queue.length + (this.inFlightItem ? 1 : 0) >= BACKPRESSURE_WARN_THRESHOLD) {
      this.callbacks.onAlert({
        code: 'INSUFFICIENT_RESOURCES',
        severity: 'warning',
        title: 'High Local Processing Latency Detected',
        message: `${this.queue.length + 1} speech segments are waiting for local CPU/GPU recognition.`,
        remediation:
          this.loadedModelKey === 'small.en'
            ? 'Consider switching to Whisper Base.en if transcription lags behind the conversation.'
            : 'Close unneeded browser tabs to free CPU/GPU cycles for local transcription.',
      });
    }

    const item: QueuedSegmentItem = {
      requestId: this.nextRequestId++,
      samples: segment.samples,
      durationSec: segment.durationSec ?? segment.samples.length / 16_000,
      hadBoundaryOverlap: segment.hadBoundaryOverlap,
      overlapDurationSec: segment.overlapDurationSec ?? (segment.hadBoundaryOverlap ? 3.0 : 0),
      rms: segment.rms,
      peak: segment.peak ?? Math.min(1, segment.rms * 3),
      speechBandRatio: segment.speechBandRatio ?? 0.5,
      clippedRatio: segment.clippedRatio ?? 0,
      enqueuedAtClock: new Date().toTimeString().slice(0, 8),
    };

    this.queue.push(item);
    this.dispatchNextIfIdle();
  }

  public discardPendingBuffers(resetDedupContext: boolean = false): void {
    for (const item of this.queue) {
      secureZeroFloat32(item.samples);
    }
    this.queue = [];
    this.inFlightItem = null;
    if (resetDedupContext) {
      this.lastTranscribedText = '';
      this.lastProcessingMs = 0;
    }
    this.callbacks.onQueueStateChange(false, 0);
  }

  public setPaused(paused: boolean): void {
    this.acceptingResults = !paused;
    if (paused) {
      this.discardPendingBuffers(false);
    }
  }

  public shutdownAndTerminate(): void {
    this.acceptingResults = false;
    this.discardPendingBuffers(true);
    this.fileProgressMap.clear();

    if (this.resolveLoading) {
      this.resolveLoading(false);
      this.resolveLoading = null;
    }
    this.loadingPromise = null;

    if (this.worker) {
      try {
        const disposeMsg: MainToWorkerMessage = { type: 'dispose' };
        this.worker.postMessage(disposeMsg);
      } catch {
        // Ignore postMessage error prior to termination
      }
      try {
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.terminate();
      } catch {
        // Ignore terminate error
      }
      this.worker = null;
    }

    this.ready = false;
    this.loadedModelKey = null;
    this.activeDevice = null;
    this.callbacks.onModelLoadingStatus('Not loaded (on-demand or preload)', null);
    this.callbacks.onQueueStateChange(false, 0);
  }

  private ensureWorker(): void {
    if (this.worker) {
      return;
    }
    const w = this.createWorkerFn();
    w.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      this.handleWorkerMessage(event.data);
    };
    w.onerror = (err: ErrorEvent) => {
      this.ready = false;
      this.callbacks.onRecognitionFailure?.();
      if (this.resolveLoading) {
        this.resolveLoading(false);
        this.resolveLoading = null;
        this.loadingPromise = null;
      }
      this.callbacks.onModelLoadingStatus('Failed to load', null);
      this.callbacks.onAlert({
        code: 'MODEL_LOAD_FAILED',
        severity: 'error',
        title: 'Local Recognition Worker Error',
        message:
          err.message ||
          'The local speech recognition Web Worker encountered an unexpected error.',
      });
    };
    this.worker = w;
  }

  private dispatchNextIfIdle(): void {
    if (!this.worker || !this.ready || this.inFlightItem || !this.acceptingResults) {
      this.callbacks.onQueueStateChange(Boolean(this.inFlightItem), this.queue.length);
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      this.callbacks.onQueueStateChange(false, 0);
      return;
    }

    const { samples, ...meta } = next;
    this.inFlightItem = meta;

    this.callbacks.onQueueStateChange(true, this.queue.length);

    const msg: MainToWorkerMessage = {
      type: 'transcribe',
      requestId: next.requestId,
      audio: samples,
    };

    try {
      this.worker.postMessage(msg, [samples.buffer]);
    } catch {
      secureZeroFloat32(samples);
      this.inFlightItem = null;
      this.callbacks.onQueueStateChange(false, this.queue.length);
    }
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    switch (msg.type) {
      case 'network-audit': {
        recordWorkerAuditEntry(msg.entry);
        break;
      }

      case 'status': {
        const statusLabel: ModelLoadingStatus =
          msg.phase === 'probing'
            ? 'Probing local compute engine...'
            : msg.phase === 'downloading'
              ? 'Downloading software model assets...'
              : 'Compiling shaders & warming up local model...';
        this.callbacks.onModelLoadingStatus(statusLabel, null, msg.detail);
        break;
      }

      case 'progress': {
        this.fileProgressMap.set(msg.file, msg.progress);
        let sum = 0;
        for (const p of this.fileProgressMap.values()) {
          sum += p;
        }
        const avg = Math.min(99, Math.round(sum / Math.max(1, this.fileProgressMap.size)));
        const shortFile = msg.file.split('/').pop() ?? msg.file;
        this.callbacks.onModelLoadingStatus(
          'Downloading software model assets...',
          avg,
          `${shortFile} (${Math.round(msg.progress)}%)`,
        );
        break;
      }

      case 'webgpu-fallback': {
        this.callbacks.onAlert({
          code: 'WEBGPU_UNAVAILABLE',
          severity: 'info',
          title: 'WebGPU Unavailable — Using Local WebAssembly (CPU)',
          message: msg.reason,
          remediation:
            'Local speech recognition continues privately via WebAssembly on your CPU. You can select Whisper Base.en for faster CPU speed if needed.',
        });
        break;
      }

      case 'ready': {
        this.ready = true;
        this.loadedModelKey = msg.modelKey;
        this.activeDevice = msg.activeDevice;
        this.fileProgressMap.clear();

        this.callbacks.onModelLoadingStatus('Ready (in local RAM)', 100);
        this.callbacks.onEngineReady(msg.modelKey, msg.activeDevice);

        if (this.resolveLoading) {
          this.resolveLoading(true);
          this.resolveLoading = null;
          this.loadingPromise = null;
        }

        this.dispatchNextIfIdle();
        break;
      }

      case 'transcription-result': {
        const completed = this.inFlightItem;
        if (completed && completed.requestId === msg.requestId) {
          this.inFlightItem = null;
          this.lastProcessingMs = msg.processingMs;
          if (this.acceptingResults) {
            const dedupResult = deduplicateSegmentDetailed({
              previousSegmentText: this.lastTranscribedText,
              incomingSegmentText: msg.text,
              chunks: msg.chunks,
              hadBoundaryOverlap: completed.hadBoundaryOverlap,
              overlapDurationSec: completed.overlapDurationSec,
            });
            if (dedupResult.text) {
              this.lastTranscribedText = dedupResult.text;
            }
            if (
              dedupResult.text ||
              dedupResult.wasHallucinationBlocked ||
              dedupResult.wasRepetitionSuppressed
            ) {
              this.callbacks.onSegmentTranscribed({
                text: dedupResult.text,
                clockTimestamp: completed.enqueuedAtClock,
                processingMs: msg.processingMs,
                durationSec: completed.durationSec,
                rms: completed.rms,
                peak: completed.peak,
                speechBandRatio: completed.speechBandRatio,
                clippedRatio: completed.clippedRatio,
                wasHallucinationBlocked: dedupResult.wasHallucinationBlocked,
                wasRepetitionSuppressed: dedupResult.wasRepetitionSuppressed,
              });
            }
          }
        }
        this.dispatchNextIfIdle();
        break;
      }

      case 'error': {
        if (this.resolveLoading) {
          this.ready = false;
          this.callbacks.onModelLoadingStatus('Failed to load', null);
          this.resolveLoading(false);
          this.resolveLoading = null;
          this.loadingPromise = null;
        }
        if (msg.requestId !== undefined) {
          this.callbacks.onRecognitionFailure?.();
          if (this.inFlightItem?.requestId === msg.requestId) {
            this.inFlightItem = null;
            this.dispatchNextIfIdle();
          }
        }
        this.callbacks.onAlert({
          code: msg.code,
          severity: 'error',
          title:
            msg.code === 'WASM_UNAVAILABLE'
              ? 'WebAssembly Unavailable — Local Processing Blocked'
              : msg.code === 'MODEL_LOAD_FAILED'
                ? 'Local Speech Recognition Model Failed to Load'
                : msg.code === 'INSUFFICIENT_RESOURCES'
                  ? 'Insufficient Computer Resources for Local Model'
                  : 'Local Transcription Segment Error',
          message: msg.message,
          remediation:
            msg.code === 'MODEL_LOAD_FAILED'
              ? 'Check your HTTPS network access to huggingface.co software model files and try again. Cloud fallback is strictly disabled.'
              : undefined,
        });
        break;
      }
    }
  }
}
