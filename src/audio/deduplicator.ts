const NON_SPEECH_BRACKET_RE =
  /\[(?:blank_audio|silence|music|applause|laughter|inaudible|noise|sound|cheering|sighs?|coughing|clicking)[^\]]*\]|\((?:music|applause|laughter|silence|inaudible|sighs?|coughing|buzzing|ringing|beeping)[^)]*\)|♪[^♪]*♪/gi;

const KNOWN_HALLUCINATION_PHRASES = new Set([
  'thank you for watching',
  'thanks for watching',
  'please subscribe',
  'subscribe to my channel',
  'subtitles by the amara org community',
  'subtitles by the amara.org community',
  'subtitles by amara org',
  'subtitles by amara.org',
  'amara org',
  'amara.org',
  'transcribed by',
  'captioned by',
  'you',
]);

function normalizeToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
    .trim();
}

/**
 * Collapses degenerate Whisper token-repetition loops (e.g., "and and and and and").
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

  // Also check 2-word phrase repeated >= 4 times back-to-back
  if (tokens.length >= 8) {
    let pairRepeats = 1;
    for (let i = 2; i + 1 < tokens.length; i += 2) {
      if (tokens[i] === tokens[i - 2] && tokens[i + 1] === tokens[i - 1]) {
        pairRepeats += 1;
        if (pairRepeats >= 4) {
          return true;
        }
      } else {
        pairRepeats = 1;
      }
    }
  }

  return false;
}

/**
 * Cleans raw Whisper output and suppresses non-speech tags or silence hallucinations
 * so the application never fabricates text when audio is silent or unclear.
 */
export function sanitizeWhisperOutput(rawText: string): string {
  if (!rawText) {
    return '';
  }

  const withoutMarkers = rawText
    .replace(NON_SPEECH_BRACKET_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!withoutMarkers) {
    return '';
  }

  // Reject punctuation-only output like "..." or "- - -"
  if (!/[a-zA-Z0-9]/.test(withoutMarkers)) {
    return '';
  }

  const words = withoutMarkers.split(/\s+/);
  const normTokens = words.map(normalizeToken).filter(Boolean);

  if (normTokens.length === 0) {
    return '';
  }

  const normalizedSentence = normTokens.join(' ');
  if (KNOWN_HALLUCINATION_PHRASES.has(normalizedSentence)) {
    return '';
  }

  if (hasDegenerateRepetition(normTokens)) {
    return '';
  }

  return withoutMarkers;
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
  const cleanedIncoming = sanitizeWhisperOutput(incomingSegmentText);
  if (!cleanedIncoming) {
    return '';
  }
  if (!previousSegmentText || !hadBoundaryOverlap) {
    return cleanedIncoming;
  }

  const prevWords = previousSegmentText.trim().split(/\s+/);
  const nextWords = cleanedIncoming.split(/\s+/);

  const prevNorm = prevWords.map(normalizeToken);
  const nextNorm = nextWords.map(normalizeToken);

  // Suppress exact duplicate sentence emitted back-to-back across overlap
  if (prevNorm.join(' ') === nextNorm.join(' ')) {
    return '';
  }

  // Also check if entire incoming segment is already an exact suffix of previous segment (<= 6 words)
  if (
    nextNorm.length <= 6 &&
    nextNorm.length <= prevNorm.length &&
    nextNorm.length >= 2 &&
    prevNorm.slice(prevNorm.length - nextNorm.length).join(' ') === nextNorm.join(' ')
  ) {
    return '';
  }

  // 0.48s boundary overlap contains at most ~1–6 spoken words; require exact normalized match
  const maxOverlapCheck = Math.min(6, prevNorm.length, nextNorm.length);
  let bestOverlap = 0;

  for (let k = maxOverlapCheck; k >= 1; k--) {
    if (k === 1) {
      const wPrev = prevNorm[prevNorm.length - 1];
      const wNext = nextNorm[0];
      if (wPrev && wPrev.length >= 4 && wPrev === wNext) {
        bestOverlap = 1;
        break;
      }
      continue;
    }

    let valid = true;
    for (let i = 0; i < k; i++) {
      const a = prevNorm[prevNorm.length - k + i];
      const b = nextNorm[i];
      if (!a || !b || a !== b) {
        valid = false;
        break;
      }
    }

    if (valid) {
      bestOverlap = k;
      break;
    }
  }

  if (bestOverlap === 0) {
    return cleanedIncoming;
  }

  const remaining = nextWords.slice(bestOverlap).join(' ').trim();
  return remaining;
}
