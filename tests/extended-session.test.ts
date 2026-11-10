import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installMainThreadPrivacyGuards } from '../src/privacy/networkGuard.ts';
import { PrivateTranscriberAppController } from '../src/ui/appController.ts';
import {
  FakeMediaStream,
  FakeTrack,
  FakeWhisperWorker,
  installWebAudioMocks,
  mountIndexHtml,
} from './helpers/domHarness.ts';

describe('Test 8 — Extended 20-Minute Session Stability, Memory Bounds & Backpressure Handling', () => {
  beforeEach(() => {
    mountIndexHtml();
    installMainThreadPrivacyGuards(globalThis);
  });

  it('processes 20 minutes (12,000 x 100 ms chunks = 19.2M samples) without unbounded buffer growth, duplicates, or leaks', async () => {
    const audioTrack = new FakeTrack('audio', 'System Audio');
    const videoTrack = new FakeTrack('video', 'Screen 1', 'monitor');
    const stream = new FakeMediaStream([videoTrack, audioTrack]);

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => stream),
      },
    });
    const audioMocks = installWebAudioMocks();

    const worker = new FakeWhisperWorker();
    worker.nextTranscriptGenerator = (reqId) =>
      `Customer statement segment number ${reqId} verified clearly.`;

    const controller = new PrivateTranscriberAppController({
      workerFactory: () => worker,
    });
    await controller.initialize();

    document.getElementById('btn-start')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('active');
    });
    await new Promise((r) => setTimeout(r, 20));

    const port = audioMocks.getLatestWorkletPort()!;

    // Precompute a 100ms speech template (copied per push since VAD zeroes incoming buffers)
    const speechTemplate = new Float32Array(1600);
    for (let s = 0; s < 1600; s++) {
      speechTemplate[s] = 0.22 * Math.sin((2 * Math.PI * 950 * s) / 16_000);
    }

    let maxBufferedSamplesObserved = 0;

    // Simulate 200 utterances over 20 minutes (each cycle = 3.0s speech + 3.0s silence = 6.0s -> 200 * 6s = 1,200s = 20 minutes!)
    for (let cycle = 0; cycle < 200; cycle++) {
      for (let f = 0; f < 30; f++) {
        port.emitFromWorklet({ type: 'pcm', samples: new Float32Array(speechTemplate) });
        const curBuf = controller.getTestSnapshot().bufferedSamples;
        if (curBuf > maxBufferedSamplesObserved) {
          maxBufferedSamplesObserved = curBuf;
        }
      }
      for (let f = 0; f < 30; f++) {
        port.emitFromWorklet({ type: 'pcm', samples: new Float32Array(1600) });
      }
      // Yield microtasks so worker processes sequential segments
      await new Promise((r) => setTimeout(r, 0));
    }

    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().segmentCount).toBe(200);
    });

    // Max buffered samples must never exceed 8.0s * 16,000 + preRoll (~132,800 samples = ~531 KB)
    expect(maxBufferedSamplesObserved).toBeLessThanOrEqual(135_000);

    // Stop session and confirm all 200 transcript entries and buffers are wiped to zero
    document.getElementById('btn-stop')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('idle');
    });
    expect(controller.getTestSnapshot().segmentCount).toBe(0);
    expect(controller.getTestSnapshot().bufferedSamples).toBe(0);
    expect(document.querySelectorAll('.segment-card').length).toBe(0);

    controller.destroy();
  });

  it('displays a performance backpressure warning rather than leaking memory when incoming speech outpaces slow CPU inference', async () => {
    const audioTrack = new FakeTrack('audio', 'System Audio');
    const videoTrack = new FakeTrack('video', 'Screen 1', 'monitor');
    const stream = new FakeMediaStream([videoTrack, audioTrack]);

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => stream),
      },
    });
    const audioMocks = installWebAudioMocks();

    const slowWorker = new FakeWhisperWorker();
    slowWorker.artificialLatencyMs = 120;

    const controller = new PrivateTranscriberAppController({
      workerFactory: () => slowWorker,
    });
    await controller.initialize();

    document.getElementById('btn-start')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('active');
    });
    await new Promise((r) => setTimeout(r, 20));

    const port = audioMocks.getLatestWorkletPort()!;
    const speechTemplate = new Float32Array(1600);
    for (let s = 0; s < 1600; s++) {
      speechTemplate[s] = 0.25 * Math.sin((2 * Math.PI * 1000 * s) / 16_000);
    }

    // Rapidly push 4 speech segments before slowWorker finishes segment #1
    for (let seg = 0; seg < 4; seg++) {
      for (let f = 0; f < 10; f++) {
        port.emitFromWorklet({ type: 'pcm', samples: new Float32Array(speechTemplate) });
      }
      for (let f = 0; f < 8; f++) {
        port.emitFromWorklet({ type: 'pcm', samples: new Float32Array(1600) });
      }
    }

    expect(document.getElementById('alert-title')?.textContent).toContain('Latency');

    document.getElementById('btn-stop')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('idle');
    });

    controller.destroy();
  });
});
