import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompatibilityDiagnosticsEngine } from '../src/audio/compatibilityDiagnostics.ts';
import {
  validateDevicePreference,
  validateDiagnosticProfile,
  validateModelKey,
} from '../src/config/models.ts';
import { installMainThreadPrivacyGuards } from '../src/privacy/networkGuard.ts';
import { PrivateTranscriberAppController } from '../src/ui/appController.ts';
import {
  FakeMediaStream,
  FakeTrack,
  FakeWhisperWorker,
  installWebAudioMocks,
  mountIndexHtml,
} from './helpers/domHarness.ts';

describe('Test 2, Test 3, Error Scenarios & NICE CXone / Avaya Compatibility Diagnostics', () => {
  beforeEach(() => {
    mountIndexHtml();
    installMainThreadPrivacyGuards(globalThis);
  });

  it('aborts capture immediately when Chrome returns screen video without a system audio track (no microphone fallback)', async () => {
    const videoOnlyTrack = new FakeTrack('video', 'Screen 1', 'monitor');
    const videoOnlyStream = new FakeMediaStream([videoOnlyTrack]);
    const getUserMediaSpy = vi.fn();

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => videoOnlyStream),
        getUserMedia: getUserMediaSpy,
      },
    });
    installWebAudioMocks();

    const controller = new PrivateTranscriberAppController({
      workerFactory: () => new FakeWhisperWorker(),
    });
    await controller.initialize();

    const profileSelect = document.getElementById('select-profile') as HTMLSelectElement;
    profileSelect.value = 'nice-cxone';
    profileSelect.dispatchEvent(new Event('change'));

    document.getElementById('btn-start')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('idle');
    });

    expect(videoOnlyTrack.stopCalls).toBeGreaterThanOrEqual(1);
    expect(getUserMediaSpy).not.toHaveBeenCalled();
    expect(controller.getTestSnapshot().connectionStatus).toBe('No system audio detected');
    expect(document.getElementById('alert-message')?.textContent).toContain(
      'NICE CXone or Avaya is routing call audio through a separate audio endpoint',
    );

    controller.destroy();
  });

  it('handles user permission denial cleanly without starting capture', async () => {
    const err = new DOMException('Permission denied by user', 'NotAllowedError');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => {
          throw err;
        }),
      },
    });
    installWebAudioMocks();

    const controller = new PrivateTranscriberAppController({
      workerFactory: () => new FakeWhisperWorker(),
    });
    await controller.initialize();

    document.getElementById('btn-start')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('idle');
    });

    expect(controller.getTestSnapshot().connectionStatus).toBe('Not connected');
    expect(document.getElementById('alert-title')?.textContent).toContain(
      'Screen-Sharing Permission Cancelled or Denied',
    );

    controller.destroy();
  });

  it('aborts and stops capturing customer audio if the local Whisper model fails to initialize (Section 7G)', async () => {
    const audioTrack = new FakeTrack('audio', 'System Audio');
    const videoTrack = new FakeTrack('video', 'Screen 1', 'monitor');
    const stream = new FakeMediaStream([videoTrack, audioTrack]);

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => stream),
      },
    });
    installWebAudioMocks();

    const failingWorker = new FakeWhisperWorker();
    failingWorker.shouldFailLoad = true;

    const controller = new PrivateTranscriberAppController({
      workerFactory: () => failingWorker,
    });
    await controller.initialize();

    document.getElementById('btn-start')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('idle');
    });

    // Both tracks must be stopped immediately when local model initialization fails
    expect(audioTrack.stopCalls).toBeGreaterThanOrEqual(1);
    expect(videoTrack.stopCalls).toBeGreaterThanOrEqual(1);
    expect(controller.getTestSnapshot().connectionStatus).toBe('Not connected');

    controller.destroy();
  });

  it('supports PAUSE/RESUME discarding audio while paused, WebGPU->WASM fallback, and external Stop Sharing cleanup', async () => {
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

    const wasmWorker = new FakeWhisperWorker();
    wasmWorker.simulatedDevice = 'wasm';

    const controller = new PrivateTranscriberAppController({
      workerFactory: () => wasmWorker,
    });
    await controller.initialize();

    document.getElementById('btn-start')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('active');
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(document.getElementById('info-method')?.textContent).toContain('WebAssembly');

    // Emit live desktop audio activity (Test 3)
    const port = audioMocks.getLatestWorkletPort()!;
    port.emitFromWorklet({
      type: 'level',
      rms: 0.12,
      peak: 0.35,
      speechBandRatio: 0.72,
      clipping: false,
    });
    expect(controller.getTestSnapshot().activityStatus).toBe('Audio activity detected');

    // Pause session and confirm incoming audio chunks are discarded without buffering
    document.getElementById('btn-pause')!.click();
    expect(controller.getTestSnapshot().lifecycleState).toBe('paused');
    expect(controller.getTestSnapshot().processingStatus).toBe(
      'Paused — incoming audio discarded',
    );

    const sampleWhilePaused = new Float32Array(1600).fill(0.3);
    port.emitFromWorklet({ type: 'pcm', samples: sampleWhilePaused });
    expect(sampleWhilePaused.every((v) => v === 0)).toBe(true);
    expect(controller.getTestSnapshot().bufferedSamples).toBe(0);

    // Resume
    document.getElementById('btn-resume')!.click();
    expect(controller.getTestSnapshot().lifecycleState).toBe('active');

    // Simulate user clicking Chrome's external "Stop sharing" banner
    videoTrack.triggerExternalEnd();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('idle');
    });
    expect(document.getElementById('alert-title')?.textContent).toContain(
      'Screen Sharing Stopped Outside Application',
    );

    controller.destroy();
  });

  it('evaluates NICE CXone, Avaya, and Combined Audio compatibility checks including clarity and hold silence transitions', () => {
    const diag = new CompatibilityDiagnosticsEngine();
    diag.setProfile('avaya');
    diag.startSession({
      hasAudioTrack: true,
      trackLabel: 'Avaya USB Headset Output',
      sampleRateHz: 48_000,
      isLive: true,
    });

    // Feed 8 active speech frames
    for (let i = 0; i < 8; i++) {
      diag.ingestMetrics(
        {
          rms: 0.09,
          peak: 0.3,
          dbfs: -20.9,
          speechBandRatio: 0.68,
          clipping: false,
          isSpeechActive: true,
        },
        true,
      );
    }

    // Simulate 2-second call hold silence while track remains live
    const baseNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 100);
    diag.ingestMetrics(
      { rms: 0.0001, peak: 0.0002, dbfs: -80, speechBandRatio: 0, clipping: false, isSpeechActive: false },
      true,
    );
    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 6000);
    diag.ingestMetrics(
      { rms: 0.0001, peak: 0.0002, dbfs: -80, speechBandRatio: 0, clipping: false, isSpeechActive: false },
      true,
    );

    const snap = diag.getSnapshot();
    expect(snap.profile).toBe('avaya');
    expect(snap.holdTransitionsObserved).toBe(1);
    expect(snap.checks.find((c) => c.id === 'audio-track')?.state).toBe('pass');
    expect(snap.checks.find((c) => c.id === 'signal-activity')?.state).toBe('pass');
    expect(snap.checks.find((c) => c.id === 'speech-clarity')?.state).toBe('pass');
    expect(snap.checks.find((c) => c.id === 'track-stability')?.state).toBe('pass');
    expect(snap.checks.find((c) => c.id === 'hold-interruption')?.state).toBe('pass');

    vi.restoreAllMocks();
    diag.resetAndClear();
    expect(diag.getSnapshot().peakRmsObserved).toBe(0);
  });

  it('validates configuration fields strictly and rejects untrusted values', () => {
    expect(validateModelKey('base.en')).toBe('base.en');
    expect(validateModelKey('tiny.en')).toBe('tiny.en');
    expect(() => validateModelKey('cloud-gpt-4o')).toThrow();

    expect(validateDevicePreference('auto')).toBe('auto');
    expect(validateDevicePreference('wasm')).toBe('wasm');
    expect(() => validateDevicePreference('remote-gpu')).toThrow();

    expect(validateDiagnosticProfile('nice-cxone')).toBe('nice-cxone');
    expect(validateDiagnosticProfile('avaya')).toBe('avaya');
    expect(validateDiagnosticProfile('combined')).toBe('combined');
    expect(() => validateDiagnosticProfile('inject<script>')).toThrow();
  });
});
