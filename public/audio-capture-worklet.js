/**
 * Private Live Transcriber — Ephemeral System Audio Capture Worklet
 *
 * Runs inside Chrome's AudioWorkletGlobalScope:
 * 1. Mixes multi-channel system output audio to mono.
 * 2. Anti-alias downsamples from hardware sampleRate (e.g. 48 kHz) to 16 kHz PCM.
 * 3. Computes lightweight scalar level & 300–3400 Hz speech-band metrics (~50 ms cadence).
 * 4. Transfers short 100 ms (1,600 sample) Float32Array chunks with zero-copy ArrayBuffer transfer.
 * 5. Discards all audio immediately while paused and wipes internal state on shutdown.
 * 6. Never stores waveform history or recordings.
 */

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms @ 16 kHz (6.4 KB)
const LEVEL_INTERVAL_SAMPLES = 800; // 50 ms @ 16 kHz

// RBJ bandpass biquad @ 16 kHz covering 300–3400 Hz telephony speech band
const BP_B0 = 0.4208;
const BP_B1 = 0.0;
const BP_B2 = -0.4208;
const BP_A1 = -1.0235;
const BP_A2 = 0.1584;

class EphemeralPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.paused = false;
    this.forwardSamples = true;
    this.terminated = false;

    this.sourceRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    this.resampleRatio = this.sourceRate / TARGET_RATE;
    this.resampleAccum = 0;
    this.resampleCount = 0;
    this.sourcePhase = 0;

    this.chunkBuffer = new Float32Array(CHUNK_SAMPLES);
    this.chunkWriteIndex = 0;

    // Scalar-only level meter accumulators (never retains samples)
    this.levelSampleCount = 0;
    this.levelSumSq = 0;
    this.levelBandSumSq = 0;
    this.levelPeak = 0;

    // 4-float IIR filter state
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
      } else if (msg.type === 'shutdown') {
        this._wipeBuffers();
        this.terminated = true;
      }
    };
  }

  _wipeBuffers() {
    this.chunkBuffer.fill(0);
    this.chunkWriteIndex = 0;
    this.resampleAccum = 0;
    this.resampleCount = 0;
    this.sourcePhase = 0;
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
      this.port.postMessage({
        type: 'level',
        rms,
        peak: this.levelPeak,
        speechBandRatio,
        clipping: this.levelPeak >= 0.985,
      });
      this.levelSampleCount = 0;
      this.levelSumSq = 0;
      this.levelBandSumSq = 0;
      this.levelPeak = 0;
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

  process(inputs) {
    if (this.terminated) {
      return false;
    }

    if (this.paused) {
      // Explicitly discard all incoming audio while paused without buffering
      return true;
    }

    const inputChannels = inputs[0];
    if (!inputChannels || inputChannels.length === 0 || inputChannels[0].length === 0) {
      return true;
    }

    const channelCount = inputChannels.length;
    const frameCount = inputChannels[0].length;
    const invChannels = 1 / channelCount;

    for (let i = 0; i < frameCount; i++) {
      let mono = 0;
      for (let ch = 0; ch < channelCount; ch++) {
        mono += inputChannels[ch][i];
      }
      mono *= invChannels;

      if (this.resampleRatio <= 1) {
        this._push16kSample(mono);
      } else {
        this.resampleAccum += mono;
        this.resampleCount += 1;
        this.sourcePhase += 1;
        if (this.sourcePhase >= this.resampleRatio) {
          const outSample =
            this.resampleCount > 0 ? this.resampleAccum / this.resampleCount : mono;
          this._push16kSample(outSample);
          this.sourcePhase -= this.resampleRatio;
          this.resampleAccum = 0;
          this.resampleCount = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('ephemeral-pcm-capture-processor', EphemeralPcmCaptureProcessor);
