// PKCE helper для OAuth-флоу AuthClient. Стандарт RFC 7636:
// - verifier — random URL-safe string длины 43..128 (мы берём 64).
// - challenge — base64url(SHA-256(verifier)).
// SDK хранит verifier в памяти (Map<state, verifier>) до возврата
// popup'а. Verifier никогда не уходит на бэк до /oauth/exchange.

function randomBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  const c =
    typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    // Fallback на Math.random — нужен только для exotic-рантаймов
    // (старые e2e-моки). В extension/web рантайме crypto всегда есть.
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
  // 64 байта → 86 base64url-символов, попадает в [43, 128].
  return base64url(randomBytes(64));
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder().encode(verifier);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle?.digest) {
    // PKCE без SubtleCrypto не работает: мы не можем посчитать SHA-256
    // детерминированно. В рантаймах SDK 3.0 (web + chrome.extension MV3)
    // SubtleCrypto есть всегда. Если кто-то воткнёт SDK в node без polyfill,
    // нужно быть честным и упасть, а не молча даунгрейдить challenge_method.
    throw new Error('crypto.subtle is required for PKCE');
  }
  const hash = await c.subtle.digest('SHA-256', enc);
  return base64url(new Uint8Array(hash));
}

export function generateState(): string {
  return base64url(randomBytes(16));
}
