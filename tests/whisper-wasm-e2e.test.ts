// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deduplicateOverlapText } from '../src/audio/deduplicator.ts';
import {
  downsampleTo16kHz,
  mixChannelsToMono,
  secureZeroFloat32,
} from '../src/audio/dsp.ts';
import {
  EphemeralVadSegmenter,
  type SpeechSegmentPayload,
} from '../src/audio/vadSegmenter.ts';

const FIXTURE_WAV = '/tmp/plt-whisper-fixture/jfk.wav';
const FIXTURE_MODELS_ROOT = '/tmp/plt-whisper-fixture/package/models';
const HAS_LOCAL_FIXTURE =
  fs.existsSync(FIXTURE_WAV) &&
  fs.existsSync(path.join(FIXTURE_MODELS_ROOT, 'Xenova/whisper-tiny/config.json'));

function decodePcm16Wav(wavBytes: Buffer): { sampleRate: number; samples: Float32Array } {
  let offset = 12;
  let sampleRate = 16_000;
  let numChannels = 1;
  let pcmOffset = -1;
  let pcmByteLength = 0;

  while (offset + 8 <= wavBytes.length) {
    const chunkId = wavBytes.toString('ascii', offset, offset + 4);
    const chunkSize = wavBytes.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      numChannels = wavBytes.readUInt16LE(offset + 10);
      sampleRate = wavBytes.readUInt32LE(offset + 12);
    } else if (chunkId === 'data') {
      pcmOffset = offset + 8;
      pcmByteLength = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (pcmOffset < 0) {
    throw new Error('Invalid WAV file: missing data chunk');
  }

  const totalInt16 = Math.floor(pcmByteLength / 2);
  const frameCount = Math.floor(totalInt16 / numChannels);
  const mono = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const idx = pcmOffset + (i * numChannels + ch) * 2;
      sum += wavBytes.readInt16LE(idx) / 32768;
    }
    mono[i] = sum / numChannels;
  }

  return { sampleRate, samples: mono };
}

