/**
 * Private Live Transcriber — Ephemeral System Audio Capture Worklet (v2)
 *
 * Runs inside Chrome's AudioWorkletGlobalScope:
 * 1. Inspects Left and Right channels independently (RMS, peak, correlation) BEFORE downmixing.
 * 2. Selects optimal channel strategy (single-channel preservation, coherent stereo, equal-power dual, or anti-cancel).
 * 3. Converts from actual hardware sampleRate (48 kHz / 44.1 kHz / etc.) to genuine 16 kHz Float32Array
 *    using a 64-phase Blackman-windowed sinc low-pass anti-aliasing FIR filter (>58 dB stopband rejection).
 * 4. Computes lightweight scalar diagnostics (~50 ms cadence) without storing waveform history.
 * 5. Transfers short 100 ms (1,600 sample) Float32Array chunks via zero-copy ArrayBuffer transfer.
 * 6. Discards all audio immediately while paused and overwrites all internal buffers with 0 on shutdown.
 */

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms @ 16 kHz (6.4 KB)
const LEVEL_INTERVAL_SAMPLES = 800; // 50 ms @ 16 kHz
const POLYPHASE_PHASES = 64;

// RBJ bandpass biquad @ 16 kHz covering 300–3400 Hz telephony speech band
const BP_B0 = 0.4208;
const BP_B1 = 0.0;
const BP_B2 = -0.4208;
const BP_A1 = -1.0235;
const BP_A2 = 0.1584;

function clampUnit(v) {
  if (!Number.isFinite(v)) return 0;
  if (v > 1.0) return 1.0;
  if (v < -1.0) return -1.0;
  return v;
}

function softLimit(v) {
  if (!Number.isFinite(v)) return 0;
  const abs = Math.abs(v);
  if (abs <= 0.88) return v;
  const sign = v < 0 ? -1 : 1;
  return sign * Math.min(1.0, 0.88 + 0.12 * Math.tanh((abs - 0.88) / 0.12));
}

function buildSincTable(sourceRate, targetRate) {
  const ratio = sourceRate / targetRate;
  const cutoffScale = ratio > 1 ? 0.925 / ratio : 0.925;
  const halfWidth = Math.max(8, Math.min(36, Math.ceil(8 * Math.max(1, ratio))));
  const tapsPerPhase = halfWidth * 2;
  const weights = new Float32Array(POLYPHASE_PHASES * tapsPerPhase);

  for (let p = 0; p < POLYPHASE_PHASES; p++) {
    const frac = p / POLYPHASE_PHASES;
    let sum = 0;
    const row = p * tapsPerPhase;
    for (let t = 0; t < tapsPerPhase; t++) {
      const k = t - halfWidth + 1;
      const delta = k - frac;
      const normPos = delta / halfWidth;
      let w = 0;
      if (Math.abs(normPos) < 1) {
        const winAngle = Math.PI * (normPos + 1);
        const blackman = 0.42 - 0.5 * Math.cos(winAngle) + 0.08 * Math.cos(2 * winAngle);
        const x = Math.PI * cutoffScale * delta;
        const sinc = Math.abs(x) < 1e-8 ? 1.0 : Math.sin(x) / x;
        w = cutoffScale * sinc * blackman;
      }
      weights[row + t] = w;
      sum += w;
    }
    if (Math.abs(sum) > 1e-9) {
      const inv = 1 / sum;
      for (let t = 0; t < tapsPerPhase; t++) {
        weights[row + t] *= inv;
      }
    }
  }

  return { tapsPerPhase, halfWidth, weights };
}

class EphemeralPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.paused = false;
    this.forwardSamples = true;
    this.terminated = false;
    this.channelMode = 'auto'; // 'auto' | 'left' | 'right' | 'stereo-sum'

    this.sourceRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    this.resampleRatio = this.sourceRate / TARGET_RATE;

    const sinc = buildSincTable(this.sourceRate, TARGET_RATE);
    this.tapsPerPhase = sinc.tapsPerPhase;
    this.halfWidth = sinc.halfWidth;
    this.sincWeights = sinc.weights;

    // Small FIR history ring (~96–192 floats)
    this.firHistory = new Float32Array(this.tapsPerPhase + 512);
    this.firFill = 0;
    this.firReadPos = 0;

    this.chunkBuffer = new Float32Array(CHUNK_SAMPLES);
    this.chunkWriteIndex = 0;

    // Scalar-only channel & level accumulators (never retains waveform history)
    this.lastChannelCount = 1;
    this.lastTopology = 'silent';
    this.rawFrameCount = 0;
    this.leftSumSq = 0;
    this.rightSumSq = 0;
    this.crossSumLR = 0;

    this.levelSampleCount = 0;
    this.levelSumSq = 0;
    this.levelBandSumSq = 0;
    this.levelPeak = 0;

    // 4-float IIR speech-band state
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      if (msg.type === 'pause') {
        this.paused = Boolean(msg.paused);
        if (this.paused) {
          this._wipeBuffers();
          this.port.postMessage({
            type: 'level',
            rms: 0,
            peak: 0,
            leftRms: 0,
            rightRms: 0,
            channelCount: this.lastChannelCount,
            channelTopology: 'silent',
            channelCorrelation: 0,
            sourceSampleRate: this.sourceRate,
            speechBandRatio: 0,
            clipping: false,
          });
        }
      } else if (msg.type === 'set-forwarding') {
        this.forwardSamples = Boolean(msg.forwardSamples);
        if (!this.forwardSamples) {
          this.chunkBuffer.fill(0);
          this.chunkWriteIndex = 0;
        }
      } else if (msg.type === 'set-channel-mode') {
        if (
          msg.channelMode === 'auto' ||
          msg.channelMode === 'left' ||
          msg.channelMode === 'right' ||
          msg.channelMode === 'stereo-sum'
        ) {
          this.channelMode = msg.channelMode;
        }
      } else if (msg.type === 'shutdown') {
        this._wipeBuffers();
        this.terminated = true;
      }
    };
  }

  _wipeBuffers() {
    this.chunkBuffer.fill(0);
    this.chunkWriteIndex = 0;
    this.firHistory.fill(0);
    this.firFill = 0;
    this.firReadPos = 0;
    this.rawFrameCount = 0;
    this.leftSumSq = 0;
    this.rightSumSq = 0;
    this.crossSumLR = 0;
    this.levelSampleCount = 0;
    this.levelSumSq = 0;
    this.levelBandSumSq = 0;
    this.levelPeak = 0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  _push16kSample(sample) {
    const abs = Math.abs(sample);
    if (abs > this.levelPeak) {
      this.levelPeak = abs;
    }
    this.levelSumSq += sample * sample;

    const y0 =
      BP_B0 * sample +
      BP_B1 * this.x1 +
      BP_B2 * this.x2 -
      BP_A1 * this.y1 -
      BP_A2 * this.y2;
    this.x2 = this.x1;
    this.x1 = sample;
    this.y2 = this.y1;
    this.y1 = y0;
    this.levelBandSumSq += y0 * y0;
    this.levelSampleCount += 1;

    if (this.levelSampleCount >= LEVEL_INTERVAL_SAMPLES) {
      const rms = Math.sqrt(this.levelSumSq / this.levelSampleCount);
      const speechBandRatio =
        this.levelSumSq > 1e-9
          ? Math.min(1, Math.max(0, this.levelBandSumSq / this.levelSumSq))
          : 0;

      const rawN = Math.max(1, this.rawFrameCount);
      const leftRms = Math.sqrt(this.leftSumSq / rawN);
      const rightRms = Math.sqrt(this.rightSumSq / rawN);
      const denom = Math.sqrt(this.leftSumSq * this.rightSumSq);
      const corr = denom > 1e-12 ? Math.max(-1, Math.min(1, this.crossSumLR / denom)) : 0;

      this.port.postMessage({
        type: 'level',
        rms,
        peak: this.levelPeak,
        leftRms,
        rightRms,
        channelCount: this.lastChannelCount,
        channelTopology: this.lastTopology,
        channelCorrelation: corr,
        sourceSampleRate: this.sourceRate,
        speechBandRatio,
        clipping: this.levelPeak >= 0.985,
      });

      this.levelSampleCount = 0;
      this.levelSumSq = 0;
      this.levelBandSumSq = 0;
      this.levelPeak = 0;
      this.rawFrameCount = 0;
      this.leftSumSq = 0;
      this.rightSumSq = 0;
      this.crossSumLR = 0;
    }

    if (this.forwardSamples) {
      this.chunkBuffer[this.chunkWriteIndex] = sample;
      this.chunkWriteIndex += 1;
      if (this.chunkWriteIndex >= CHUNK_SAMPLES) {
        const outgoing = this.chunkBuffer;
        this.chunkBuffer = new Float32Array(CHUNK_SAMPLES);
        this.chunkWriteIndex = 0;
        this.port.postMessage({ type: 'pcm', samples: outgoing }, [outgoing.buffer]);
      }
    }
  }

  _inspectAndDownmixQuantum(inputChannels, monoOut) {
    const channelCount = inputChannels.length;
    const frameCount = inputChannels[0].length;
    this.lastChannelCount = channelCount;

    if (channelCount === 1) {
      const ch0 = inputChannels[0];
      let sumSq = 0;
      for (let i = 0; i < frameCount; i++) {
        const s = clampUnit(ch0[i]);
        monoOut[i] = s;
        sumSq += s * s;
      }
      this.leftSumSq += sumSq;
      this.rightSumSq += sumSq;
      this.crossSumLR += sumSq;
      this.rawFrameCount += frameCount;
      this.lastTopology = sumSq / frameCount < 1e-10 ? 'silent' : 'mono-input';
      return;
    }

    const left = inputChannels[0];
    const right = inputChannels[1];
    let qL2 = 0;
    let qR2 = 0;
    let qLR = 0;

    for (let i = 0; i < frameCount; i++) {
      const l = Number.isFinite(left[i]) ? left[i] : 0;
      const r = Number.isFinite(right[i]) ? right[i] : 0;
      qL2 += l * l;
      qR2 += r * r;
      qLR += l * r;
    }

    this.leftSumSq += qL2;
    this.rightSumSq += qR2;
    this.crossSumLR += qLR;
    this.rawFrameCount += frameCount;

    const lRms = Math.sqrt(qL2 / frameCount);
    const rRms = Math.sqrt(qR2 / frameCount);
    const denom = Math.sqrt(qL2 * qR2);
    const corr = denom > 1e-12 ? qLR / denom : 0;

    let topology = 'identical-stereo';
    if (lRms < 1e-5 && rRms < 1e-5) {
      topology = 'silent';
    } else if (lRms >= 2e-4 && (rRms < 1e-5 || lRms / Math.max(1e-7, rRms) >= 1.995)) {
      topology = 'left-dominant';
    } else if (rRms >= 2e-4 && (lRms < 1e-5 || rRms / Math.max(1e-7, lRms) >= 1.995)) {
      topology = 'right-dominant';
    } else if (corr <= -0.25) {
      topology = 'phase-inverted';
    } else if (corr >= 0.80) {
      topology = 'identical-stereo';
    } else {
      topology = 'dual-independent';
    }
    this.lastTopology = topology;

    if (this.channelMode === 'left') {
      for (let i = 0; i < frameCount; i++) monoOut[i] = clampUnit(left[i]);
      return;
    }
    if (this.channelMode === 'right') {
      for (let i = 0; i < frameCount; i++) monoOut[i] = clampUnit(right[i]);
      return;
    }
    if (this.channelMode === 'stereo-sum') {
      const inv = 1 / channelCount;
      for (let i = 0; i < frameCount; i++) {
        let s = 0;
        for (let c = 0; c < channelCount; c++) s += inputChannels[c][i];
        monoOut[i] = clampUnit(s * inv);
      }
      return;
    }

    // Smart 'auto' selection
    if (topology === 'left-dominant') {
      for (let i = 0; i < frameCount; i++) monoOut[i] = clampUnit(left[i]);
    } else if (topology === 'right-dominant') {
      for (let i = 0; i < frameCount; i++) monoOut[i] = clampUnit(right[i]);
    } else if (topology === 'phase-inverted') {
      if (corr <= -0.75) {
        for (let i = 0; i < frameCount; i++) monoOut[i] = softLimit(0.5 * (left[i] - right[i]));
      } else {
        const chosen = lRms >= rRms ? left : right;
        for (let i = 0; i < frameCount; i++) monoOut[i] = clampUnit(chosen[i]);
      }
    } else {
      for (let i = 0; i < frameCount; i++) monoOut[i] = clampUnit(0.5 * (left[i] + right[i]));
    }
  }

  process(inputs) {
    if (this.terminated) {
      return false;
    }

    if (this.paused) {
      return true;
    }

    const inputChannels = inputs[0];
    if (!inputChannels || inputChannels.length === 0 || inputChannels[0].length === 0) {
      return true;
    }

    const frameCount = inputChannels[0].length;
    const monoQuantum = new Float32Array(frameCount);
    this._inspectAndDownmixQuantum(inputChannels, monoQuantum);

    if (this.sourceRate === TARGET_RATE) {
      for (let i = 0; i < frameCount; i++) {
        this._push16kSample(monoQuantum[i]);
      }
      monoQuantum.fill(0);
      return true;
    }

    // Streaming polyphase Blackman-sinc anti-aliased resampling to genuine 16 kHz
    if (this.firFill === 0) {
      const seed = monoQuantum[0];
      for (let i = 0; i < this.tapsPerPhase; i++) {
        this.firHistory[i] = seed;
      }
      this.firFill = this.tapsPerPhase;
      this.firReadPos = this.halfWidth - 1;
    }

    const needed = this.firFill + frameCount;
    if (this.firHistory.length < needed) {
      const grown = new Float32Array(needed + 256);
      grown.set(this.firHistory.subarray(0, this.firFill), 0);
      this.firHistory.fill(0);
      this.firHistory = grown;
    }
    this.firHistory.set(monoQuantum, this.firFill);
    this.firFill = needed;
    monoQuantum.fill(0);

    const maxCenter = this.firFill - this.halfWidth - 1;
    while (this.firReadPos <= maxCenter) {
      const baseIdx = Math.floor(this.firReadPos);
      const frac = this.firReadPos - baseIdx;
      const phaseIdx = Math.min(POLYPHASE_PHASES - 1, Math.floor(frac * POLYPHASE_PHASES));
      const rowOffset = phaseIdx * this.tapsPerPhase;
      const startSrc = baseIdx - this.halfWidth + 1;

      let acc = 0;
      for (let t = 0; t < this.tapsPerPhase; t++) {
        acc += this.firHistory[startSrc + t] * this.sincWeights[rowOffset + t];
      }

      this._push16kSample(clampUnit(acc));
      this.firReadPos += this.resampleRatio;
    }

    const keepFrom = Math.max(0, Math.floor(this.firReadPos) - this.halfWidth);
    if (keepFrom > 0) {
      const rem = this.firFill - keepFrom;
      this.firHistory.copyWithin(0, keepFrom, this.firFill);
      this.firHistory.fill(0, rem, this.firFill);
      this.firFill = rem;
      this.firReadPos -= keepFrom;
    }

    return true;
  }
}

registerProcessor('ephemeral-pcm-capture-processor', EphemeralPcmCaptureProcessor);
