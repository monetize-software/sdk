// PKCE helper for the AuthClient OAuth flow. RFC 7636 standard:
// - verifier — a random URL-safe string of length 43..128 (we use 64).
// - challenge — base64url(SHA-256(verifier)).
// The SDK keeps the verifier in memory (Map<state, verifier>) until the popup
// returns. The verifier never goes to the backend before /oauth/exchange.

function randomBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  const c =
    typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    // Fallback to Math.random — needed only for exotic runtimes
    // (old e2e mocks). In the extension/web runtime crypto is always present.
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  // 64 bytes → 86 base64url chars, falls within [43, 128].
  return base64url(randomBytes(64));
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder().encode(verifier);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle?.digest) {
    // PKCE doesn't work without SubtleCrypto: we can't compute SHA-256
    // deterministically. In SDK 3.0 runtimes (web + chrome.extension MV3)
    // SubtleCrypto is always present. If someone plugs the SDK into node
    // without a polyfill, be honest and fail rather than silently downgrade
    // the challenge_method.
    throw new Error('crypto.subtle is required for PKCE');
  }
  const hash = await c.subtle.digest('SHA-256', enc);
  return base64url(new Uint8Array(hash));
}

export function generateState(): string {
  return base64url(randomBytes(16));
}
