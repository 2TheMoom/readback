// Test helpers: fixtures from docs/test-vectors and a fake fetch that answers like the real APIs.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { randomBytes } from 'node:crypto';
import { nep413Hash } from '../src/nep413.ts';
import { mandateMessage, MANDATE_RECIPIENT, type Mandate, type SignedMandate } from '../src/mandate.ts';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'test-vectors');
export const load = (rel: string) => JSON.parse(readFileSync(join(VEC, rel), 'utf8'));

/** A mandate built from a fixture mandate plus the display fields the signed message needs. */
export function mandateFrom(id: 'M1' | 'M2' | 'M3'): Mandate {
  const m = load('fixtures/mandates.json')[id];
  return { ...m, cap_symbol: 'USDC', cap_decimals: 6 };
}

export function newKey() {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, publicKey: 'ed25519:' + base58.encode(ed25519.getPublicKey(secret)) };
}

export function signMandate(m: Mandate, key = newKey(), accountId = m.owner): { signed: SignedMandate; key: ReturnType<typeof newKey> } {
  const nonce = new Uint8Array(randomBytes(32));
  const sig = ed25519.sign(nep413Hash(mandateMessage(m), nonce, MANDATE_RECIPIENT), key.secret);
  return { key, signed: { mandate: m, signature: { accountId, publicKey: key.publicKey, signature: Buffer.from(sig).toString('base64'), nonce: Buffer.from(nonce).toString('base64') } } };
}

export interface FakeChain {
  /** "account:public key" or public key -> permission answer for NEAR view_access_key */
  nearKeys?: Record<string, 'FullAccess' | 'FunctionCall' | 'missing'>;
  /** Solana account answers per RPC index: null = no account */
  sol?: Array<{ owner: string; data_len: number } | null | 'down'>;
  /** EVM eth_getCode answers per RPC index */
  evm?: Array<string | 'down'>;
  tokensDown?: boolean;
}

export function fakeFetch(chain: FakeChain): typeof fetch {
  const tokens = Object.entries(load('fixtures/tokens.json')).map(([assetId, t]: [string, any]) => ({ assetId, ...t }));
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('1click.chaindefuser.com/v0/tokens')) return chain.tokensDown ? new Response('down', { status: 503 }) : ok(tokens);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === 'query') {
      const p = chain.nearKeys?.[`${body.params.account_id}:${body.params.public_key}`] ?? chain.nearKeys?.[body.params.public_key] ?? 'missing';
      if (p === 'missing') return ok({ jsonrpc: '2.0', id: 1, result: { error: `access key ${body.params.public_key} does not exist while viewing` } });
      return ok({ jsonrpc: '2.0', id: 1, result: { nonce: 1, permission: p === 'FullAccess' ? 'FullAccess' : { FunctionCall: { allowance: null, receiver_id: 'x.near', method_names: [] } } } });
    }
    if (body.method === 'getAccountInfo') {
      const i = u.includes('publicnode') ? 1 : 0;
      const a = chain.sol?.[i];
      if (a === 'down' || a === undefined) throw new TypeError('fetch failed');
      return ok({ jsonrpc: '2.0', id: 1, result: { value: a === null ? null : { owner: a.owner, data: [Buffer.alloc(a.data_len).toString('base64'), 'base64'] } } });
    }
    if (body.method === 'eth_getCode') {
      const i = u.includes('publicnode') ? 1 : 0;
      const c = chain.evm?.[i];
      if (c === 'down' || c === undefined) throw new TypeError('fetch failed');
      return ok({ jsonrpc: '2.0', id: 1, result: c });
    }
    throw new Error('unexpected fetch ' + u);
  }) as typeof fetch;
}

export const WALLET = { owner: '11111111111111111111111111111111', data_len: 0 };
