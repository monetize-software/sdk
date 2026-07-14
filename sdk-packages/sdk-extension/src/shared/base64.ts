// Base64 helpers for shipping binary through chrome.runtime ports. Port
// messages are JSON-serialized (NOT structured-cloned — see crbug.com/248548),
// so File/Blob/ArrayBuffer silently degrade to `{}`. The only JSON-safe way to
// move bytes is a string; base64 is the compact one (+33% vs +300..400% for a
// number array).
//
// Chunked conversion: String.fromCharCode(...bytes) blows the call stack on
// megabyte files, so we build the binary string in 32KB slices.

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
