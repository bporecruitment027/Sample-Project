import type { AudioLevelMetrics } from '../types/index.ts';

/**
 * Renders an ephemeral horizontal studio level meter + speech-band bar on a <canvas>.
 * Retains zero waveform history and zero audio samples.
 */
export class EphemeralLevelMeter {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private peakHoldNormalized = 0;
  private peakDecayAtMs = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    try {
      this.ctx = canvas.getContext('2d');
    } catch {
      this.ctx = null;
    }
    this.renderIdle();
  }

  public update(metrics: AudioLevelMetrics): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    const width = this.canvas.width;
    const height = this.canvas.height;

    // Normalize -65 dBFS .. 0 dBFS into [0, 1]
    const normLevel = Math.max(0, Math.min(1, (metrics.dbfs + 65) / 65));
    const now = Date.now();
    if (normLevel >= this.peakHoldNormalized || now - this.peakDecayAtMs > 900) {
      this.peakHoldNormalized = normLevel;
      this.peakDecayAtMs = now;
    } else {
      this.peakHoldNormalized = Math.max(normLevel, this.peakHoldNormalized - 0.015);
    }

    ctx.clearRect(0, 0, width, height);

    // Dark slate background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    const padX = 12;
    const usableW = width - padX * 2;

    // Track 1: Overall Signal Level (top bar)
    const bar1Y = 11;
    const bar1H = 16;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(padX, bar1Y, usableW, bar1H);

    const fillW = Math.round(usableW * normLevel);
    if (fillW > 0) {
      ctx.fillStyle = metrics.clipping
        ? '#ef4444'
        : normLevel > 0.82
          ? '#f59e0b'
          : '#10b981';
      ctx.fillRect(padX, bar1Y, fillW, bar1H);
    }

    // Peak hold tick
    if (this.peakHoldNormalized > 0.01) {
      const peakX = padX + Math.min(usableW - 2, Math.round(usableW * this.peakHoldNormalized));
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(peakX, bar1Y, 2, bar1H);
    }

    // Track 2: 300–3400 Hz Speech Band Clarity Ratio (bottom thin bar)
    const bar2Y = 34;
    const bar2H = 9;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(padX, bar2Y, usableW, bar2H);

    const speechW = Math.round(usableW * Math.max(0, Math.min(1, metrics.speechBandRatio)));
    if (speechW > 0 && normLevel > 0.03) {
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(padX, bar2Y, speechW, bar2H);
    }
  }

  public renderIdle(): void {
    this.peakHoldNormalized = 0;
    this.peakDecayAtMs = 0;
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    const padX = 12;
    const usableW = width - padX * 2;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(padX, 11, usableW, 16);
    ctx.fillRect(padX, 34, usableW, 9);
  }
}
