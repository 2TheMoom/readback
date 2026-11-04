// What the web app shows: every check Readback made under a verified mandate (activity), and payments
// waiting for the owner (holds). Kept in memory and appended to READBACK_DATA_DIR (default ~/.readback/data).
//
// The inbox is a mailbox, not an authority. An approval here is only a signature the owner made in their
// wallet; the agent re-checks that signature against its own copy of the text and its own nonce
// (agent/src/approval.ts). Known limits: anyone holding a signed mandate can add activity or holds under it
// (they cannot approve them), and reads are not authenticated, so bind to 127.0.0.1 or add sign-in before
// exposing it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { approvalText, APPROVAL_RECIPIENT } from '../../agent/src/approval.ts';
import { verifyNep413 } from './nep413.ts';
import { isFullAccessKey, type Fetch } from './rpc.ts';
import type { ReadbackRequest, ReadbackResponse } from './readback.ts';

const HOLD_TTL_MS = 10 * 60_000;
const MAX_ACTIVITY = 1000;

export interface Activity {
  id: string; at: string; owner: string; agent: string; kind: string; verdict: string; reason?: string;
  checks: Record<string, string>; why?: Record<string, string>; sentence?: unknown; recipient?: string;
  request_hash?: string; quote_hash?: string; receipt?: unknown; engine_sha256: string; mandate_id: string;
}
export interface Hold {
  id: string; owner: string; agent: string; review: any; nonce: string; message: string; recipient: string;
  status: 'pending' | 'approved' | 'refused' | 'expired'; created: string; expires: string;
  approval?: { publicKey: string; signature: string; at: string }; decided?: string;
}

export function createInbox(dir = process.env.READBACK_DATA_DIR ?? join(homedir(), '.readback', 'data'), now = () => Date.now()) {
  mkdirSync(dir, { recursive: true });
  const actFile = join(dir, 'activity.jsonl'), holdFile = join(dir, 'holds.json');
  const activity: Activity[] = existsSync(actFile) ? readFileSync(actFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-MAX_ACTIVITY) : [];
  const holds = new Map<string, Hold>(existsSync(holdFile) ? Object.entries(JSON.parse(readFileSync(holdFile, 'utf8'))) : []);
  const saveHolds = () => writeFileSync(holdFile, JSON.stringify(Object.fromEntries(holds), null, 1));
  const expire = (h: Hold) => { if (h.status === 'pending' && Date.parse(h.expires) < now()) { h.status = 'expired'; saveHolds(); } return h; };

  /** One check, recorded only when the mandate verified: unverified requests say nothing about any owner. */
  function record(req: ReadbackRequest, res: ReadbackResponse): Activity | null {
    if (!res.mandate_fingerprint) return null;
    const m = req.signed_mandate.mandate;
    const a: Activity = {
      id: `a_${now().toString(36)}_${activity.length}`, at: new Date(now()).toISOString(), owner: m.owner, agent: req.agent ?? m.agent,
      kind: req.kind, verdict: res.verdict, reason: res.reason, checks: res.checks, why: res.why, sentence: res.sentence,
      recipient: req.quote?.quoteRequest?.recipient, request_hash: res.request_hash, quote_hash: res.quote_hash,
      receipt: res.receipt, engine_sha256: res.engine_sha256, mandate_id: m.id,
    };
    activity.push(a);
    if (activity.length > MAX_ACTIVITY) activity.shift();
    appendFileSync(actFile, JSON.stringify(a) + '\n');
    return a;
  }

  /** A hold the agent posts. Its text must be the approval text the agent will verify, word for word. */
  function addHold(b: any): { ok: true; hold: Hold } | { ok: false; reason: string } {
    if (!b || typeof b.id !== 'string' || !/^h_[A-Za-z0-9_-]{12}$/.test(b.id)) return { ok: false, reason: 'bad_id' };
    if (holds.has(b.id)) return { ok: false, reason: 'duplicate' };
    if (typeof b.owner !== 'string' || typeof b.agent !== 'string' || !b.review || typeof b.review.sentence !== 'string' || !Array.isArray(b.review.holds) || !/^[0-9a-f]{64}$/.test(String(b.review.request_hash))) return { ok: false, reason: 'bad_hold' };
    if (typeof b.nonce !== 'string' || Buffer.from(b.nonce, 'base64').length !== 32) return { ok: false, reason: 'bad_nonce' };
    if (b.recipient !== APPROVAL_RECIPIENT) return { ok: false, reason: 'bad_recipient' };
    let message: string;
    try { message = approvalText({ id: b.id, owner: b.owner, agent: b.agent, review: b.review }); } catch { return { ok: false, reason: 'bad_hold' }; }
    if (b.message !== message) return { ok: false, reason: 'message_mismatch' };
    const t = now();
    const hold: Hold = { id: b.id, owner: b.owner, agent: b.agent, review: b.review, nonce: b.nonce, message, recipient: APPROVAL_RECIPIENT, status: 'pending', created: new Date(t).toISOString(), expires: new Date(t + HOLD_TTL_MS).toISOString() };
    holds.set(hold.id, hold);
    saveHolds();
    return { ok: true, hold };
  }

  /** Accept an approval only if it is the owner's signature, by a full-access key, over this hold's text. */
  async function approve(id: string, sig: any, f: Fetch): Promise<{ ok: boolean; reason: string }> {
    const h = holds.get(id);
    if (!h) return { ok: false, reason: 'not_found' };
    if (expire(h).status !== 'pending') return { ok: false, reason: h.status };
    if (!sig || typeof sig.publicKey !== 'string' || typeof sig.signature !== 'string') return { ok: false, reason: 'bad_signature' };
    if (sig.accountId !== undefined && sig.accountId !== h.owner) return { ok: false, reason: 'signer_is_not_owner' };
    if (!verifyNep413(sig, h.message, new Uint8Array(Buffer.from(h.nonce, 'base64')), h.recipient)) {
      // Public values only: enough to work out which bytes a wallet really signed.
      console.warn(`rejected approval for ${id}: ${JSON.stringify({ publicKey: sig.publicKey, signature: sig.signature, accountId: sig.accountId })}`);
      return { ok: false, reason: 'bad_signature' };
    }
    const key = await isFullAccessKey(f, h.owner, sig.publicKey);
    if (!key.ok) return { ok: false, reason: `key_${key.reason}` };
    if (expire(h).status !== 'pending') return { ok: false, reason: h.status };
    h.status = 'approved'; h.approval = { publicKey: sig.publicKey, signature: sig.signature, at: new Date(now()).toISOString() }; h.decided = h.approval.at;
    saveHolds();
    return { ok: true, reason: 'approved' };
  }

  function refuse(id: string): { ok: boolean; reason: string } {
    const h = holds.get(id);
    if (!h) return { ok: false, reason: 'not_found' };
    if (expire(h).status !== 'pending') return { ok: false, reason: h.status };
    h.status = 'refused'; h.decided = new Date(now()).toISOString();
    saveHolds();
    return { ok: true, reason: 'refused' };
  }

  const getHold = (id: string) => { const h = holds.get(id); return h ? expire(h) : null; };
  const listHolds = (owner: string) => [...holds.values()].filter((h) => h.owner === owner).map(expire).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 100);
  const listActivity = (owner: string, limit = 100) => activity.filter((a) => a.owner === owner).slice(-limit).reverse();

  return { record, addHold, approve, refuse, getHold, listHolds, listActivity };
}
export type Inbox = ReturnType<typeof createInbox>;
