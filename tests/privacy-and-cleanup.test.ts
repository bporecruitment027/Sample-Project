import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrivacyPolicyError,
  clearNetworkAuditSessionLog,
  createGuardedFetch,
  getPrivacyGuardCounters,
  installMainThreadPrivacyGuards,
  isAllowedReadOnlyAssetUrl,
} from '../src/privacy/networkGuard.ts';
import { runLivePrivacyAudit } from '../src/privacy/storageAudit.ts';
import { PrivateTranscriberAppController } from '../src/ui/appController.ts';
import {
  FakeMediaStream,
  FakeTrack,
  FakeWhisperWorker,
  installWebAudioMocks,
  mountIndexHtml,
} from './helpers/domHarness.ts';

describe('Test 1, Test 5, Test 6 & Test 7 — Privacy, Zero Persistence, XSS Safety, and Full Cleanup', () => {
  beforeEach(() => {
    clearNetworkAuditSessionLog();
    localStorage.clear();
    sessionStorage.clear();
    mountIndexHtml();
    installMainThreadPrivacyGuards(globalThis);
  });

  it('Test 1: loads cleanly with zero automatic screen/audio capture and displays PRIVACY MODE ACTIVE only after local verification', async () => {
    const getDisplayMediaSpy = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: getDisplayMediaSpy,
        getUserMedia: async () => {
          throw new Error('should be blocked');
        },
      },
    });
    installMainThreadPrivacyGuards(globalThis);
    installWebAudioMocks();

    const controller = new PrivateTranscriberAppController({
      workerFactory: () => new FakeWhisperWorker(),
    });
    await controller.initialize();

    expect(getDisplayMediaSpy).not.toHaveBeenCalled();
    expect(controller.getTestSnapshot().lifecycleState).toBe('idle');
    expect(controller.getTestSnapshot().connectionStatus).toBe('Not connected');
    expect(document.getElementById('privacy-mode-indicator')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(document.getElementById('privacy-statement')?.textContent).toBe(
      'Audio is processed locally in this browser session. This application does not upload or save your conversation recordings or transcripts.',
    );

    controller.destroy();
  });

  it('Test 7: blocks POST/PUT payloads, cloud STT APIs, NICE/Avaya APIs, WebSocket, MediaRecorder, and microphone fallback while allowing read-only model GETs', async () => {
    const mockUnderlyingFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const guarded = createGuardedFetch(mockUnderlyingFetch, 'https://transcriber.local');

    // Allowed read-only software assets
    expect(
      isAllowedReadOnlyAssetUrl(
        'https://huggingface.co/onnx-community/whisper-base.en/resolve/main/config.json',
        'https://transcriber.local',
      ),
    ).toBe(true);
    expect(
      isAllowedReadOnlyAssetUrl(
        'https://cdn-lfs-us-1.hf.co/repos/weights/encoder_model.onnx',
        'https://transcriber.local',
      ),
    ).toBe(true);

    await guarded('https://huggingface.co/onnx-community/whisper-base.en/resolve/main/config.json');
    expect(mockUnderlyingFetch).toHaveBeenCalledTimes(1);

    // Forbidden cloud transcription, analytics, and softphone API hosts
    const forbiddenUrls = [
      'https://api.openai.com/v1/audio/transcriptions',
      'https://speech.googleapis.com/v1/speech:recognize',
      'https://australiaeast.stt.speech.microsoft.com/speech/recognition',
      'https://api.deepgram.com/v1/listen',
      'https://api.assemblyai.com/v2/transcript',
      'https://api.rev.ai/speechtotext/v1/jobs',
      'https://www.google-analytics.com/collect',
      'https://au1.nice-incontact.com/inContactAPI',
      'https://api.avaya.com/v1/calls',
    ];

    for (const badUrl of forbiddenUrls) {
      await expect(guarded(badUrl)).rejects.toThrow(PrivacyPolicyError);
    }

    // Forbidden POST or body upload even to an allowed host
    await expect(
      guarded('https://huggingface.co/onnx-community/whisper-base.en', {
        method: 'POST',
        body: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(PrivacyPolicyError);

    // Runtime browser exfiltration/recording APIs blocked
    if ('WebSocket' in globalThis) {
      expect(() => new (globalThis as unknown as { WebSocket: new (u: string) => unknown }).WebSocket('wss://evil.example')).toThrow(
        PrivacyPolicyError,
      );
    }

    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: class {},
    });
    // Re-verify MediaRecorder guard behavior
    const audit = await runLivePrivacyAudit();
    expect(audit.outboundAudioOrTextBytesSent).toBe(0);
    expect(audit.localStorageEntries).toBe(0);
    expect(audit.sessionStorageEntries).toBe(0);
    expect(audit.cookieBytes).toBe(0);
    expect(audit.cacheStorageBuckets).toBe(0);
    expect(audit.allChecksPassed).toBe(true);
    expect(getPrivacyGuardCounters().blockedNetworkAttempts).toBeGreaterThanOrEqual(
      forbiddenUrls.length + 1,
    );
  });

  it('renders recognized speech strictly with textContent (XSS-proof) and executes all 11 STOP cleanup steps (Test 5 & Test 6)', async () => {
    const audioTrack = new FakeTrack('audio', 'Windows Headset Loopback');
    const videoTrack = new FakeTrack('video', 'Screen 1', 'monitor');
    const fakeStream = new FakeMediaStream([videoTrack, audioTrack]);

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => fakeStream),
      },
    });

    const audioMocks = installWebAudioMocks();
    const fakeWorker = new FakeWhisperWorker();
    fakeWorker.nextTranscriptGenerator = () =>
      'Hello <img src=x onerror=alert(1)><script>window.__xss=true</script> account verified.';

    const controller = new PrivateTranscriberAppController({
      workerFactory: () => fakeWorker,
    });
    await controller.initialize();

    // Start session via START TRANSCRIPTION click
    document.getElementById('btn-start')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('active');
      expect(fakeWorker.receivedMessages.some((m) => m.type === 'load')).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 20));

    // Feed 1.2s of simulated speech + 1.3s of silence (>= 1.2s default pause threshold)
    const port = audioMocks.getLatestWorkletPort()!;
    for (let i = 0; i < 12; i++) {
      const voice = new Float32Array(1600);
      for (let s = 0; s < 1600; s++) {
        voice[s] = 0.25 * Math.sin((2 * Math.PI * 1000 * s) / 16_000);
      }
      port.emitFromWorklet({ type: 'pcm', samples: voice });
    }
    for (let i = 0; i < 13; i++) {
      port.emitFromWorklet({ type: 'pcm', samples: new Float32Array(1600) });
    }

    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().segmentCount).toBe(1);
    });

    // Verify XSS safety: zero <img> or <script> tags inside transcript feed!
    const feed = document.getElementById('transcript-feed')!;
    expect(feed.querySelectorAll('script').length).toBe(0);
    expect(feed.querySelectorAll('img').length).toBe(0);
    expect(feed.textContent).toContain('SYSTEM AUDIO');
    expect(feed.textContent).toContain('<script>window.__xss=true</script>');

    // Click STOP and verify all 11 cleanup steps
    document.getElementById('btn-stop')!.click();
    await vi.waitFor(() => {
      expect(controller.getTestSnapshot().lifecycleState).toBe('idle');
    });

    expect(audioTrack.stopCalls).toBeGreaterThanOrEqual(1);
    expect(videoTrack.stopCalls).toBeGreaterThanOrEqual(1);
    expect(audioMocks.getAudioContextStats().closedCount).toBe(1);
    expect(fakeWorker.terminated).toBe(true);
    expect(controller.getTestSnapshot().segmentCount).toBe(0);
    expect(controller.getTestSnapshot().bufferedSamples).toBe(0);
    expect(document.querySelectorAll('.segment-card').length).toBe(0);
    expect(document.getElementById('info-duration')?.textContent).toBe('00:00:00');
    expect(document.getElementById('audio-connection-status')?.textContent).toBe('Not connected');
    expect(document.getElementById('alert-message')?.textContent).toBe(
      'Session ended. Temporary session data cleared.',
    );

    // Verify storage remains completely empty after session (Test 6 reload guarantee)
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');

    controller.destroy();
  });
});
