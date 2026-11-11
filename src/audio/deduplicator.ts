import type { WhisperTimestampChunk } from '../types/index.ts';

const NON_SPEECH_BRACKET_RE =
  /\[(?:blank_audio|silence|music|applause|laughter|inaudible|noise|sound|cheering|sighs?|coughing|clicking|ringing|beeping)[^\]]*\]|\((?:music|applause|laughter|silence|inaudible|sighs?|coughing|buzzing|ringing|beeping|dial\s*tone)[^)]*\)|♪[^♪]*♪/gi;

const KNOWN_HALLUCINATION_PHRASES = new Set([
  'thank you for watching',
  'thanks for watching',
  'thank you for listening',
  'thanks for listening',
  'please subscribe',
  'subscribe to my channel',
  'like and subscribe',
  'subtitles by the amara org community',
  'subtitles by the amara.org community',
  'subtitles by amara org',
  'subtitles by amara.org',
  'amara org',
  'amara.org',
  'transcribed by',
  'captioned by',
  'closed captioning provided by',
  'link in the description',
  'please follow me on the link in the description',
  'you',
]);

function normalizeToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
    .trim();
}

/**
 * Detects degenerate Whisper token-repetition loops (e.g., "and and and and and"
 * or 2–3 word phrases repeated >= 4 times consecutively).
 */
function hasDegenerateRepetition(tokens: string[]): boolean {
  if (tokens.length < 6) {
    return false;
  }
  let consecutive = 1;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] !== '' && tokens[i] === tokens[i - 1]) {
      consecutive += 1;
      if (consecutive >= 5) {
        return true;
      }
    } else {
      consecutive = 1;
    }
  }

  if (tokens.length >= 8) {
    for (const phraseLen of [2, 3]) {
      let repeats = 1;
      for (let i = phraseLen; i + phraseLen - 1 < tokens.length; i += phraseLen) {
        let same = true;
        for (let j = 0; j < phraseLen; j++) {
          if (tokens[i + j] !== tokens[i - phraseLen + j]) {
            same = false;
            break;
          }
        }
        if (same) {
          repeats += 1;
          if (repeats >= 4) {
            return true;
          }
        } else {
          repeats = 1;
        }
      }
    }
  }

  return false;
}

export interface SanitizeAnalysisResult {
  cleanedText: string;
  wasHallucinationBlocked: boolean;
  wasRepetitionSuppressed: boolean;
}

export function analyzeAndSanitizeWhisperOutput(rawText: string): SanitizeAnalysisResult {
  if (!rawText) {
    return {
      cleanedText: '',
      wasHallucinationBlocked: false,
      wasRepetitionSuppressed: false,
    };
  }

  const withoutMarkers = rawText
    .replace(NON_SPEECH_BRACKET_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!withoutMarkers || !/[a-zA-Z0-9]/.test(withoutMarkers)) {
    return {
      cleanedText: '',
      wasHallucinationBlocked: rawText.trim().length > 0,
      wasRepetitionSuppressed: false,
    };
  }

  const words = withoutMarkers.split(/\s+/);
  const normTokens = words.map(normalizeToken).filter(Boolean);

  if (normTokens.length === 0) {
    return {
      cleanedText: '',
      wasHallucinationBlocked: true,
      wasRepetitionSuppressed: false,
    };
  }

  const normalizedSentence = normTokens.join(' ');
  if (KNOWN_HALLUCINATION_PHRASES.has(normalizedSentence)) {
    return {
      cleanedText: '',
      wasHallucinationBlocked: true,
      wasRepetitionSuppressed: false,
    };
  }

  if (hasDegenerateRepetition(normTokens)) {
    return {
      cleanedText: '',
      wasHallucinationBlocked: false,
      wasRepetitionSuppressed: true,
    };
  }

  return {
    cleanedText: withoutMarkers,
    wasHallucinationBlocked: false,
    wasRepetitionSuppressed: false,
  };
}

/**
 * Cleans raw Whisper output and suppresses non-speech tags or silence hallucinations
 * so the application never fabricates text when audio is silent or unclear.
 */
