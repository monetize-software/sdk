import { PaywallError } from '@sdk/core/types';
import type { SerializedError } from './protocol';

// Serialization of PaywallError into flat JSON for chrome.runtime messaging
// (an Error loses its class identity through structured cloning — instanceof
// breaks). Reconstruct on the content side restores PaywallError, so hosts write
// `if (e instanceof PaywallError)` as usual.

export function serializeError(error: unknown): SerializedError {
  if (error instanceof PaywallError) {
    return {
      name: 'PaywallError',
      code: error.code,
      message: error.message,
      status: error.status,
      stack: error.stack
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      code: 'unknown',
      message: error.message,
      stack: error.stack
    };
  }
  return {
    name: 'Error',
    code: 'unknown',
    message: typeof error === 'string' ? error : 'Unknown error'
  };
}

export function reconstructError(s: SerializedError): Error {
  if (s.name === 'PaywallError') {
    const err = new PaywallError(s.code, s.message, { status: s.status });
    if (s.stack) err.stack = s.stack;
    return err;
  }
  const err = new Error(s.message);
  err.name = s.name;
  if (s.stack) err.stack = s.stack;
  return err;
}
