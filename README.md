# Private Live Transcriber

**Privacy-first, browser-only Windows system audio live transcription web application.**

Designed specifically for locked-down Windows desktops running **Google Chrome (v157+)** alongside desktop softphones (**NICE CXone**, **Avaya**, or both) where the user has **no administrator privileges**, **cannot install desktop software, virtual audio cables, or Chrome extensions**, and requires **100% local in-browser speech recognition** with **zero recordings, zero cloud APIs, and zero persistent data retention**.

---

## Core Architecture & Privacy Guarantees

- **Windows System Audio Capture (`getDisplayMedia`):** Captures desktop output audio when the user explicitly clicks **START TRANSCRIPTION** and selects **Entire Screen → Also share system audio → Share**. Never uses or falls back to microphone capture (`getUserMedia` is disabled at both HTTP `Permissions-Policy` and JS runtime levels). Never extracts, renders, or records screen video frames.
- **100% Local Whisper AI Inference (`@huggingface/transformers` + `onnxruntime-web`):** Runs OpenAI Whisper English ONNX models (`onnx-community/whisper-base.en` default; `onnx-community/whisper-tiny.en` fast fallback) inside a dedicated **Web Worker** using **WebGPU** hardware acceleration when available or **WebAssembly (CPU SIMD `q8`)** fallback.
- **Ephemeral RAM-Only Processing:**
  - `AudioWorkletProcessor` (`public/audio-capture-worklet.js`) mixes multi-channel audio to mono, anti-alias downsamples `48 kHz / 44.1 kHz → 16 kHz`, and emits scalar level/clarity telemetry without retaining waveform history.
  - `EphemeralVadSegmenter` (`src/audio/vadSegmenter.ts`) buffers only the active spoken phrase (`<= 12 s`, `~768 KB`), splits on pauses (`0.65 s`) or long-utterance overlap (`0.8 s`), transfers `ArrayBuffer` ownership to the Web Worker, and overwrites every processed or discarded `Float32Array` with `0.0`.
- **Zero Exfiltration & Zero Storage:**
  - Strict Content Security Policy (`connect-src 'self' https://huggingface.co https://*.hf.co https://*.huggingface.co`) + runtime `networkGuard.ts` block all `POST`/`PUT` requests, request bodies, `WebSocket`, `EventSource`, `sendBeacon`, `RTCPeerConnection`, `MediaRecorder`, `ServiceWorker`, cloud STT providers, and phone-system APIs.
  - Application-managed persistent model caching (`env.useBrowserCache = false`, `env.useWasmCache = false`) is disabled so `0` entries are written to `localStorage`, `sessionStorage`, `IndexedDB`, `Cookies`, `Cache Storage`, or `OPFS`.
- **Complete 11-Step Session Cleanup:** Clicking **STOP**, closing/refreshing the tab, or clicking Chrome's external **Stop sharing** banner immediately stops all media tracks, disconnects Web Audio nodes, closes `AudioContext`, terminates the `AudioWorklet` and Whisper `Worker`, zeroes pending PCM buffers, and erases all transcript DOM/memory state.
- **Independent NICE CXone & Avaya Audio Diagnostics:** Includes local diagnostic test labels (`NICE CXone Test`, `Avaya Test`, `Combined Audio Test`) with 6-point live audio track, signal energy, `300–3400 Hz` speech-band clarity, stability, and hold-silence verification — with zero integration or interference with either phone system.

---

## Project Structure

```text
├── index.html                           # Application UI shell + build-injected strict CSP
├── public/
│   ├── audio-capture-worklet.js         # Ephemeral 16 kHz mono AudioWorkletProcessor
│   └── _headers                         # Static host security & WASM MIME headers
├── scripts/
│   └── prepare-wasm.mjs                 # Copies ONNX Runtime Web WASM assets to public/wasm/
├── src/
│   ├── main.ts                          # Installs privacy guards & mounts controller
│   ├── config/models.ts                 # Whisper Base.en / Tiny.en specs & input validation
│   ├── privacy/
│   │   ├── networkGuard.ts              # Runtime outbound network, recording & mic blocker
│   │   └── storageAudit.ts              # Live browser storage & local-engine verifier
│   ├── audio/
│   │   ├── dsp.ts                       # Stereo->mono, 16 kHz resampler, 300–3400 Hz filter
│   │   ├── vadSegmenter.ts              # Ephemeral VAD segmenter + secure buffer zeroing
│   │   ├── deduplicator.ts              # Overlap boundary dedup + hallucination suppression
│   │   ├── systemAudioCapture.ts        # Chrome getDisplayMedia + Web Audio lifecycle
│   │   └── compatibilityDiagnostics.ts  # NICE CXone & Avaya 6-point audio diagnostics
│   ├── transcription/
│   │   ├── whisperEngine.ts             # Sequential bounded worker queue & backpressure
│   │   └── workerProtocol.ts            # Typed main <-> worker message contracts
│   ├── workers/
│   │   └── whisper.worker.ts            # Local Whisper ONNX WebGPU / WASM inference worker
│   ├── ui/
│   │   ├── appController.ts             # Safe textContent UI state machine & 11-step cleanup
│   │   └── levelMeter.ts                # Scalar-only live audio & voice-band canvas meter
│   └── styles/main.css                  # Enterprise neutral dark-on-light desktop layout
├── tests/                               # 6 Vitest suites (20 tests, incl. real WASM Whisper E2E)
└── docs/
    ├── ARCHITECTURE_AND_PRIVACY.md      # Detailed audio, local ML, external assets & privacy checklist
    ├── DEPLOYMENT_GUIDE.md              # Static HTTPS deployment (Netlify, GitHub Pages, Nginx)
    └── TESTING_AND_COMPATIBILITY_REPORT.md # 8-test manual guide + Final Compatibility Report
```

---

## Development, Build & Test Commands

> End users only open the deployed HTTPS webpage in Google Chrome and do **not** install Node.js or any software.

```bash
# Install development dependencies (postinstall scripts disabled via .npmrc)
npm install

# Run all 6 automated test suites (20 tests)
npm test

# Build production static bundle into dist/
npm run build

# Serve compiled static bundle locally
npm run preview
```

---

## Documentation

- [Technical Architecture, Local AI Processing, External Assets & Privacy Checklist](./docs/ARCHITECTURE_AND_PRIVACY.md)
- [Static HTTPS Deployment Guide](./docs/DEPLOYMENT_GUIDE.md)
- [Testing Instructions & Final Compatibility Report](./docs/TESTING_AND_COMPATIBILITY_REPORT.md)
