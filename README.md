# Private Live Transcriber

**Privacy-first, browser-only Windows system audio live transcription web application.**

Designed specifically for locked-down Windows desktops running **Google Chrome (v157+)** alongside desktop softphones (**NICE CXone**, **Avaya**, or both) in Australian automotive customer-service environments where the user has **no administrator privileges**, **cannot install desktop software, virtual audio cables, or Chrome extensions**, and requires **100% local in-browser speech recognition** with **zero recordings, zero cloud APIs, and zero persistent data retention**.

---

## Core Architecture, Accuracy Upgrades & Privacy Guarantees

- **Windows System Audio Capture (`getDisplayMedia`, Modes A / B / C):**
  - Supports **Mode A: Entire Screen + System Audio** (recommended WASAPI loopback on Windows), **Mode B: Application Window + Application Audio** (where supported by Windows 11 / Chrome), and **Mode C: Window + System Audio**.
  - Inspects `MediaStreamTrack` settings (`sampleRate`, `channelCount`, `readyState`, `muted`, `displaySurface`) and verifies actual speech energy.
  - **Never** uses or falls back to microphone capture (`getUserMedia` is disabled at both HTTP `Permissions-Policy` and JS runtime levels). **Never** extracts, renders, or saves screen video frames.
- **High-Precision 16 kHz DSP, Smart Stereo Routing & Optional Speech Clarity:**
  - `AudioWorkletProcessor` (`public/audio-capture-worklet.js`) & `src/audio/dsp.ts` inspect Left and Right channels independently (`Smart Auto` recovers `+6.02 dB` on single-sided customer channels and prevents anti-phase cancellation) and convert `48 kHz / 44.1 kHz` audio to genuine `16,000 Hz` `Float32Array` (`[-1.0, +1.0]`) via a **64-phase Blackman-windowed sinc anti-aliasing resampler** (`>55 dB` stopband rejection).
  - `EphemeralAudioEnhancer` (`src/audio/enhancement.ts`) provides optional, adjustable, **bypassable** in-memory speech conditioning (`Gentle Clarity`, `Quiet Call Boost`, or `Raw Bypass (Off)` for A/B comparison) using an `85 Hz` rumble HPF, `+1.6 dB` `1.85 kHz` consonant presence shelf, `-19 dBFS` safe RMS normalization, and soft-knee peak limiting — never applying destructive mic noise suppression or echo cancellation.
- **100% Local Whisper AI Inference (`@huggingface/transformers` + `onnxruntime-web`):**
  - Runs **Whisper Small (`Xenova/whisper-small.en`, preferred default)** or **Whisper Base (`Xenova/whisper-base.en`, balanced CPU fallback)** inside a dedicated **Web Worker** using **WebGPU** (`fp32` encoder + `q8` decoder) or **WebAssembly (`q8` SIMD)** fallback (`Xenova/whisper-tiny.en` retained strictly as an emergency low-resource fallback).
  - Tuned for Australian & international English telephony speech, customer names, vehicle makes/models, alphanumeric rego numbers, booking dates/times, and phone numbers, distinguishing **`CONFIRMED`** vs **`UNCERTAIN — VERIFY`** segments without guessing or inventing words.
- **Sentence-Preserving Segmentation, 3s Overlap Deduplication & Quality Control:**
  - `EphemeralVadSegmenter` (`src/audio/vadSegmenter.ts`) defaults to **`20s` max segment**, **`3.0s` overlap**, **`1.2s` silence threshold** (`1.0–1.5s` live-adjustable), `0.65s` pre-roll, and `0.45s` post-roll tail, transferring `ArrayBuffer` ownership to the sequential worker queue and zeroing (`Float32Array.fill(0)`) all buffers after use.
  - `deduplicator.ts` combines Whisper chunk timestamps (`return_timestamps: true`) with up to 24-word exact/fuzzy boundary alignment and hallucination/loop suppression.
  - **Real-Time Audio Diagnostics** (`GREEN` / `YELLOW` / `RED` + separate **NICE CXone** & **Avaya** indicators) and **Transcription Quality Control** monitor dBFS levels, clipping, silence, latency, repetitions, and dropped segments ephemerally with zero stored history.
