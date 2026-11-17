const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 bytes of a string, normalized to NFC so the same password typed on any device gives the same bytes. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text.normalize("NFC"));
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Standard Base64 with padding (RFC 4648 §4), the format java.util.Base64 uses on Android. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("Invalid hex");
    bytes[i] = byte;
  }
  return bytes;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  return concatAll(parts);
}

/** concat for a list of any length (a spread of a very long list could overflow the call stack). */
export function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** True when both arrays hold the same bytes; takes the same time wherever they differ. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
