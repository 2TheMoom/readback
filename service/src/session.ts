// Owner sign-in for the web app. The queue shows an owner's payments, so it is readable only by someone who
// proves they hold a full-access key on that account: the wallet signs one NEP-413 message (not a transaction)
// over a server nonce, and the server answers with a session in an HttpOnly cookie that page scripts cannot read.
//
// The sign-in text never starts like an approval ("Readback: approve ...") and approvals are checked against
// the agent's own text and nonce, so a sign-in signature can never stand in for an approval.

import { randomBytes } from 'node:crypto';
import { verifyNep413 } from './nep413.ts';
import { isFullAccessKey, type Fetch } from './rpc.ts';
import { APPROVAL_RECIPIENT } from '../../agent/src/approval.ts';

const NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
export const COOKIE = 'rb_session';

export function signInText(account: string, site: string): string {
  return [
    `Readback sign-in for ${account}.`,
    'This proves you control the account so Readback can show you its payments.',
    'It is not a transaction and moves nothing.',
    `Site: ${site}`,
  ].join('\n');
}

export function createSessions(now = () => Date.now()) {
  const nonces = new Map<string, number>();
  const sessions = new Map<string, { account: string; expires: number }>();
  const sweep = () => {
    const t = now();
    for (const [k, e] of nonces) if (e < t) nonces.delete(k);
    for (const [k, s] of sessions) if (s.expires < t) sessions.delete(k);
  };

  /** A one-time nonce for the sign-in message. */
  function challenge(): { nonce: string; recipient: string } {
    sweep();
    const nonce = randomBytes(32).toString('base64');
    nonces.set(nonce, now() + NONCE_TTL_MS);
    return { nonce, recipient: APPROVAL_RECIPIENT };
  }

  /** Accept a sign-in only for an unused nonce, the exact text, and a full-access key on that account. */
  async function signIn(f: Fetch, b: any, site: string): Promise<{ ok: true; token: string; account: string } | { ok: false; reason: string }> {
    sweep();
    if (!b || typeof b.accountId !== 'string' || typeof b.publicKey !== 'string' || typeof b.signature !== 'string' || typeof b.nonce !== 'string') return { ok: false, reason: 'bad_request' };
    if (!nonces.has(b.nonce)) return { ok: false, reason: 'unknown_or_used_nonce' };
    nonces.delete(b.nonce);
    const nonce = new Uint8Array(Buffer.from(b.nonce, 'base64'));
    if (nonce.length !== 32 || !verifyNep413(b, signInText(b.accountId, site), nonce, APPROVAL_RECIPIENT)) return { ok: false, reason: 'bad_signature' };
    const key = await isFullAccessKey(f, b.accountId, b.publicKey);
    if (!key.ok) return { ok: false, reason: `key_${key.reason}` };
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { account: b.accountId, expires: now() + SESSION_TTL_MS });
    return { ok: true, token, account: b.accountId };
  }

  function accountOf(cookieHeader: string | undefined): string | null {
    const m = /(?:^|;\s*)rb_session=([A-Za-z0-9_-]{43})/.exec(cookieHeader ?? '');
    const s = m ? sessions.get(m[1]) : undefined;
    return s && s.expires > now() ? s.account : null;
  }

  function signOut(cookieHeader: string | undefined) {
    const m = /(?:^|;\s*)rb_session=([A-Za-z0-9_-]{43})/.exec(cookieHeader ?? '');
    if (m) sessions.delete(m[1]);
  }

  return { challenge, signIn, accountOf, signOut, ttlSeconds: SESSION_TTL_MS / 1000 };
}
export type Sessions = ReturnType<typeof createSessions>;
