import type { NetworkAuditEntry } from '../types/index.ts';

const MAX_AUDIT_ENTRIES = 40;

const ALLOWED_MODEL_HOST_SUFFIXES = [
  'huggingface.co',
  '.huggingface.co',
  '.hf.co',
];

const FORBIDDEN_HOST_PATTERNS = [
  'googleapis.com',
  'openai.com',
  'microsoft.com',
  'azure.com',
  'assemblyai.com',
  'deepgram.com',
  'rev.ai',
  'google-analytics.com',
  'googletagmanager.com',
  'sentry.io',
  'mixpanel.com',
  'segment.io',
  'niceincontact.com',
  'nice.com',
  'avaya.com',
];

export class PrivacyPolicyError extends Error {
  constructor(message: string) {
    super(`[PrivacyGuard] ${message}`);
    this.name = 'PrivacyPolicyError';
  }
}

export interface PrivacyGuardCounters {
  blockedNetworkAttempts: number;
  webSocketAttempts: number;
  mediaRecorderAttempts: number;
  microphoneAttempts: number;
}

const auditEntries: NetworkAuditEntry[] = [];
const counters: PrivacyGuardCounters = {
  blockedNetworkAttempts: 0,
  webSocketAttempts: 0,
  mediaRecorderAttempts: 0,
  microphoneAttempts: 0,
};

let guardsInstalled = false;

function formatTimeNow(): string {
  return new Date().toTimeString().slice(0, 8);
}

function pushAuditEntry(entry: NetworkAuditEntry): void {
  if (auditEntries.length >= MAX_AUDIT_ENTRIES) {
    auditEntries.shift();
  }
  auditEntries.push(entry);
}

export function isAllowedReadOnlyAssetUrl(rawUrl: string, currentOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, currentOrigin);
  } catch {
    return false;
  }

  if (parsed.protocol === 'blob:') {
    // Only allow same-origin blob URLs (used internally by browser Web Workers)
    return parsed.pathname.startsWith(currentOrigin);
  }

  if (parsed.origin === currentOrigin) {
    return true;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  for (const forbidden of FORBIDDEN_HOST_PATTERNS) {
    if (host === forbidden || host.endsWith(`.${forbidden}`)) {
      return false;
    }
  }

  return ALLOWED_MODEL_HOST_SUFFIXES.some((suffix) =>
    suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix,
  );
}

function classifyAssetCategory(urlStr: string): NetworkAuditEntry['category'] {
  const lower = urlStr.toLowerCase();
  if (lower.includes('.wasm') || lower.includes('ort-wasm')) {
    return 'wasm-runtime';
  }
  if (lower.includes('.onnx')) {
    return 'model-weights';
  }
  if (lower.includes('.json') || lower.includes('huggingface.co') || lower.includes('.hf.co')) {
    return 'model-config';
  }
  return 'app-static';
}

