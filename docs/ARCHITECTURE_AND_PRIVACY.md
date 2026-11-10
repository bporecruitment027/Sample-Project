# Technical Architecture, Local AI Processing & Privacy Verification

## 1. How Windows System Output Audio Is Captured in Chrome

1. **Explicit User Gesture Only (`navigator.mediaDevices.getDisplayMedia`)**
   - No audio capture runs on page load, refresh, or in the background.
   - Only when the user clicks **START TRANSCRIPTION** (or **Test Audio Only**) does `SystemAudioCaptureController` invoke:
     ```ts
     navigator.mediaDevices.getDisplayMedia({
       video: { displaySurface: 'monitor', frameRate: { ideal: 1, max: 5 }, width: { max: 320 }, height: { max: 240 } },
       audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
       systemAudio: 'include',
       selfBrowserSurface: 'exclude',
       surfaceSwitching: 'exclude',
     });
     ```
   - On Windows, Chrome uses Windows Audio Session API (**WASAPI loopback**) on the active Windows playback output when the user selects **Entire Screen → Also share system audio → Share**.

2. **Video Track Isolation (Zero Frame Extraction)**
   - Chrome's Screen Capture API requires `video` to be requested when sharing system audio (`getDisplayMedia({ video: false, audio: true })` throws `TypeError` per the W3C Screen Capture spec).
   - Immediately upon receiving the `MediaStream`, the application sets `videoTrack.enabled = false` and **never** attaches the video track to any `<video>`, `<canvas>`, `ImageCapture`, `MediaStreamTrackProcessor`, or `MediaRecorder`.
   - Only `ended` event listeners are attached so clicking Chrome's native **Stop sharing** banner immediately triggers full session cleanup.

3. **Audio Track Validation & No-Microphone Rule**
   - The returned `MediaStream` is checked via `stream.getAudioTracks()`.
   - If `audioTracks.length === 0` or `readyState === 'ended'`, all tracks are immediately stopped and a clear diagnostic explanation is shown (including Windows playback vs. communications endpoint guidance for NICE CXone and Avaya).
   - `navigator.mediaDevices.getUserMedia` (microphone) is never called and is actively blocked at runtime by `src/privacy/networkGuard.ts` and the `Permissions-Policy: microphone=()` header.

4. **Web Audio API & `AudioWorklet` Pipeline (`public/audio-capture-worklet.js`)**
   - An audio-only `MediaStream` (`new MediaStream([primaryAudioTrack])`) feeds `MediaStreamAudioSourceNode` → `AudioWorkletNode('ephemeral-pcm-capture-processor')` → zero-gain `GainNode(0.0)` → `AudioContext.destination`.
   - Routing through `GainNode(0.0)` keeps Chromium's pull-based Web Audio graph executing every 128-frame render quantum reliably while guaranteeing **0.000 audible loopback** (zero echo into the user's headset).
   - Inside `AudioWorkletProcessor`:
     - Multi-channel desktop audio is averaged to mono.
     - An anti-aliasing boxcar resampler converts hardware sample rates (e.g., `48,000 Hz` or `44,100 Hz`) to `16,000 Hz` mono `Float32Array` PCM.
     - Instantaneous scalar metrics (`rms`, `peak`, `300–3400 Hz` telephony voice-band energy ratio, `clipping`) are emitted every `50 ms` (`800` samples) for the Live Audio Indicator and Softphone Diagnostics — storing **zero** waveform history.
     - Short `100 ms` (`1,600` sample = `6.4 KB`) PCM chunks are transferred via zero-copy `ArrayBuffer` ownership transfer (`[outgoing.buffer]`) to `EphemeralVadSegmenter`.
     - While **PAUSED**, the worklet discards all incoming audio frames immediately without buffering.

---

## 2. How the Local Whisper AI Model Processes Audio in the Browser

