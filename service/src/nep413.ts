// NEP-413 message signatures: tag 2^31 + 413 (u32 LE), then borsh {message, nonce[32], recipient,
// callbackUrl: Option<string>}, sha256, ed25519 over the hash. Verified byte for byte against near-api-js's
// reference signatures in research/s8-wallet/s8-nep413.js.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const str = (s: string) => { const u = new TextEncoder().encode(s); return concat(u32(u.length), u); };
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function nep413Hash(message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string | null): Uint8Array {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const cb = callbackUrl == null ? new Uint8Array([0]) : concat(new Uint8Array([1]), str(callbackUrl));
  return sha256(concat(u32(2147484061), str(message), nonce, str(recipient), cb));
}

/** Wallets return the signature base64; some tools use base58. Accept either, only if it is 64 bytes. */
export function decodeSignature(s: string): Uint8Array | null {
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) { const b = Buffer.from(s, 'base64'); if (b.length === 64) return new Uint8Array(b); }
  try { const b = base58.decode(s.replace(/^ed25519:/, '')); if (b.length === 64) return b; } catch { /* not base58 */ }
  return null;
}

export function verifyNep413(sig: { publicKey: string; signature: string }, message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string | null): boolean {
  try {
    if (!sig.publicKey.startsWith('ed25519:')) return false;
    const pk = base58.decode(sig.publicKey.slice(8));
    const s = decodeSignature(sig.signature);
    return pk.length === 32 && s !== null && ed25519.verify(s, nep413Hash(message, nonce, recipient, callbackUrl), pk);
  } catch {
    return false;
  }
}