describe('Test 4 — Real End-to-End Local Whisper ONNX WebAssembly Transcription', () => {
  it.skipIf(!HAS_LOCAL_FIXTURE)(
    'captures simulated 48 kHz stereo system audio, downsamples & segments via VAD, transcribes real English speech locally via ONNX Runtime WebAssembly with 0 external network calls, and zeroes all buffers',
    async () => {
      // Import the exact browser build of @huggingface/transformers in pure browser mode (IS_NODE_ENV = false)
      const webBundlePath = path.resolve(
        process.cwd(),
        'node_modules/@huggingface/transformers/dist/transformers.web.js',
      );
      const savedRelease = process.release;
      Object.defineProperty(process, 'release', { value: undefined, configurable: true });
      let transformersMod: typeof import('@huggingface/transformers');
      try {
        transformersMod = (await import(
          pathToFileURL(webBundlePath).href
        )) as typeof import('@huggingface/transformers');
      } finally {
        Object.defineProperty(process, 'release', { value: savedRelease, configurable: true });
      }
      const { env, pipeline } = transformersMod;

      const wasmDir = path.resolve(process.cwd(), 'public/wasm');
      const wasmBinaryBytes = fs.readFileSync(
        path.join(wasmDir, 'ort-wasm-simd-threaded.asyncify.wasm'),
      );
      const wasmMjsFileUrl = pathToFileURL(
        path.join(wasmDir, 'ort-wasm-simd-threaded.asyncify.mjs'),
      ).href;

      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.remoteHost = 'https://local-static.test/models/';
      env.remotePathTemplate = '{model}/';
      env.useBrowserCache = false;
      env.useWasmCache = false;
      env.useFSCache = false;

      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmBinary = wasmBinaryBytes.buffer.slice(
          wasmBinaryBytes.byteOffset,
          wasmBinaryBytes.byteOffset + wasmBinaryBytes.byteLength,
        );
        env.backends.onnx.wasm.wasmPaths = {
          mjs: wasmMjsFileUrl,
          wasm: pathToFileURL(path.join(wasmDir, 'ort-wasm-simd-threaded.asyncify.wasm')).href,
        };
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
      }

      // Serve ONLY local static model files from /tmp/plt-whisper-fixture; reject ANY external call!
      let externalNetworkCalls = 0;
      let readOnlyModelFetches = 0;

      env.fetch = async (input: string | URL) => {
        const urlStr = typeof input === 'string' ? input : input.href;
        if (!urlStr.startsWith('https://local-static.test/models/')) {
          externalNetworkCalls += 1;
          throw new Error(`Unexpected external fetch blocked: ${urlStr}`);
        }
        readOnlyModelFetches += 1;
        const rel = urlStr.slice('https://local-static.test/models/'.length).split('?')[0];
        const diskPath = path.join(FIXTURE_MODELS_ROOT, rel);
        if (!fs.existsSync(diskPath)) {
          return new Response('Not Found', { status: 404 });
        }
        const bytes = fs.readFileSync(diskPath);
        return new Response(bytes, {
          status: 200,
          headers: {
            'Content-Length': String(bytes.byteLength),
            'Content-Type': diskPath.endsWith('.json')
              ? 'application/json'
              : 'application/octet-stream',
          },
        });
      };

      // 1. Read real English speech WAV and expand to 48 kHz 2-channel stereo (Windows WASAPI output format)
      const wavBuf = fs.readFileSync(FIXTURE_WAV);
      const decoded = decodePcm16Wav(wavBuf);
      const stereo48kLeft = new Float32Array(decoded.samples.length * 3);
      const stereo48kRight = new Float32Array(decoded.samples.length * 3);
      for (let i = 0; i < decoded.samples.length; i++) {
        const s = decoded.samples[i];
        stereo48kLeft[i * 3] = s;
        stereo48kLeft[i * 3 + 1] = s;
        stereo48kLeft[i * 3 + 2] = s;
        stereo48kRight[i * 3] = s;
        stereo48kRight[i * 3 + 1] = s;
        stereo48kRight[i * 3 + 2] = s;
      }

      // 2. Mix stereo -> mono and anti-alias downsample 48 kHz -> 16 kHz using our real DSP functions
      const mono48k = mixChannelsToMono([stereo48kLeft, stereo48kRight]);
      const resampled16k = downsampleTo16kHz(mono48k, 48_000, 16_000);
      secureZeroFloat32(stereo48kLeft);
      secureZeroFloat32(stereo48kRight);
      secureZeroFloat32(mono48k);

      // 3. Push 100 ms (1,600-sample) chunks into our real EphemeralVadSegmenter
      const segments: SpeechSegmentPayload[] = [];
      const vad = new EphemeralVadSegmenter({
        onSegmentReady: (seg) => segments.push(seg),
      });

      for (let offset = 0; offset < resampled16k.length; offset += 1600) {
        const slice = resampled16k.slice(offset, Math.min(offset + 1600, resampled16k.length));
        vad.pushChunk16k(slice);
      }
      for (let i = 0; i < 8; i++) {
        vad.pushChunk16k(new Float32Array(1600));
      }
      secureZeroFloat32(resampled16k);

      expect(segments.length).toBeGreaterThanOrEqual(1);

      // 4. Initialize browser Whisper ONNX pipeline on WebAssembly (device: 'wasm', dtype: 'q8')
      const transcriber = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny',
        {
          device: 'wasm',
          dtype: 'q8',
        },
      );

      // 5. Sequentially transcribe each VAD speech segment, deduplicate overlaps, and zero buffers
      let previousText = '';
      const finalTranscriptParts: string[] = [];

      for (const seg of segments) {
        const out = await transcriber(seg.samples, {
          language: 'english',
          task: 'transcribe',
          return_timestamps: false,
          max_new_tokens: 128,
        });
        secureZeroFloat32(seg.samples);
        expect(seg.samples.every((v) => v === 0)).toBe(true);

        const rawText = Array.isArray(out) ? out.map((x) => x.text).join(' ') : out.text;
        const cleaned = deduplicateOverlapText(
          previousText,
          rawText,
          seg.hadBoundaryOverlap,
        );
        if (cleaned) {
          previousText = cleaned;
          finalTranscriptParts.push(cleaned);
        }
      }

      await transcriber.dispose();
      vad.clearAndZero();

      const fullTranscript = finalTranscriptParts.join(' ').toLowerCase();
      expect(externalNetworkCalls).toBe(0);
      expect(readOnlyModelFetches).toBeGreaterThan(0);
      expect(fullTranscript).toContain('fellow americans');
      expect(fullTranscript).toContain('ask not what your country can do for you');
      expect(fullTranscript).toContain('what you can do for your country');
    },
    120_000,
  );
});