1. **Voice Activity Detection (VAD) & Ephemeral Segmentation (`src/audio/vadSegmenter.ts`)**
   - Incoming `100 ms` chunks at `16 kHz` are evaluated using RMS hysteresis + telephony speech-band energy (`300–3400 Hz`).
   - Only a `0.45 s` (`7,200` sample) pre-roll ring buffer and the current active utterance (up to `12.0 s` max = `192,000` samples = `768 KB` RAM) are held temporarily.
   - Utterances split cleanly on natural conversational pauses (`0.65 s` of silence). If continuous speech exceeds `12.0 s` without a pause, the segment flushes with a `0.8 s` boundary overlap tail so words straddling the split are not cut mid-syllable.
   - Evicted pre-roll chunks and merged source chunks are immediately overwritten with `0.0` (`Float32Array.fill(0)`).

2. **Dedicated Web Worker & Local ONNX Inference (`src/workers/whisper.worker.ts`)**
   - Completed speech segments are queued sequentially (`LocalWhisperEngine`, bounded cap of 5 segments with backpressure warnings at 3+ queued segments) and transferred (`[samples.buffer]`) to a dedicated Web Worker so the main UI thread never freezes.
   - Inside the worker, Hugging Face `@huggingface/transformers` (`v4.3.2`) + `onnxruntime-web` runs **OpenAI Whisper** ONNX encoder-decoder inference entirely locally:
     - **WebGPU Mode (when hardware adapter & shaders succeed)**: `encoder_model` in `fp32` + `decoder_model_merged` in `q4` 4-bit block quantization, accelerated on the local GPU.
     - **WebAssembly Mode (automatic CPU fallback)**: `q8` 8-bit quantized encoder + decoder executed via local SIMD WebAssembly (`ort-wasm-simd-threaded.asyncify.wasm` served from `'self'`).
   - Inside the worker's `finally` block, `audio.fill(0)` wipes the segment's PCM buffer immediately after token decoding completes.

3. **Hallucination Filtering & Overlap Deduplication (`src/audio/deduplicator.ts`)**
   - Non-speech Whisper tags (`[BLANK_AUDIO]`, `(music)`, `[inaudible]`), caption-training artifacts (`"Thank you for watching"`, `"Subtitles by Amara.org"`), and degenerate 5x token-repetition loops are suppressed so text is never fabricated during silence or hold tones.
   - When `hadBoundaryOverlap === true`, exact normalized suffix-prefix token matching removes repeated boundary words before rendering via `element.textContent`.

---

## 3. External Software Assets Downloaded by the Browser

No third-party JavaScript CDNs, fonts, icons, or analytics scripts are loaded. Application code, CSS, `AudioWorklet`, and ONNX Runtime WebAssembly binaries (`ort-wasm-simd-threaded.asyncify.{mjs,wasm}`) are served directly from `'self'` (same origin).

Only the open-source Whisper ONNX model software files are fetched via read-only `GET` requests from Hugging Face Hub (`https://huggingface.co` / redirect CDN `https://*.hf.co`):

| Model Option | Hugging Face Repository | License | Files Downloaded (Read-Only `GET`) | Approx. Size |
|---|---|---|---|---|
| **Whisper Base.en (Default)** | `onnx-community/whisper-base.en` | MIT | `config.json`, `generation_config.json`, `tokenizer.json`, `tokenizer_config.json`, `preprocessor_config.json`, plus `onnx/encoder_model_quantized.onnx` & `onnx/decoder_model_merged_quantized.onnx` (WASM `q8`) OR `onnx/encoder_model.onnx` & `onnx/decoder_model_merged_q4.onnx` (WebGPU) | ~78 MB (WASM `q8`) / ~196 MB (WebGPU) |
| **Whisper Tiny.en (Fallback)** | `onnx-community/whisper-tiny.en` | MIT | Same file structure as above for the 39M-parameter Tiny English architecture | ~42 MB (WASM `q8`) / ~108 MB (WebGPU) |

