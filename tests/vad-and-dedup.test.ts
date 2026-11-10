import { describe, expect, it } from 'vitest';
import {
  deduplicateOverlapText,
  sanitizeWhisperOutput,
} from '../src/audio/deduplicator.ts';
import {
  EphemeralVadSegmenter,
  type SpeechSegmentPayload,
} from '../src/audio/vadSegmenter.ts';

function makeVoiceChunk16k(durationSec: number, amp = 0.2): Float32Array {
  const n = Math.round(durationSec * 16_000);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = amp * Math.sin((2 * Math.PI * 950 * i) / 16_000);
  }
  return buf;
}

describe('VAD Segmenter & Overlap Deduplication', () => {
  it('segments speech on natural silence pauses and wipes incoming buffers', () => {
    const emitted: SpeechSegmentPayload[] = [];
    const vad = new EphemeralVadSegmenter({
      minSpeechSec: 0.5,
      silenceSplitSec: 0.6,
      maxSegmentSec: 8.0,
      onSegmentReady: (seg) => emitted.push(seg),
    });

    // 0.3s initial silence
    for (let i = 0; i < 3; i++) {
      vad.pushChunk16k(new Float32Array(1600));
    }

    // 1.2s active speech
    for (let i = 0; i < 12; i++) {
      const chunk = makeVoiceChunk16k(0.1, 0.25);
      vad.pushChunk16k(chunk);
      // Verify input chunk was zeroed immediately after push
      expect(chunk.every((v) => v === 0)).toBe(true);
    }

    // 0.7s trailing silence triggers clean segment emission
    for (let i = 0; i < 7; i++) {
      vad.pushChunk16k(new Float32Array(1600));
    }

    expect(emitted.length).toBe(1);
    expect(emitted[0].hadBoundaryOverlap).toBe(false);
    expect(emitted[0].durationSec).toBeGreaterThan(1.5);
  });

  it('splits continuous long utterances with boundary overlap and clears cleanly', () => {
    const emitted: SpeechSegmentPayload[] = [];
    const vad = new EphemeralVadSegmenter({
      minSpeechSec: 0.5,
      silenceSplitSec: 0.65,
      maxSegmentSec: 3.0,
      overlapSec: 0.4,
      onSegmentReady: (seg) => emitted.push(seg),
    });

    // Push 4.5s of uninterrupted speech -> first segment emits at 3.0s, second retains 0.4s overlap
    for (let i = 0; i < 45; i++) {
      vad.pushChunk16k(makeVoiceChunk16k(0.1, 0.25));
    }
    vad.flushPending();

    expect(emitted.length).toBe(2);
    expect(emitted[0].hadBoundaryOverlap).toBe(false);
    expect(emitted[1].hadBoundaryOverlap).toBe(true);

    vad.clearAndZero();
    expect(vad.bufferedSamplesCount).toBe(0);
    expect(vad.speaking).toBe(false);
  });

  it('filters Whisper non-speech hallucinations while preserving genuine call conversation', () => {
    expect(sanitizeWhisperOutput('[BLANK_AUDIO]')).toBe('');
    expect(sanitizeWhisperOutput(' (music) [inaudible] ')).toBe('');
    expect(sanitizeWhisperOutput('Thank you for watching!')).toBe('');
    expect(sanitizeWhisperOutput('Subtitles by the Amara.org community')).toBe('');
    expect(sanitizeWhisperOutput('the the the the the the')).toBe('');
    expect(sanitizeWhisperOutput('...')).toBe('');

    // Real conversational thank-you in a customer call MUST be preserved
    expect(sanitizeWhisperOutput('Thank you for calling customer support today.')).toBe(
      'Thank you for calling customer support today.',
    );
    expect(sanitizeWhisperOutput('Good morning mate, how can I help with your account?')).toBe(
      'Good morning mate, how can I help with your account?',
    );
  });

  it('removes duplicated boundary words across overlapping speech segments', () => {
    const seg1 = 'I would like to check my current billing';
    const seg2 = 'my current billing statement for October please.';

    const deduped = deduplicateOverlapText(seg1, seg2, true);
    expect(deduped).toBe('statement for October please.');

    // Exact duplicate overlap suppression
    expect(deduplicateOverlapText(seg1, 'check my current billing', true)).toBe('');

    // Non-overlapping distinct consecutive sentences remain intact
    expect(
      deduplicateOverlapText(
        'Your reference number is confirmed.',
        'Is there anything else I can assist you with today?',
        false,
      ),
    ).toBe('Is there anything else I can assist you with today?');
  });
});