export function sanitizeWhisperOutput(rawText: string): string {
  return analyzeAndSanitizeWhisperOutput(rawText).cleanedText;
}

function findBoundaryOverlapWordCount(prevNorm: string[], nextNorm: string[]): number {
  // 3.0s overlap at conversational-to-fast speech spans up to ~20–24 words
  const maxOverlapCheck = Math.min(24, prevNorm.length, nextNorm.length);

  // Pass 1: Exact normalized suffix-prefix match (highest precision)
  for (let k = maxOverlapCheck; k >= 1; k--) {
    if (k === 1) {
      const wPrev = prevNorm[prevNorm.length - 1];
      const wNext = nextNorm[0];
      if (wPrev && wPrev.length >= 3 && wPrev === wNext) {
        return 1;
      }
      continue;
    }

    let exact = true;
    for (let i = 0; i < k; i++) {
      const a = prevNorm[prevNorm.length - k + i];
      const b = nextNorm[i];
      if (!a || !b || a !== b) {
        exact = false;
        break;
      }
    }
    if (exact) {
      return k;
    }
  }

  // Pass 2: Fuzzy suffix-prefix alignment for 3s overlaps (>= 4 words, >= 80% token match,
  // and exact anchor on the final overlap token so new post-overlap words are never cut)
  for (let k = maxOverlapCheck; k >= 4; k--) {
    const anchorPrev = prevNorm[prevNorm.length - 1];
    const anchorNext = nextNorm[k - 1];
    if (!anchorPrev || anchorPrev !== anchorNext) {
      continue;
    }
    let matches = 0;
    for (let i = 0; i < k; i++) {
      if (prevNorm[prevNorm.length - k + i] === nextNorm[i]) {
        matches += 1;
      }
    }
    if (matches / k >= 0.8) {
      return k;
    }
  }

  // Pass 3: Handle 1–2 leadingclipped words at very start of overlap window (offset by 1–2 in prev tail)
  const tailWindow = Math.min(26, prevNorm.length);
  const prevTail = prevNorm.slice(prevNorm.length - tailWindow);
  for (let k = Math.min(20, nextNorm.length); k >= 3; k--) {
    // Check if nextNorm[0..k-1] matches prevTail ending at the very end or 1 word from end
    for (let endTrim = 0; endTrim <= 1; endTrim++) {
      const startInTail = prevTail.length - endTrim - k;
      if (startInTail < 0) continue;
      let matches = 0;
      for (let i = 0; i < k; i++) {
        if (prevTail[startInTail + i] === nextNorm[i]) {
          matches += 1;
        }
      }
      if (matches === k || (k >= 5 && matches / k >= 0.84)) {
        return k;
      }
    }
  }

  return 0;
}

export interface DeduplicationDetailResult {
  text: string;
  wasHallucinationBlocked: boolean;
  wasRepetitionSuppressed: boolean;
  overlapWordsTrimmed: number;
}

/**
 * Timestamp-aware + sequence-aligned deduplicator for 3-second overlapping segments.
 * Uses Whisper's chunk timestamps (when present) plus up to 24-word exact/fuzzy suffix-prefix
 * alignment so overlap context improves accuracy without printing duplicate sentences.
 */