**Caching Disclosure:** Application-managed persistent caching (`env.useBrowserCache = false`, `env.useWasmCache = false`) is disabled so nothing is written to Chrome `Cache Storage`. Normal browser-managed HTTP caching of static website and model software files may occur; if Chrome evicts HTTP cache entries across sessions, model software weights will re-download on a new session.

---

## 4. Privacy Verification Checklist

Use Chrome Developer Tools (**F12**) alongside the built-in **Verify Privacy & Storage Now** audit button to verify independently:

- [ ] **Zero External Audio or Text Uploads:** Open **DevTools → Network**. During active speech transcription, confirm **0** requests are made while speaking (or filter by `Method: POST` / `WS` — must be empty). Every request during startup/preload is `GET` with `0 bytes` request payload.
- [ ] **Zero Cloud Transcription Endpoints:** Confirm no requests ever contact `googleapis.com`, `openai.com`, `microsoft.com`, `azure.com`, `deepgram.com`, `assemblyai.com`, `rev.ai`, `niceincontact.com`, or `avaya.com`. (Enforced by both CSP `connect-src` and `src/privacy/networkGuard.ts`.)
- [ ] **Zero Audio Recordings:** `window.MediaRecorder` is blocked at runtime; no `.wav`, `.mp3`, `.webm`, or `.ogg` blobs or download links are ever created.
- [ ] **Zero Persistent Browser Storage:** Open **DevTools → Application → Storage** during and after a transcription session and verify:
  - `Local storage`: `0` keys
  - `Session storage`: `0` keys
  - `IndexedDB`: `0` databases
  - `Cookies`: `0` cookies
  - `Cache storage`: `0` caches
  - `Origin Private File System (OPFS)`: empty
  - `Service workers`: `0` registrations
- [ ] **Immediate Session & Reload Cleanup:** Click **STOP** (or refresh the tab) and confirm Chrome's screen-sharing bar disappears immediately, the transcript vanishes from the DOM, timers reset to `00:00:00`, and refreshing does not restore any transcript or restart capture.

---

## 5. Known Technical Limitations

1. **Windows Audio Endpoint Routing (Playback vs. Communications Device):** Chrome's `getDisplayMedia` captures Windows' active playback mix via WASAPI loopback. If NICE CXone or Avaya routes call audio to an isolated secondary USB/Bluetooth headset assigned only as the Windows *Default Communications Device* while Windows' primary *Output Device* is set to another speaker, Chrome receives an audio track containing silence (`-100 dBFS`). Selecting the headset as the active output device in the standard Windows taskbar volume flyout (no administrator privileges required) resolves this.
2. **Entire Screen Selection Requirement on Windows:** On Windows Chrome, system audio loopback is only offered when sharing **Entire Screen** (or a Chrome Tab), not when sharing an individual Win32 desktop window. Users must select **Entire Screen** and toggle **Also share system audio**.
3. **Single Mixed Output Channel (`SYSTEM AUDIO`):** Desktop output capture receives the combined audio stream sent to the headset. When the agent's own sidetone is not played through Windows output, only customer/system audio is present; if both voices play through output, local single-channel Whisper cannot reliably separate speaker identities without guesswork, so all segments use the honest neutral label `SYSTEM AUDIO`.
4. **Model Re-Download Trade-Off:** Because `Cache Storage` (`env.useBrowserCache = false`) is disabled for strict zero-persistence compliance, if Chrome's standard HTTP cache expires or is cleared, the ~42–78 MB Whisper software weights must be downloaded again when starting a new session.
5. **Segment Processing Latency on CPU-Only Office PCs:** Without WebGPU hardware acceleration, CPU WebAssembly (`q8`) typically requires ~1.5–4 seconds to transcribe a completed sentence segment. Switching to **Whisper Tiny.en** reduces CPU latency by ~2–2.5x.
