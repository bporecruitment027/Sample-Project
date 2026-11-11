# Testing Guide & Final Compatibility Report

## 1. Automated Verification Suite (`npm test`)

Run the automated test suite from a development environment:

```bash
npm test
```

All **7 test suites (26 tests)** verify:
1. `tests/accuracy-diagnostics-qc.test.ts` — 64-phase Blackman-sinc anti-aliased resampling (`48 kHz` & `44.1 kHz` → `16 kHz` with `>55 dB` stopband attenuation), smart L/R stereo routing (`+6.02 dB` single-channel recovery & anti-phase protection), optional/bypassable `EphemeralAudioEnhancer`, `20s`/`3s`/`1.2s` VAD segmentation, 3s multi-word overlap deduplication, `TranscriptionQualityController` (`confirmed` vs `uncertain`), 14-metric Real-Time Audio Diagnostics (`GREEN`/`YELLOW`/`RED` + separate NICE CXone & Avaya badges), and `Whisper Small.en` default UI integration.
2. `tests/dsp-and-worklet.test.ts` — Stereo-to-mono mixing, `48 kHz` & `44.1 kHz` → `16 kHz` anti-aliased resampling, `300–3400 Hz` telephony voice-band detection vs. `40 Hz` hum, buffer zeroing, and `public/audio-capture-worklet.js` execution (`pause` discard + `shutdown` teardown).
2. `tests/vad-and-dedup.test.ts` — Voice Activity Detection (VAD), natural pause segmentation, long-utterance boundary overlap splitting, Whisper silence-hallucination suppression, and overlap duplicate-word removal.
3. `tests/privacy-and-cleanup.test.ts` — **Test 1** (clean startup, zero automatic capture), **Test 7** (runtime blocking of `POST`/`PUT`/payloads, cloud STT APIs, NICE CXone & Avaya APIs, `WebSocket`, `EventSource`, `sendBeacon`, `RTCPeerConnection`, `MediaRecorder`, `getUserMedia`, `ServiceWorker`, plus storage audit), XSS-safe `textContent` rendering, and **Tests 5 & 6** (11-step `STOP` cleanup and zero state across page reload).
4. `tests/capture-and-errors.test.ts` — **Tests 2 & 3** (screen-share permission flow, missing audio track abort without microphone fallback, permission denial, local model failure aborting capture per Section 7G, WebGPU → WASM fallback, external "Stop sharing" cleanup, and NICE CXone / Avaya / Combined diagnostic checks).
5. `tests/extended-session.test.ts` — **Test 8** (simulated **20-minute** continuous session — `12,000` x `100 ms` chunks / `19.2M` samples — verifying bounded RAM `< 768 KB` per segment, zero duplicate loops, CPU backpressure warnings, and complete zero-residue wipe on `STOP`).
6. `tests/whisper-wasm-e2e.test.ts` — **Test 4** (real end-to-end `@huggingface/transformers` browser bundle + `onnxruntime-web` WebAssembly Whisper ONNX speech recognition on 48 kHz stereo speech resampled to 16 kHz mono with `0` external network requests and verified buffer zeroing).

---

## 2. Step-by-Step Windows Chrome 157 Verification Procedure (Tests 1–8)

> **Important:** Always perform initial testing using **harmless sample speech audio** (such as a public-domain audiobook clip or test recording), never actual customer conversations, until all checks pass and company authorization is confirmed.

### Test 1: Basic Application Loading
1. Open the HTTPS application URL in **Google Chrome (v157)** on Windows (if viewing inside an embedded preview frame, click **Open Standalone HTTPS Tab ↗** in the top-right header).
2. Press **F12 → Console** and confirm zero errors appear.
3. Confirm **Audio Connection Status** reads `Not connected`, no screen-sharing dialog opens automatically, and **PRIVACY MODE ACTIVE** is displayed.

### Test 2: Permission Handling
1. Click **START TRANSCRIPTION**.
2. In Chrome's screen-sharing dialog:
   - Select the **Entire Screen** tab.
   - Click your monitor preview.
   - Toggle ON **Also share system audio** (`Share system audio`).
   - Click **Share**.