export function deduplicateSegmentDetailed(params: {
  previousSegmentText: string;
  incomingSegmentText: string;
  chunks?: WhisperTimestampChunk[];
  hadBoundaryOverlap: boolean;
  overlapDurationSec?: number;
}): DeduplicationDetailResult {
  const {
    previousSegmentText,
    incomingSegmentText,
    chunks,
    hadBoundaryOverlap,
    overlapDurationSec = 3.0,
  } = params;

  let candidateText = incomingSegmentText;
  let trimmedByTimestamps = 0;

  // Step 1: If boundary overlap occurred and Whisper returned timestamped sub-chunks,
  // drop leading sub-chunks that lie wholly inside the already-transcribed overlap region
  // when their text already appears in previousSegmentText.
  if (
    hadBoundaryOverlap &&
    previousSegmentText &&
    Array.isArray(chunks) &&
    chunks.length > 1 &&
    overlapDurationSec > 0
  ) {
    const prevNormSet = new Set(
      previousSegmentText
        .trim()
        .split(/\s+/)
        .map(normalizeToken)
        .filter(Boolean),
    );
    let dropIndex = 0;
    while (dropIndex < chunks.length) {
      const ch = chunks[dropIndex];
      const endSec = ch.timestamp?.[1];
      if (typeof endSec !== 'number' || endSec > overlapDurationSec + 0.15) {
        break;
      }
      const chTokens = ch.text
        .trim()
        .split(/\s+/)
        .map(normalizeToken)
        .filter(Boolean);
      if (chTokens.length === 0) {
        dropIndex += 1;
        continue;
      }
      const alreadySeenCount = chTokens.filter((t) => prevNormSet.has(t)).length;
      if (alreadySeenCount / chTokens.length >= 0.7) {
        trimmedByTimestamps += chTokens.length;
        dropIndex += 1;
      } else {
        break;
      }
    }

    if (dropIndex > 0) {
      candidateText = chunks
        .slice(dropIndex)
        .map((c) => c.text)
        .join(' ')
        .trim();
      if (!candidateText) {
        return {
          text: '',
          wasHallucinationBlocked: false,
          wasRepetitionSuppressed: false,
          overlapWordsTrimmed: trimmedByTimestamps,
        };
      }
    }
  }

  const sanitized = analyzeAndSanitizeWhisperOutput(candidateText);
  if (!sanitized.cleanedText) {
    return {
      text: '',
      wasHallucinationBlocked: sanitized.wasHallucinationBlocked,
      wasRepetitionSuppressed: sanitized.wasRepetitionSuppressed,
      overlapWordsTrimmed: trimmedByTimestamps,
    };
  }

  if (!previousSegmentText || !hadBoundaryOverlap) {
    return {
      text: sanitized.cleanedText,
      wasHallucinationBlocked: false,
      wasRepetitionSuppressed: false,
      overlapWordsTrimmed: 0,
    };
  }

  const prevWords = previousSegmentText.trim().split(/\s+/);
  const nextWords = sanitized.cleanedText.split(/\s+/);
  const prevNorm = prevWords.map(normalizeToken);
  const nextNorm = nextWords.map(normalizeToken);

  // Suppress exact duplicate sentence emitted back-to-back across overlap
  if (prevNorm.join(' ') === nextNorm.join(' ')) {
    return {
      text: '',
      wasHallucinationBlocked: false,
      wasRepetitionSuppressed: true,
      overlapWordsTrimmed: nextWords.length,
    };
  }

  // Suppress when entire short incoming segment is already a suffix of previous segment
  if (
    nextNorm.length <= 18 &&
    nextNorm.length <= prevNorm.length &&
    nextNorm.length >= 2 &&
    prevNorm.slice(prevNorm.length - nextNorm.length).join(' ') === nextNorm.join(' ')
  ) {
    return {
      text: '',
      wasHallucinationBlocked: false,
      wasRepetitionSuppressed: false,
      overlapWordsTrimmed: trimmedByTimestamps + nextWords.length,
    };
  }

  const bestOverlap = findBoundaryOverlapWordCount(prevNorm, nextNorm);
  if (bestOverlap === 0) {
    return {
      text: sanitized.cleanedText,
      wasHallucinationBlocked: false,
      wasRepetitionSuppressed: false,
      overlapWordsTrimmed: trimmedByTimestamps,
    };
  }

  const remaining = nextWords.slice(bestOverlap).join(' ').trim();
  return {
    text: remaining,
    wasHallucinationBlocked: false,
    wasRepetitionSuppressed: false,
    overlapWordsTrimmed: trimmedByTimestamps + bestOverlap,
  };
}

/**
 * Removes repeated words at segment boundaries caused by intentional audio overlap
 * between successive segments.
 */
export function deduplicateOverlapText(
  previousSegmentText: string,
  incomingSegmentText: string,
  hadBoundaryOverlap: boolean,
): string {
  return deduplicateSegmentDetailed({
    previousSegmentText,
    incomingSegmentText,
    hadBoundaryOverlap,
  }).text;
}
