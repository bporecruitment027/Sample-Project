import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  TARGET_SAMPLE_RATE,
  analyzeAudioFrame16k,
  createBiquadBandpassState,
  downsampleTo16kHz,
  mixChannelsToMono,
  secureZeroFloat32,
} from '../src/audio/dsp.ts';

function synthesizeSine(freqHz: number, sampleRate: number, durationSec: number, amp = 0.4): Float32Array {
  const len = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

describe('DSP & AudioWorklet Ephemeral Capture Processor', () => {
  it('mixes stereo channels accurately to mono and zeroes buffers securely', () => {
    const left = new Float32Array([0.6, -0.4, 0.2, 0.0]);
    const right = new Float32Array([0.2, 0.4, -0.6, 0.8]);
    const mono = mixChannelsToMono([left, right]);

    expect(mono.length).toBe(4);
    expect(mono[0]).toBeCloseTo(0.4, 5);
    expect(mono[1]).toBeCloseTo(0.0, 5);
    expect(mono[2]).toBeCloseTo(-0.2, 5);
    expect(mono[3]).toBeCloseTo(0.4, 5);

    secureZeroFloat32(mono);
    expect(Array.from(mono)).toEqual([0, 0, 0, 0]);
  });

  it('downsamples 48 kHz and 44.1 kHz audio to 16 kHz while preserving fundamental speech frequencies', () => {
    const tone48k = synthesizeSine(1000, 48_000, 0.5, 0.5);
    const down16k = downsampleTo16kHz(tone48k, 48_000, TARGET_SAMPLE_RATE);
    expect(down16k.length).toBe(8_000);

    const tone44k = synthesizeSine(800, 44_100, 0.5, 0.5);
    const downFrom44k = downsampleTo16kHz(tone44k, 44_100, TARGET_SAMPLE_RATE);
    expect(downFrom44k.length).toBe(8_000);

    const state = createBiquadBandpassState();
    const metrics = analyzeAudioFrame16k(down16k, state);
    expect(metrics.rms).toBeGreaterThan(0.25);
    expect(metrics.speechBandRatio).toBeGreaterThan(0.5);
    expect(metrics.clipping).toBe(false);
  });

  it('distinguishes 1 kHz voice-band energy from low-frequency 40 Hz mains hum', () => {
    const voiceBand = synthesizeSine(1000, 16_000, 0.25, 0.3);
    const hum40Hz = synthesizeSine(40, 16_000, 0.25, 0.3);

    const voiceMetrics = analyzeAudioFrame16k(voiceBand, createBiquadBandpassState());
    const humMetrics = analyzeAudioFrame16k(hum40Hz, createBiquadBandpassState());

    expect(voiceMetrics.speechBandRatio).toBeGreaterThan(0.6);
    expect(humMetrics.speechBandRatio).toBeLessThan(0.15);
  });

  it('executes public/audio-capture-worklet.js: downsamples 48 kHz stereo, discards while paused, and shuts down cleanly', () => {
    const workletPath = path.resolve(process.cwd(), 'public/audio-capture-worklet.js');
    const code = fs.readFileSync(workletPath, 'utf8');

    const postedMessages: Array<{ data: unknown; transfer?: unknown[] }> = [];
    let registeredClass: (new () => {
      port: { onmessage: ((ev: { data: unknown }) => void) | null };
      process: (inputs: Float32Array[][]) => boolean;
    }) | null = null;

    class MockAudioWorkletProcessor {
      public port = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        postMessage(data: unknown, transfer?: unknown[]) {
          postedMessages.push({ data, transfer });
        },
      };
    }

    const sandbox = {
      sampleRate: 48_000,
      AudioWorkletProcessor: MockAudioWorkletProcessor,
      Float32Array,
      Math,
      Boolean,
      registerProcessor(_name: string, cls: typeof registeredClass) {
        registeredClass = cls;
      },
    };

    vm.runInNewContext(code, sandbox);
    expect(registeredClass).not.toBeNull();

    const processor = new registeredClass!();

    // Feed 40 stereo 128-frame blocks at 48 kHz (5,120 frames = ~1,706 samples @ 16 kHz -> >= 1 PCM chunk of 1,600 samples)
    for (let block = 0; block < 40; block++) {
      const left = new Float32Array(128).fill(0.25);
      const right = new Float32Array(128).fill(0.25);
      const alive = processor.process([[left, right]]);
      expect(alive).toBe(true);
    }

    const pcmMessages = postedMessages.filter(
      (m) => (m.data as { type?: string }).type === 'pcm',
    );
    const levelMessages = postedMessages.filter(
      (m) => (m.data as { type?: string }).type === 'level',
    );
    expect(pcmMessages.length).toBe(1);
    expect(((pcmMessages[0].data as { samples: Float32Array }).samples).length).toBe(1600);
    expect(levelMessages.length).toBeGreaterThanOrEqual(2);

    // Pause and verify zero PCM chunks are emitted while paused
    postedMessages.length = 0;
    processor.port.onmessage?.({ data: { type: 'pause', paused: true } });
    for (let block = 0; block < 60; block++) {
      const left = new Float32Array(128).fill(0.4);
      processor.process([[left]]);
    }
    const pausedPcm = postedMessages.filter(
      (m) => (m.data as { type?: string }).type === 'pcm',
    );
    expect(pausedPcm.length).toBe(0);

    // Shutdown and verify process() returns false permanently
    processor.port.onmessage?.({ data: { type: 'shutdown' } });
    const aliveAfterShutdown = processor.process([[new Float32Array(128)]]);
    expect(aliveAfterShutdown).toBe(false);
  });
});