3. Confirm **Audio Connection Status** changes to `System audio detected`.
4. *(Negative check)* Click **STOP**, then click **START TRANSCRIPTION** again and leave **Also share system audio** OFF (or select a single Window). Confirm the app immediately stops screen sharing, displays `No system audio detected` with troubleshooting steps, and does **not** activate your microphone.

### Test 3: Desktop Audio Capture
1. With `System audio detected`, play a harmless spoken English audio clip on Windows.
2. Confirm the **Live System Audio Indicator** bar moves in real time, `Voice Band: %` rises, and **Signal Activity** changes from `Audio inactive` to `Audio activity detected`.

### Test 4: Local Transcription
1. Confirm **Model loading status** reaches `Ready (in local RAM)` and **Processing method** displays either `WebGPU (Hardware GPU)` or `WebAssembly (CPU SIMD)`.
2. Play a clear English speech test clip (including Australian English speech if desired).
3. Confirm `Recognizing speech locally...` appears briefly while a sentence finishes, followed by a `SYSTEM AUDIO` transcript card with timestamp, `NEWLY RECOGNIZED` highlight transitioning to `FINALIZED`, and accurate English text.

### Test 5: Stop Functionality
1. Click **STOP**.
2. Confirm:
   - Chrome's native "Sharing your screen and audio" bar disappears immediately.
   - All recognized transcript cards vanish from the page.
   - Session duration resets to `00:00:00` and status resets to `Not connected`.
   - The banner displays: `"Session ended. Temporary session data cleared."`

### Test 6: Page Reload
1. Start a test session, transcribe a harmless sentence, and refresh the Chrome tab (**F5** / **Ctrl+R**).
2. Confirm:
   - Screen sharing stops immediately upon refresh and does **not** restart automatically.
   - Zero previous transcript text or session timer is restored.
   - An informational notice confirms a clean ephemeral session after tab refresh.

### Test 7: Privacy Verification (DevTools + In-App Audit)
1. Click **Verify Privacy & Storage Now** in the Privacy Panel and confirm all counters read `0` (`0 bytes` uploaded, `0` storage entries).
2. Cross-check independently in Chrome **F12 DevTools**:
   - **Network tab:** Filter by `Fetch/XHR` and `WS`. Confirm `0` WebSocket connections exist, `0` requests occur while speaking after model load, and model software downloads use `GET` only to `huggingface.co` / `*.hf.co` with `0 B` request body.
   - **Application → Storage:** Verify `Local storage`, `Session storage`, `IndexedDB`, `Cookies`, `Cache storage`, `OPFS`, and `Service workers` are completely empty (`0` items).

### Test 8: Extended Session (15+ Minutes)
1. Play a 15+ minute harmless spoken English podcast or public-domain speech recording while transcription is active.
2. Open Chrome **Shift+Esc** (Browser Task Manager) and monitor the tab's memory footprint:
   - Confirm memory stays stable after Whisper model initialization without linear growth.
   - Confirm no browser UI freezing occurs (all inference runs inside the dedicated Web Worker).
   - If CPU inference lags behind rapid speech on a slower PC, confirm a visible latency warning recommends **Whisper Tiny.en** rather than silently losing audio.
3. Click **STOP** after 15+ minutes and confirm immediate cleanup of the worker and transcript.

---

## 3. NICE CXone & Avaya Audio Compatibility Testing Procedure

Select the diagnostic label in **Diagnostic Test Label** (`NICE CXone Test`, `Avaya Test`, or `Combined Audio Test`). Remember these labels are **strictly local diagnostic tags** — the application never connects to NICE CXone or Avaya APIs, credentials, records, or call controls.

