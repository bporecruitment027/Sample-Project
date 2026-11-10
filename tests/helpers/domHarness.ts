import fs from 'node:fs';
import path from 'node:path';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from '../../src/transcription/workerProtocol.ts';
import type { WorkerLike } from '../../src/transcription/whisperEngine.ts';

export function mountIndexHtml(): void {
  const htmlPath = path.resolve(process.cwd(), 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : html;
  // Remove script tag in JSDOM so tests instantiate controller explicitly
  document.querySelectorAll('script').forEach((s) => s.remove());
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: FakeWhisperWorker,
  });
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

export class FakeTrack {
  public kind: 'audio' | 'video';
  public label: string;
  public enabled = true;
  public muted = false;
  public readyState: 'live' | 'ended' = 'live';
  public stopCalls = 0;
  private displaySurface: string;
  private listeners = new Map<string, Array<() => void>>();

  constructor(kind: 'audio' | 'video', label = 'System Audio', displaySurface = 'monitor') {
    this.kind = kind;
    this.label = label;
    this.displaySurface = displaySurface;
  }

  public stop(): void {
    this.stopCalls += 1;
    this.readyState = 'ended';
  }

  public getSettings(): Record<string, unknown> {
    return this.kind === 'video'
      ? { displaySurface: this.displaySurface }
      : { sampleRate: 48_000, channelCount: 2 };
  }

  public addEventListener(event: string, cb: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  public triggerExternalEnd(): void {
    this.readyState = 'ended';
    const list = this.listeners.get('ended') ?? [];
    for (const cb of list) {
      cb();
    }
  }
}

export class FakeMediaStream {
  private tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  public getTracks(): FakeTrack[] {
    return [...this.tracks];
  }

  public getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  public getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

export interface InstalledWebAudioMocks {
  getLatestWorkletPort: () => {
    emitFromWorklet: (data: unknown) => void;
    sentToWorklet: unknown[];
  } | null;
  getAudioContextStats: () => {
    createdCount: number;
    closedCount: number;
  };
}

export function installWebAudioMocks(): InstalledWebAudioMocks {
  let createdCount = 0;
  let closedCount = 0;
  let latestWorkletPort: {
    emitFromWorklet: (data: unknown) => void;
    sentToWorklet: unknown[];
  } | null = null;

  class MockAudioWorkletNode {
    public port: {
      onmessage: ((ev: { data: unknown }) => void) | null;
      postMessage: (data: unknown) => void;
      close: () => void;
    };
    public disconnected = false;

    constructor() {
      const sentToWorklet: unknown[] = [];
      const portObj = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        postMessage(data: unknown) {
          sentToWorklet.push(data);
        },
        close() {
          // closed
        },
      };
      this.port = portObj;
      latestWorkletPort = {
        sentToWorklet,
        emitFromWorklet(data: unknown) {
          portObj.onmessage?.({ data });
        },
      };
    }

    public connect(): void {}
    public disconnect(): void {
      this.disconnected = true;
    }
  }

  class MockAudioContext {
    public state: 'running' | 'suspended' | 'closed' = 'running';
    public sampleRate = 48_000;
    public destination = {};
    public audioWorklet = {
      async addModule(_url: string): Promise<void> {
        return;
      },
    };

    constructor() {
      createdCount += 1;
    }

    public async resume(): Promise<void> {
      this.state = 'running';
    }

    public createMediaStreamSource(_stream: unknown) {
      return {
        connect() {},
        disconnect() {},
      };
    }

    public createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {},
      };
    }

    public async close(): Promise<void> {
      if (this.state !== 'closed') {
        closedCount += 1;
        this.state = 'closed';
      }
    }
  }

  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    writable: true,
    value: FakeMediaStream,
  });

  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });

  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    writable: true,
    value: MockAudioWorkletNode,
  });

  return {
    getLatestWorkletPort: () => latestWorkletPort,
    getAudioContextStats: () => ({ createdCount, closedCount }),
  };
}

export class FakeWhisperWorker implements WorkerLike {
  public onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  public onerror: ((this: AbstractWorker, ev: ErrorEvent) => unknown) | null = null;
  public terminated = false;
  public receivedMessages: MainToWorkerMessage[] = [];
  public simulatedDevice: 'webgpu' | 'wasm' = 'webgpu';
  public shouldFailLoad = false;
  public nextTranscriptGenerator: (reqId: number, audio: Float32Array) => string = (reqId) =>
    `Recognized test sentence #${reqId}.`;
  public artificialLatencyMs = 0;

  public postMessage(message: MainToWorkerMessage): void {
    this.receivedMessages.push(message);

    if (message.type === 'load') {
      queueMicrotask(() => {
        if (this.terminated) return;
        if (this.shouldFailLoad) {
          this.emit({
            type: 'error',
            code: 'MODEL_LOAD_FAILED',
            message: 'Simulated model load error.',
          });
          return;
        }
        if (this.simulatedDevice === 'wasm') {
          this.emit({
            type: 'webgpu-fallback',
            reason: 'Simulated WebGPU unavailable; falling back to CPU WebAssembly.',
          });
        }
        this.emit({
          type: 'ready',
          modelKey: message.modelKey,
          modelId: message.modelId,
          activeDevice: this.simulatedDevice,
        });
      });
    } else if (message.type === 'transcribe') {
      const reply = () => {
        if (this.terminated) return;
        const text = this.nextTranscriptGenerator(message.requestId, message.audio);
        message.audio.fill(0);
        this.emit({
          type: 'transcription-result',
          requestId: message.requestId,
          text,
          processingMs: 42,
        });
      };

      if (this.artificialLatencyMs > 0) {
        setTimeout(reply, this.artificialLatencyMs);
      } else {
        queueMicrotask(reply);
      }
    }
  }

  public terminate(): void {
    this.terminated = true;
  }

  private emit(msg: WorkerToMainMessage): void {
    this.onmessage?.call(this as unknown as Worker, { data: msg } as MessageEvent);
  }
}