- **Zero Exfiltration, Zero Storage & Complete 11-Step Cleanup:**
  - Strict CSP (`connect-src 'self' https://huggingface.co https://*.hf.co https://*.huggingface.co`) + runtime `networkGuard.ts` block all `POST`/`PUT` requests, request bodies, `WebSocket`, `EventSource`, `sendBeacon`, `RTCPeerConnection`, `MediaRecorder`, `ServiceWorker`, cloud STT APIs, and phone-system APIs.
  - `0` entries written to `localStorage`, `sessionStorage`, `IndexedDB`, `Cookies`, `Cache Storage`, or `OPFS`; clicking **STOP**, closing/reloading the tab, or clicking Chrome's **Stop sharing** banner immediately wipes all media tracks, Web Audio nodes, workers, PCM buffers, and transcript DOM.

---

## Project Structure

```text
├── index.html                           # Application UI shell + build-injected strict CSP
├── public/
│   ├── audio-capture-worklet.js         # Smart L/R routing + 64-phase Blackman-sinc 16 kHz AudioWorklet
│   └── _headers                         # Static host security & WASM MIME headers
├── scripts/
│   └── prepare-wasm.mjs                 # Copies ONNX Runtime Web WASM assets to public/wasm/
├── src/
│   ├── main.ts                          # Installs privacy guards & mounts controller
│   ├── config/models.ts                 # Whisper Small.en / Base.en / Tiny.en, capture & VAD configs
│   ├── privacy/
│   │   ├── networkGuard.ts              # Runtime outbound network, recording & mic blocker
│   │   └── storageAudit.ts              # Live browser storage & local-engine verifier
│   ├── audio/
│   │   ├── dsp.ts                       # Smart L/R inspection, 64-phase Blackman-sinc 16 kHz resampler
│   │   ├── enhancement.ts               # Optional, bypassable in-memory 16 kHz speech clarity enhancer
│   │   ├── vadSegmenter.ts              # 20s / 3s / 1.2s VAD segmenter + secure buffer zeroing
│   │   ├── deduplicator.ts              # Timestamp + 24-word overlap dedup & hallucination filter
│   │   ├── systemAudioCapture.ts        # Chrome Screen/Window capture modes A/B/C + Web Audio lifecycle
│   │   └── compatibilityDiagnostics.ts  # 14-metric Real-Time Diagnostics + NICE CXone & Avaya badges
│   ├── transcription/
│   │   ├── qualityControl.ts            # Confirmed/uncertain classifier & quality warning monitor
│   │   ├── whisperEngine.ts             # Sequential bounded worker queue & backpressure
│   │   └── workerProtocol.ts            # Typed main <-> worker message contracts
│   ├── workers/
│   │   └── whisper.worker.ts            # Local Whisper ONNX WebGPU / WASM inference worker
│   ├── ui/
│   │   ├── appController.ts             # Safe textContent UI state machine & 11-step cleanup
│   │   └── levelMeter.ts                # Scalar-only live audio & voice-band canvas meter
│   └── styles/main.css                  # Enterprise neutral dark-on-light desktop layout
├── tests/                               # 7 Vitest suites (26 tests, incl. real WASM Whisper E2E)
└── docs/
    ├── AUDIO_AUDIT_AND_ACCURACY_BENCHMARKS.md # 14-point audit, root causes & before/after benchmarks
    ├── ARCHITECTURE_AND_PRIVACY.md      # Detailed audio, local ML, external assets & privacy checklist
    ├── DEPLOYMENT_GUIDE.md              # Static HTTPS deployment (GitHub Pages, Netlify, Vercel)
    └── TESTING_AND_COMPATIBILITY_REPORT.md # Windows Chrome 157 testing guide & compatibility report
```

---

## Development, Build & Test Commands

> End users only open the deployed HTTPS webpage in Google Chrome and do **not** install Node.js or any software.

```bash
# Install development dependencies (postinstall scripts disabled via .npmrc)
npm ci --ignore-scripts

# Build production static bundle into dist/ (prepares WASM + TypeScript check + Vite build)
npm run build

# Run all 7 automated test suites (26 tests)
npm test

# Serve compiled static bundle locally
npm run preview
```

---

## Documentation

- [Audio Capture & Transcription Accuracy Audit & Benchmark Report](./docs/AUDIO_AUDIT_AND_ACCURACY_BENCHMARKS.md)
- [Technical Architecture, Local AI Processing, External Assets & Privacy Checklist](./docs/ARCHITECTURE_AND_PRIVACY.md)
- [Static HTTPS Deployment Guide](./docs/DEPLOYMENT_GUIDE.md)
- [Testing Instructions & Final Compatibility Report](./docs/TESTING_AND_COMPATIBILITY_REPORT.md)