function sanitizeUrlForAudit(rawUrl: string, currentOrigin: string): string {
  try {
    const parsed = new URL(rawUrl, currentOrigin);
    // Strip query tokens (such as signed CDN redirect params) so audit log stays concise & clean
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Creates a guarded read-only fetch wrapper usable in both the Main Thread and Web Workers.
 * Blocks any non-GET/HEAD method, any request body, and any non-allowlisted external host.
 */
export function createGuardedFetch(
  underlyingFetch: typeof fetch,
  currentOrigin: string,
  onAudit?: (entry: NetworkAuditEntry) => void,
): typeof fetch {
  return async function guardedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const method = (
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    ).toUpperCase();

    const hasBody =
      init?.body !== undefined && init?.body !== null
        ? true
        : typeof Request !== 'undefined' && input instanceof Request && input.body !== null;

    if ((method !== 'GET' && method !== 'HEAD') || hasBody) {
      counters.blockedNetworkAttempts += 1;
      const blockedEntry: NetworkAuditEntry = {
        timestamp: formatTimeNow(),
        method,
        url: sanitizeUrlForAudit(rawUrl, currentOrigin),
        category: classifyAssetCategory(rawUrl),
        status: 'blocked',
        bytesSent: 0,
      };
      pushAuditEntry(blockedEntry);
      onAudit?.(blockedEntry);
      throw new PrivacyPolicyError(
        `Outbound data transmission blocked (${method} request or payload body is prohibited).`,
      );
    }

    if (!isAllowedReadOnlyAssetUrl(rawUrl, currentOrigin)) {
      counters.blockedNetworkAttempts += 1;
      const blockedEntry: NetworkAuditEntry = {
        timestamp: formatTimeNow(),
        method,
        url: sanitizeUrlForAudit(rawUrl, currentOrigin),
        category: classifyAssetCategory(rawUrl),
        status: 'blocked',
        bytesSent: 0,
      };
      pushAuditEntry(blockedEntry);
      onAudit?.(blockedEntry);
      throw new PrivacyPolicyError(
        `External request blocked: host is not in the software-asset allowlist.`,
      );
    }

    const allowedEntry: NetworkAuditEntry = {
      timestamp: formatTimeNow(),
      method,
      url: sanitizeUrlForAudit(rawUrl, currentOrigin),
      category: classifyAssetCategory(rawUrl),
      status: 'allowed-readonly',
      bytesSent: 0,
    };
    pushAuditEntry(allowedEntry);
    onAudit?.(allowedEntry);

    return underlyingFetch(input, {
      ...init,
      method,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  };
}

/**
 * Installs defense-in-depth runtime guards on the main browser window:
 * - Replaces global fetch with read-only asset fetch guard
 * - Disables WebSocket, EventSource, sendBeacon, RTCPeerConnection
 * - Disables MediaRecorder (no audio file recording allowed)
 * - Disables getUserMedia (no microphone fallback allowed in v1)
 * - Disables ServiceWorker registration (no background audio persistence)
 */
export function installMainThreadPrivacyGuards(targetGlobal: typeof globalThis = globalThis): void {
  if (guardsInstalled) {
    return;
  }

  const origin = targetGlobal.location?.origin ?? 'https://localhost';

  if (typeof targetGlobal.fetch === 'function') {
    const nativeFetch = targetGlobal.fetch.bind(targetGlobal);
    targetGlobal.fetch = createGuardedFetch(nativeFetch, origin);
  }

  // Block navigator.sendBeacon
  if (typeof targetGlobal.navigator !== 'undefined' && 'sendBeacon' in targetGlobal.navigator) {
    Object.defineProperty(targetGlobal.navigator, 'sendBeacon', {
      configurable: true,
      value: () => {
        counters.blockedNetworkAttempts += 1;
        return false;
      },
    });
  }

  // Block WebSocket
  if ('WebSocket' in targetGlobal) {
    const BlockedWebSocket = function () {
      counters.webSocketAttempts += 1;
      counters.blockedNetworkAttempts += 1;
      throw new PrivacyPolicyError('WebSocket connections are strictly disabled for privacy.');
    };
    Object.defineProperty(targetGlobal, 'WebSocket', {
      configurable: true,
      writable: true,
      value: BlockedWebSocket,
    });
  }

  // Block EventSource
  if ('EventSource' in targetGlobal) {
    Object.defineProperty(targetGlobal, 'EventSource', {
      configurable: true,
      writable: true,
      value: function () {
        counters.blockedNetworkAttempts += 1;
        throw new PrivacyPolicyError('EventSource connections are strictly disabled for privacy.');
      },
    });
  }

  // Block RTCPeerConnection
  if ('RTCPeerConnection' in targetGlobal) {
    Object.defineProperty(targetGlobal, 'RTCPeerConnection', {
      configurable: true,
      writable: true,
      value: function () {
        counters.blockedNetworkAttempts += 1;
        throw new PrivacyPolicyError('WebRTC peer connections are disabled for privacy.');
      },
    });
  }

  // Block MediaRecorder so audio recordings (WebM/OGG/MP3/WAV) can never be created
  if ('MediaRecorder' in targetGlobal) {
    Object.defineProperty(targetGlobal, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: function () {
        counters.mediaRecorderAttempts += 1;
        throw new PrivacyPolicyError(
          'Audio recording (MediaRecorder) is strictly prohibited by privacy policy.',
        );
      },
    });
  }

  // Block XMLHttpRequest non-GET or external transmissions
  if (typeof targetGlobal.XMLHttpRequest !== 'undefined') {
    const origOpen = targetGlobal.XMLHttpRequest.prototype.open;
    const origSend = targetGlobal.XMLHttpRequest.prototype.send;
    targetGlobal.XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      const m = String(method).toUpperCase();
      const u = typeof url === 'string' ? url : url.href;
      if ((m !== 'GET' && m !== 'HEAD') || !isAllowedReadOnlyAssetUrl(u, origin)) {
        counters.blockedNetworkAttempts += 1;
        throw new PrivacyPolicyError(`XMLHttpRequest blocked (${m}).`);
      }
      return origOpen.call(this, m, url, async ?? true, username, password);
    };
    targetGlobal.XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      if (body !== undefined && body !== null) {
        counters.blockedNetworkAttempts += 1;
        throw new PrivacyPolicyError('XMLHttpRequest payload body transmission is prohibited.');
      }
      return origSend.call(this, null);
    };
  }

  // Block microphone capture (getUserMedia) in v1 — system audio via getDisplayMedia only
  if (
    typeof targetGlobal.navigator !== 'undefined' &&
    targetGlobal.navigator.mediaDevices &&
    typeof targetGlobal.navigator.mediaDevices.getUserMedia === 'function'
  ) {
    targetGlobal.navigator.mediaDevices.getUserMedia = async () => {
      counters.microphoneAttempts += 1;
      throw new PrivacyPolicyError(
        'Microphone capture is disabled in v1. Only Windows system audio via screen sharing is permitted.',
      );
    };
  }

  // Block ServiceWorker registration so no background listener can survive tab close
  if (
    typeof targetGlobal.navigator !== 'undefined' &&
    targetGlobal.navigator.serviceWorker &&
    typeof targetGlobal.navigator.serviceWorker.register === 'function'
  ) {
    targetGlobal.navigator.serviceWorker.register = async () => {
      throw new PrivacyPolicyError(
        'Service Worker registration is disabled so no background process can persist.',
      );
    };
  }

  guardsInstalled = true;
}

export function recordWorkerAuditEntry(entry: NetworkAuditEntry): void {
  pushAuditEntry(entry);
}

export function getNetworkAuditEntries(): NetworkAuditEntry[] {
  return [...auditEntries];
}

export function getPrivacyGuardCounters(): Readonly<PrivacyGuardCounters> {
  return { ...counters };
}

export function isPrivacyGuardInstalled(): boolean {
  return guardsInstalled;
}

/**
 * Resets transient in-memory audit state during unit tests or full session reset.
 */
export function clearNetworkAuditSessionLog(): void {
  auditEntries.length = 0;
}