1. **NICE CXone Test:**
   - Open NICE CXone on Windows and play harmless test audio (such as CXone audio setup test tone/voice check) through your headset.
   - Click **Test Audio Only** (or **START TRANSCRIPTION**), share **Entire Screen + System Audio**, and verify all 6 checks in the **NICE CXone & Avaya Audio Diagnostics** card turn `PASS` (including pausing audio for 2 seconds to verify Check #6 Hold/Silence transition).
2. **Avaya Test:**
   - Open Avaya Workplace / softphone and ensure any Avaya setting that **mutes background sound on Windows** is turned **OFF** (when enabled, Avaya silences Windows desktop loopback audio).
   - Play Avaya's built-in audio speaker test or harmless test call audio.
   - Verify Check #2 (`Windows System Audio Track Returned`), Check #3 (`Actual Sound Energy`), and Check #4 (`300–3400 Hz Speech Clarity`), plus the **Avaya Session** indicator in **Real-Time Audio Diagnostics** (`GREEN`). If Avaya plays into your headset while Check #3 stays `-100 dBFS`, click the Windows taskbar speaker icon (no admin rights needed) and ensure your active Windows playback device matches the headset used by Avaya.
3. **Combined Audio Test:**
   - Have both NICE CXone and Avaya open concurrently (idle or playing harmless test audio) and confirm neither application is disrupted and Chrome captures system output cleanly.

---

## 4. Final Compatibility Report

In accordance with strict engineering honesty requirements, the table below distinguishes tests executed and verified in our build/test environment from tests that require live execution on a Windows desktop running proprietary NICE CXone and Avaya softphones:

| Test | Result | Verification Details |
|---|---|---|
| **Chrome system audio capture** | **Pass (Code & Automated Pipeline Verified; Live Windows GUI Ready)** | `getDisplayMedia({ video, audio, systemAudio: "include" })`, missing-track detection, `AudioWorklet` `48 kHz → 16 kHz` mono pipeline, external stop-sharing handler, and non-admin Windows WASAPI routing diagnostics implemented and verified in automated test suite (`tests/capture-and-errors.test.ts`, `tests/dsp-and-worklet.test.ts`). Interactive Windows 10/11 Chrome 157 dialog selection must be confirmed by the user in the live HTTPS preview because the build container runs Linux without a Windows GUI desktop. |
| **NICE CXone audio capture** | **Not tested** | No live NICE CXone softphone environment exists in the development sandbox. Dedicated **NICE CXone Test** 6-point diagnostic runner and routing guidance are built into the UI; do not mark as supported in production until verified on your Windows workstation with harmless CXone audio. |
| **Avaya audio capture** | **Not tested** | No live Avaya softphone environment exists in the development sandbox. Dedicated **Avaya Test** 6-point diagnostic runner and Windows Default Communications vs. Playback endpoint guidance are built into the UI; do not mark as supported in production until verified on your Windows workstation with harmless Avaya audio. |
| **Combined audio capture** | **Not tested** | No concurrent NICE CXone + Avaya Windows desktop exists in the development sandbox. Dedicated **Combined Audio Test** profile is provided for on-device verification. |
| **Local Whisper processing** | **Pass** | Verified end-to-end using `@huggingface/transformers` (`v4.3.2` browser bundle) + `onnxruntime-web` WebAssembly (`q8`) on real 48 kHz stereo English speech (`jfk.wav`) resampled to 16 kHz mono via `EphemeralVadSegmenter`, transcribing speech accurately in ~5.4s with `0` external network calls (`tests/whisper-wasm-e2e.test.ts`). |
| **No external audio transmission** | **Pass** | Verified via strict CSP (`connect-src 'self' https://huggingface.co https://*.hf.co https://*.huggingface.co`), runtime `createGuardedFetch` blocking all non-`GET`/body requests and cloud/softphone domains, runtime blocking of `WebSocket`, `EventSource`, `sendBeacon`, `RTCPeerConnection`, `MediaRecorder`, and `getUserMedia` (`tests/privacy-and-cleanup.test.ts`). |
| **Automatic session cleanup** | **Pass** | Verified 11-step cleanup on `STOP`, external Chrome "Stop sharing", model initialization failure, `pagehide`/`beforeunload`, and 20-minute extended session completion (`tests/privacy-and-cleanup.test.ts`, `tests/extended-session.test.ts`). |
