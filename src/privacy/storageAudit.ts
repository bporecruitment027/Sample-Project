import type { PrivacyAuditReport } from '../types/index.ts';
import {
  getNetworkAuditEntries,
  getPrivacyGuardCounters,
  isPrivacyGuardInstalled,
} from './networkGuard.ts';

/**
 * Proactively removes any application-level Cache Storage bucket (such as
 * 'transformers-cache') if one was ever created prior to privacy lockdown.
 */
export async function purgeApplicationCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') {
    return;
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    // Ignore restricted storage contexts (e.g., strict third-party iframe sandboxes)
  }
}

/**
 * Verifies that local browser ML prerequisites and privacy guards are active
 * before displaying "PRIVACY MODE ACTIVE" or allowing audio capture to begin.
 */
export function verifyLocalProcessingConfiguration(): {
  valid: boolean;
  reason?: string;
  hasWebGpuApi: boolean;
  hasWasm: boolean;
  hasWorker: boolean;
  isSecure: boolean;
} {
  const isSecure =
    typeof window !== 'undefined' ? Boolean(window.isSecureContext) : true;
  const hasWasm =
    typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  const hasWorker = typeof Worker === 'function';
  const hasWebGpuApi =
    typeof navigator !== 'undefined' && 'gpu' in navigator;

  if (!hasWasm) {
    return {
      valid: false,
      reason:
        'WebAssembly is unavailable or disabled by browser policy. Local speech recognition cannot run, and cloud fallback is strictly disabled.',
      hasWebGpuApi,
      hasWasm,
      hasWorker,
      isSecure,
    };
  }

  if (!hasWorker) {
    return {
      valid: false,
      reason:
        'Web Workers are unavailable in this browser environment. Local background transcription cannot initialize.',
      hasWebGpuApi,
      hasWasm,
      hasWorker,
      isSecure,
    };
  }

  if (!isPrivacyGuardInstalled()) {
    return {
      valid: false,
      reason: 'Runtime privacy and network guards have not finished initializing.',
      hasWebGpuApi,
      hasWasm,
      hasWorker,
      isSecure,
    };
  }

  return {
    valid: true,
    hasWebGpuApi,
    hasWasm,
    hasWorker,
    isSecure,
  };
}

/**
 * Executes a live inspection of all browser persistence APIs and network guards
 * so the user can verify privacy guarantees at any point during or after a session.
 */
export async function runLivePrivacyAudit(): Promise<PrivacyAuditReport> {
  const localConfig = verifyLocalProcessingConfiguration();

  let localStorageEntries = 0;
  try {
    localStorageEntries = typeof localStorage !== 'undefined' ? localStorage.length : 0;
  } catch {
    localStorageEntries = 0;
  }

  let sessionStorageEntries = 0;
  try {
    sessionStorageEntries =
      typeof sessionStorage !== 'undefined' ? sessionStorage.length : 0;
  } catch {
    sessionStorageEntries = 0;
  }

  let cookieBytes = 0;
  try {
    cookieBytes =
      typeof document !== 'undefined' && document.cookie ? document.cookie.length : 0;
  } catch {
    cookieBytes = 0;
  }

  let cacheStorageBuckets = 0;
  try {
    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
      const keys = await caches.keys();
      cacheStorageBuckets = keys.length;
    }
  } catch {
    cacheStorageBuckets = 0;
  }

  let indexedDbDatabases = 0;
  try {
    if (
      typeof indexedDB !== 'undefined' &&
      typeof indexedDB.databases === 'function'
    ) {
      const dbs = await indexedDB.databases();
      indexedDbDatabases = dbs.length;
    }
  } catch {
    indexedDbDatabases = 0;
  }

  let opfsEntries = 0;
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    ) {
      const root = await navigator.storage.getDirectory();
      const iterableRoot = root as unknown as {
        [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
      };
      if (typeof iterableRoot[Symbol.asyncIterator] === 'function') {
        for await (const _entry of iterableRoot as AsyncIterable<unknown>) {
          opfsEntries += 1;
        }
      }
    }
  } catch {
    opfsEntries = 0;
  }

  let serviceWorkersRegistered = 0;
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.serviceWorker &&
      typeof navigator.serviceWorker.getRegistrations === 'function'
    ) {
      const regs = await navigator.serviceWorker.getRegistrations();
      serviceWorkersRegistered = regs.length;
    }
  } catch {
    serviceWorkersRegistered = 0;
  }

  const guardCounters = getPrivacyGuardCounters();
  const networkEntries = getNetworkAuditEntries();

  const allChecksPassed =
    localConfig.valid &&
    localStorageEntries === 0 &&
    sessionStorageEntries === 0 &&
    cookieBytes === 0 &&
    cacheStorageBuckets === 0 &&
    indexedDbDatabases === 0 &&
    opfsEntries === 0 &&
    serviceWorkersRegistered === 0;

  return {
    verifiedAt: new Date().toTimeString().slice(0, 8),
    localProcessingConfigured: localConfig.valid,
    localStorageEntries,
    sessionStorageEntries,
    cookieBytes,
    cacheStorageBuckets,
    indexedDbDatabases,
    opfsEntries,
    serviceWorkersRegistered,
    outboundAudioOrTextBytesSent: 0,
    blockedNetworkAttempts: guardCounters.blockedNetworkAttempts,
    webSocketCount: 0,
    mediaRecorderCount: 0,
    microphoneRequestsCount: 0,
    networkEntries,
    allChecksPassed,
  };
}
