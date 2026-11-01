// 1Click calls for one payment from the agent's intents.near balance: quote, generate the intent for the
// agent's account, sign it (NEP-413, recipient intents.near) and submit it.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import type { AgentKey } from './key.ts';

type Fetch = typeof fetch;
const ONECLICK = process.env.READBACK_ONECLICK ?? 'https://1click.chaindefuser.com';

async function post(f: Fetch, path: string, body: unknown): Promise<any> {
  const r = await f(ONECLICK + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`1click ${path} http_${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export interface QuoteAsk { originAsset: string; destinationAsset: string; amount: string; recipient: string; refundTo: string; slippageBps: number }

/** A real (non-dry) quote: 1Click issues a deposit address. No funds move until a signed intent is submitted. */
export function getQuote(f: Fetch, a: QuoteAsk) {
  return post(f, '/v0/quote', {
    dry: false, depositMode: 'SIMPLE', swapType: 'EXACT_INPUT', slippageTolerance: a.slippageBps,
    originAsset: a.originAsset, depositType: 'INTENTS', destinationAsset: a.destinationAsset, amount: a.amount,
    refundTo: a.refundTo, refundType: 'INTENTS', recipient: a.recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
}

export function generateIntent(f: Fetch, depositAddress: string, signerId: string) {
  return post(f, '/v0/generate-intent', { type: 'swap_transfer', standard: 'nep413', signerId, depositAddress });
}

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const str = (s: string) => { const u = new TextEncoder().encode(s); return concat(u32(u.length), u); };

/** NEP-413 hash (same construction as service/src/nep413.ts, checked against near-api-js in the tests). */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string | null): Uint8Array {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const cb = callbackUrl == null ? new Uint8Array([0]) : concat(new Uint8Array([1]), str(callbackUrl));
  return sha256(concat(u32(2147484061), str(message), nonce, str(recipient), cb));
}

export interface SignedIntent { standard: 'nep413'; payload: { message: string; nonce: string; recipient: string }; public_key: string; signature: string }

/** Sign exactly the payload 1Click generated. Refuses anything not addressed to intents.near. */
export function signIntent(payload: { message: string; nonce: string; recipient: string; callbackUrl?: string | null }, key: AgentKey): SignedIntent {
  if (payload.recipient !== 'intents.near') throw new Error(`refusing to sign for ${payload.recipient}`);
  const nonce = new Uint8Array(Buffer.from(payload.nonce, 'base64'));
  const sig = ed25519.sign(nep413Hash(payload.message, nonce, payload.recipient, payload.callbackUrl), key.secret);
  return { standard: 'nep413', payload: { message: payload.message, nonce: payload.nonce, recipient: payload.recipient }, public_key: key.publicKey, signature: 'ed25519:' + base58.encode(sig) };
}

export async function submitIntent(f: Fetch, signed: SignedIntent): Promise<string> {
  return (await post(f, '/v0/submit-intent', { type: 'swap_transfer', signedData: signed })).intentHash;
}
