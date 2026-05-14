import { PaywallError } from '@sdk/core/types';
import type { SerializedError } from './protocol';

// Сериализация PaywallError в плоский JSON для chrome.runtime messaging
// (Error через structured cloning теряет class identity — instanceof ломается).
// Reconstruct на content-стороне восстанавливает PaywallError, host'ы пишут
// `if (e instanceof PaywallError)` как обычно.

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
