// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompatibilityDiagnosticsEngine } from '../src/audio/compatibilityDiagnostics.ts';
import {
  analyzeAndSanitizeWhisperOutput,
  deduplicateSegmentDetailed,
} from '../src/audio/deduplicator.ts';
import {
  StreamingSincResampler,
  analyzeAudioFrame16k,
  downsampleTo16kHz,
  inspectAndMixChannels,
} from '../src/audio/dsp.ts';
import { EphemeralAudioEnhancer } from '../src/audio/enhancement.ts';
import {
  EphemeralVadSegmenter,
  type SpeechSegmentPayload,
} from '../src/audio/vadSegmenter.ts';
import {
  DEFAULT_MODEL_KEY,
  DEFAULT_VAD_CONFIG,
  WHISPER_MODELS,
} from '../src/config/models.ts';
import {
  clearNetworkAuditSessionLog,
  installMainThreadPrivacyGuards,
} from '../src/privacy/networkGuard.ts';
import { TranscriptionQualityController } from '../src/transcription/qualityControl.ts';
import { PrivateTranscriberAppController } from '../src/ui/appController.ts';
import {
  FakeMediaStream,
  FakeTrack,
  installWebAudioMocks,
  mountIndexHtml,
} from './helpers/domHarness.ts';

function generateSine(
  freqHz: number,
  sampleRate: number,
  durationSec: number,
  amp = 0.5,
): Float32Array {
  const n = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function computeRms(samples: Float32Array, skipEdge = 0): number {
  let sumSq = 0;
  let count = 0;
  for (let i = skipEdge; i < samples.length - skipEdge; i++) {
    sumSq += samples[i] * samples[i];
    count += 1;
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

describe('Upgraded Audio Capture, Sinc Resampling, Channel Routing, Enhancement, VAD, Dedup, QC & Diagnostics', () => {
  describe('1. 64-Phase Blackman-Sinc Anti-Aliased Resampling (48 kHz & 44.1 kHz -> 16 kHz)', () => {
    it('preserves 1 kHz speech passband from both 48 kHz and 44.1 kHz within [-1, +1] while attenuating 12.5 kHz stopband aliasing by > 55 dB', () => {
      // 1 kHz speech tone @ 48 kHz -> 16 kHz
      const speech48k = generateSine(1000, 48_000, 1.0, 0.5);
      const outFrom48k = downsampleTo16kHz(speech48k, 48_000, 16_000);
      expect(outFrom48k.length).toBe(16_000);
      const inRms = computeRms(speech48k, 200);
      const out48Rms = computeRms(outFrom48k, 200);
      const passbandDiffDb48 = Math.abs(20 * Math.log10(out48Rms / inRms));
      expect(passbandDiffDb48).toBeLessThan(0.25);

      // 1 kHz speech tone @ 44.1 kHz -> 16 kHz via streaming resampler
      const speech44k = generateSine(1000, 44_100, 1.0, 0.5);
      const streamResampler = new StreamingSincResampler(44_100, 16_000);
      const chunks: Float32Array[] = [];
      for (let pos = 0; pos < speech44k.length; pos += 4410) {
        chunks.push(streamResampler.process(speech44k.subarray(pos, pos + 4410)));
      }
      const total44Len = chunks.reduce((acc, c) => acc + c.length, 0);
      expect(Math.abs(total44Len - 16_000)).toBeLessThanOrEqual(32);
      const combined44 = new Float32Array(total44Len);
      let offset = 0;
      for (const c of chunks) {
        combined44.set(c, offset);
        offset += c.length;
      }
      const out44Rms = computeRms(combined44, 200);
      const passbandDiffDb44 = Math.abs(20 * Math.log10(out44Rms / inRms));
      expect(passbandDiffDb44).toBeLessThan(0.25);

      // 12.5 kHz ultrasonic out-of-band tone @ 48 kHz must NOT alias into 3.5 kHz speech band
      const ultrasonic48k = generateSine(12_500, 48_000, 0.5, 0.5);
      const aliasOut = downsampleTo16kHz(ultrasonic48k, 48_000, 16_000);
      const aliasRms = computeRms(aliasOut, 200);
      const stopbandAttenuationDb = 20 * Math.log10(inRms / Math.max(aliasRms, 1e-9));
      expect(stopbandAttenuationDb).toBeGreaterThan(55);

      streamResampler.resetAndZero();
    });
  });

  describe('2. Independent Left/Right Stereo Channel Inspection & Smart Routing', () => {
    it('recovers +6.02 dB on single-sided customer channels and prevents anti-phase cancellation', () => {
      const speech = generateSine(800, 16_000, 0.1, 0.4);
      const silent = new Float32Array(speech.length);

      // Left-only customer voice -> selects Left directly without -6 dB halving
      const leftOnly = inspectAndMixChannels([speech, silent], 'auto');
      expect(leftOnly.inspection.topology).toBe('left-dominant');
      expect(computeRms(leftOnly.mono)).toBeCloseTo(computeRms(speech), 3);

      // Right-only customer voice -> selects Right directly without -6 dB halving
      const rightOnly = inspectAndMixChannels([silent, speech], 'auto');
      expect(rightOnly.inspection.topology).toBe('right-dominant');
      expect(computeRms(rightOnly.mono)).toBeCloseTo(computeRms(speech), 3);

      // Anti-phase stereo (R = -L) -> avoids destructive cancellation to 0!
      const inverted = new Float32Array(speech.length);
      for (let i = 0; i < speech.length; i++) inverted[i] = -speech[i];
      const phaseFixed = inspectAndMixChannels([speech, inverted], 'auto');
      expect(phaseFixed.inspection.topology).toBe('phase-inverted');
      expect(computeRms(phaseFixed.mono)).toBeGreaterThan(computeRms(speech) * 0.9);

      // Dual-independent stereo (agent on L, customer on R) -> preserves both channels
      const customer = generateSine(1350, 16_000, 0.1, 0.35);
      const dual = inspectAndMixChannels([speech, customer], 'auto');
      expect(dual.inspection.topology).toBe('dual-independent');
      expect(computeRms(dual.mono)).toBeGreaterThan(0.15);
    });
  });

  describe('3. Optional, Bypassable In-Memory Audio Clarity Enhancement', () => {
    it('returns exact bit-identical raw PCM when bypassed ("off") and gently normalizes quiet speech without clipping when enabled', () => {
      const quietSpeech = generateSine(1100, 16_000, 0.5, 0.03); // ~ -30.5 dBFS
      const bypassEnhancer = new EphemeralAudioEnhancer('off');
      const bypassed = bypassEnhancer.processChunk16k(quietSpeech.slice());
      expect(bypassed.appliedGainDb).toBe(0);
      for (let i = 0; i < quietSpeech.length; i++) {
        expect(bypassed.samples[i]).toBe(quietSpeech[i]);
      }

      const gentleEnhancer = new EphemeralAudioEnhancer('gentle');
      const enhanced = gentleEnhancer.processChunk16k(quietSpeech.slice());
      const rawRms = computeRms(quietSpeech, 400);
      const enhRms = computeRms(enhanced.samples, 1600);
      expect(enhRms).toBeGreaterThan(rawRms * 1.4); // Boosts quiet speech safely
      for (let i = 0; i < enhanced.samples.length; i++) {
        expect(Math.abs(enhanced.samples[i])).toBeLessThanOrEqual(1.0);
      }

      // Attenuates 35 Hz low-frequency desk rumble via 85 Hz Butterworth HPF
      const rumble = generateSine(35, 16_000, 0.5, 0.25);
      const rumbleEnhancer = new EphemeralAudioEnhancer('gentle');
      const filteredRumble = rumbleEnhancer.processChunk16k(rumble);
      expect(computeRms(filteredRumble.samples, 800)).toBeLessThan(computeRms(rumble, 800) * 0.55);

      gentleEnhancer.resetAndZero();
    });
  });

  describe('4. Speech Segmentation (20s Max, 3.0s Overlap, 1.2s Silence Threshold) & Deduplication', () => {
    it('defaults to 20s / 3.0s / 1.2s, preserves mid-sentence 0.8s pauses, carries 3.0s overlap on 20s splits, and deduplicates 3s multi-word overlaps cleanly', () => {
      expect(DEFAULT_VAD_CONFIG.maxSegmentSec).toBe(20);
      expect(DEFAULT_VAD_CONFIG.overlapSec).toBe(3.0);
      expect(DEFAULT_VAD_CONFIG.silenceSplitSec).toBe(1.2);

      const emitted: SpeechSegmentPayload[] = [];
      const vad = new EphemeralVadSegmenter({
        onSegmentReady: (seg) => emitted.push(seg),
      });

      const voiceChunk = generateSine(900, 16_000, 0.1, 0.15);
      const silentChunk = new Float32Array(1600);

      // 2.0s speech + 0.8s mid-sentence pause + 2.0s speech + 1.3s end-of-sentence pause => 1 unified segment!
      for (let i = 0; i < 20; i++) vad.pushChunk16k(voiceChunk.slice());
      for (let i = 0; i < 8; i++) vad.pushChunk16k(silentChunk.slice()); // 0.8s < 1.2s threshold -> kept intact!
      expect(emitted.length).toBe(0);
      for (let i = 0; i < 20; i++) vad.pushChunk16k(voiceChunk.slice());
      for (let i = 0; i < 13; i++) vad.pushChunk16k(silentChunk.slice()); // 1.3s >= 1.2s -> commits complete sentence
      expect(emitted.length).toBe(1);
      expect(emitted[0].hadBoundaryOverlap).toBe(false);

      // Continuous 22.5s speech -> splits at 20.0s and carries exact 3.0s overlap into segment #2
      emitted.length = 0;
      for (let i = 0; i < 225; i++) vad.pushChunk16k(voiceChunk.slice());
      vad.flushPending();
      expect(emitted.length).toBe(2);
      expect(emitted[0].durationSec).toBeCloseTo(20.0, 1);
      expect(emitted[1].hadBoundaryOverlap).toBe(true);
      expect(emitted[1].overlapDurationSec).toBeCloseTo(3.0, 1);

      // Deduplicate 3-second (~11-word) automotive service booking overlap with minor punctuation variation
      const seg1Text =
        'Good morning calling to book a logbook service for my Mazda CX-5 registration ABC 123 next Tuesday at nine thirty';
      const seg2Raw =
        'for my Mazda CX-5, registration ABC 123 next Tuesday at nine thirty, and my callback number is 0412 345 678.';
      const deduped = deduplicateSegmentDetailed({
        previousSegmentText: seg1Text,
        incomingSegmentText: seg2Raw,
        hadBoundaryOverlap: true,
        overlapDurationSec: 3.0,
      });
      expect(deduped.text).toBe('and my callback number is 0412 345 678.');
      expect(deduped.overlapWordsTrimmed).toBeGreaterThanOrEqual(10);

      // Verify silence hallucinations and degenerate repetition loops are suppressed
      expect(analyzeAndSanitizeWhisperOutput('[BLANK_AUDIO]').cleanedText).toBe('');
      expect(
        analyzeAndSanitizeWhisperOutput('Thank you for watching.').wasHallucinationBlocked,
      ).toBe(true);
      expect(
        analyzeAndSanitizeWhisperOutput('yes yes yes yes yes yes yes').wasRepetitionSuppressed,
      ).toBe(true);
    });
  });

  describe('5. Transcription Quality Control & Real-Time Ephemeral Audio Diagnostics (CXone & Avaya)', () => {
    it('classifies confirmed vs uncertain speech, tracks quality warnings, and updates GREEN/YELLOW/RED + CXone/Avaya indicators ephemerally', () => {
      const qc = new TranscriptionQualityController();
      qc.startSession();

      // Clean segment -> confirmed
      const cleanEval = qc.evaluateTranscribedSegment({
        text: 'I would like to book my Toyota Hilux in for brake pads on Friday.',
        durationSec: 4.5,
        rms: 0.12, // ~ -18.4 dBFS
        peak: 0.45,
        speechBandRatio: 0.78,
        clippedRatio: 0,
        processingMs: 950,
        wasHallucinationBlocked: false,
        wasRepetitionSuppressed: false,
      });
      expect(cleanEval.shouldEmit).toBe(true);
      expect(cleanEval.confidenceTier).toBe('confirmed');
      expect(cleanEval.qualityNote).toBeUndefined();

      // Very quiet segment -> uncertain + quiet warning increment
      const quietEval = qc.evaluateTranscribedSegment({
        text: 'My rego is XZY 987',
        durationSec: 2.2,
        rms: 0.008, // ~ -41.9 dBFS
        peak: 0.02,
        speechBandRatio: 0.65,
        clippedRatio: 0,
        processingMs: 600,
        wasHallucinationBlocked: false,
        wasRepetitionSuppressed: false,
      });
      expect(quietEval.shouldEmit).toBe(true);
      expect(quietEval.confidenceTier).toBe('uncertain');
      expect(qc.getSnapshot().veryQuietSegments).toBe(1);

      // Diagnostics engine: verify separate NICE CXone & Avaya indicators + GREEN health when speech flows
      const diag = new CompatibilityDiagnosticsEngine();
      const idleSnap = diag.getSnapshot();
      expect(idleSnap.realtimeTelemetry.niceCxoneIndicator.color).toBe('IDLE');
      expect(idleSnap.realtimeTelemetry.avayaIndicator.color).toBe('IDLE');

      diag.setProfile('combined');
      diag.startSession({
        hasAudioTrack: true,
        trackLabel: 'System Audio',
        sampleRateHz: 48_000,
        isLive: true,
        captureMode: 'entire-screen-system',
        displaySurface: 'monitor',
        channelCount: 2,
        trackReadyState: 'live',
        trackMuted: false,
      });

      const activeSpeech = generateSine(950, 16_000, 0.2, 0.2);
      const frameStats = analyzeAudioFrame16k(activeSpeech);
      diag.ingestMetrics(
        {
          rms: frameStats.rms,
          peak: frameStats.peak,
          dbfs: frameStats.dbfs,
          peakDbfs: frameStats.peakDbfs,
          leftDbfs: frameStats.dbfs,
          rightDbfs: -85,
          speechBandRatio: 0.82,
          isSpeechActive: true,
          clipping: false,
          channelCount: 2,
          channelTopology: 'left-dominant',
          sourceSampleRate: 48_000,
          enhancementMode: 'gentle',
          enhancementGainDb: 3.2,
        },
        true,
      );

      const snap = diag.getSnapshot();
      expect(snap.realtimeTelemetry.healthColor).toBe('GREEN');
      expect(snap.realtimeTelemetry.niceCxoneIndicator.color).toBe('GREEN');
      expect(snap.realtimeTelemetry.avayaIndicator.color).toBe('GREEN');
      expect(snap.realtimeTelemetry.sampleRateConversionLabel).toContain('48,000 Hz');
      expect(snap.realtimeTelemetry.sampleRateConversionLabel).toContain('16,000 Hz');
      expect(snap.realtimeTelemetry.channelHandlingLabel).toContain('Left-Dominant');

      diag.resetAndClear();
      expect(diag.getSnapshot().realtimeTelemetry.niceCxoneIndicator.color).toBe('IDLE');
    });
  });

  describe('6. Default Whisper Small.en Selection & Dashboard Integration', () => {
    beforeEach(() => {
      clearNetworkAuditSessionLog();
      localStorage.clear();
      sessionStorage.clear();
      mountIndexHtml();
      installMainThreadPrivacyGuards(globalThis);
      installWebAudioMocks();
    });

    it('defaults to Whisper Small (small.en) rather than Tiny, renders diagnostics & QC panels, and cleans up all memory on STOP', async () => {
      expect(DEFAULT_MODEL_KEY).toBe('small.en');
      expect(WHISPER_MODELS['small.en'].modelId).toBe('Xenova/whisper-small.en');
      expect(WHISPER_MODELS['base.en'].modelId).toBe('Xenova/whisper-base.en');

      const controller = new PrivateTranscriberAppController();
      await controller.initialize();

      const modelSelect = document.getElementById('select-model') as HTMLSelectElement;
      expect(modelSelect.value).toBe('small.en');

      const audioTrack = new FakeTrack('audio', 'System Audio', 'monitor');
      const videoTrack = new FakeTrack('video', 'Screen', 'monitor');
      const fakeStream = new FakeMediaStream([audioTrack, videoTrack]);
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getDisplayMedia: vi.fn().mockResolvedValue(fakeStream),
        },
      });

      const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
      const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
      btnStart.click();
      await vi.waitFor(() => {
        expect(document.getElementById('rt-sample-rate')?.textContent).toContain('48,000 Hz');
      });
      expect(btnStop.disabled).toBe(false);

      btnStop.click();
      await vi.waitFor(() => {
        expect(audioTrack.stopCalls).toBeGreaterThanOrEqual(1);
        expect(videoTrack.stopCalls).toBeGreaterThanOrEqual(1);
      });

      // Verify zero browser storage persistence after session
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });
  });
});
