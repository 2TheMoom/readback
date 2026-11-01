// Owner mandates. The owner signs the mandate with NEP-413 in their own wallet. Wallets show only the
// message text (research/s8-wallet, Meteor), so the message IS the readable mandate: full addresses and
// limits in plain words, plus a fingerprint binding the exact JSON. The service re-renders the message
// from the JSON and accepts the signature only if it matches word for word.

import { createHash } from 'node:crypto';
import { verifyNep413 } from './nep413.ts';
import { isFullAccessKey, type Fetch } from './rpc.ts';

export interface Payee { label: string; chain: string; address: string }
export interface Mandate {
  id: string; owner: string; agent: string; dest_chain: string; payees: Payee[];
  origin_assets: string[]; destination_assets: string[];
  cap: string; cap_symbol: string; cap_decimals: number;
  max_slippage_bps: number; refund_to: string[]; min_review_seconds: number; valid_until: string;
  fees?: { max_pct: number; same_value_assets: boolean };
}
export interface SignedMandate { mandate: Mandate; signature: { accountId: string; publicKey: string; signature: string; nonce: string } }

/** Recursive key-sorted compact JSON: one canonical form for hashing. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
}

export function fingerprint(m: Mandate): string {
  return createHash('sha256').update(canonical(m)).digest('hex');
}

function units(amount: string, decimals: number): string {
  if (!/^\d+$/.test(amount)) return amount;
  const s = amount.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** The exact text the owner signs. Changing any field changes this text. */
export function mandateMessage(m: Mandate): string {
  const payees = m.payees.map((p) => `${p.label} (${p.chain} ${p.address})`).join(', ');
  return [
    `Readback mandate ${m.id} for ${m.owner}.`,
    `${m.agent} may pay ${payees}, up to ${units(m.cap, m.cap_decimals)} ${m.cap_symbol} per payment, with slippage up to ${m.max_slippage_bps / 100}%.`,
    `Refunds go to ${m.refund_to.join(', ')}. Valid until ${m.valid_until}.`,
    `Anything else is held for me or refused.`,
    `Fingerprint: sha256:${fingerprint(m)}`,
  ].join('\n');
}

export const MANDATE_RECIPIENT = process.env.READBACK_RECIPIENT ?? 'readback.app';

/** Accept a mandate only if its owner signed exactly this mandate with a full-access key. */
export async function verifyMandate(f: Fetch, sm: SignedMandate): Promise<{ ok: boolean; reason: string }> {
  const { mandate: m, signature: s } = sm ?? ({} as SignedMandate);
  if (!m || !s) return { ok: false, reason: 'missing' };
  if (s.accountId !== m.owner) return { ok: false, reason: 'signer_is_not_owner' };
  let nonce: Uint8Array;
  try { nonce = new Uint8Array(Buffer.from(s.nonce, 'base64')); } catch { return { ok: false, reason: 'bad_nonce' }; }
  if (nonce.length !== 32) return { ok: false, reason: 'bad_nonce' };
  let message: string;
  try { message = mandateMessage(m); } catch { return { ok: false, reason: 'malformed_mandate' }; }
  if (!verifyNep413(s, message, nonce, MANDATE_RECIPIENT)) return { ok: false, reason: 'bad_signature' };
  const key = await isFullAccessKey(f, s.accountId, s.publicKey);
  return key.ok ? { ok: true, reason: 'ok' } : { ok: false, reason: `key_${key.reason}` };
}
