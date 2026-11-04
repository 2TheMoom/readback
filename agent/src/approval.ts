// A human who answers from the Readback web app. The agent posts the hold to Readback's inbox and waits; the
// owner reads it in the browser and approves by signing the approval text with their NEAR wallet (NEP-413).
//
// The agent trusts nothing the inbox says. It writes the approval text itself, picks the hold id and the
// nonce, and returns true only for a signature over exactly that text, that nonce and that recipient, made by
// the key that signed the mandate. A compromised inbox can refuse or stall a payment, never approve one.

import { randomBytes } from 'node:crypto';
import { verifyNep413 } from '../../service/src/nep413.ts';
import type { Human, Review, SignedMandate } from './guard.ts';

/** NEP-413 recipient for approvals: the same one the mandate is signed for. */
export const APPROVAL_RECIPIENT = process.env.READBACK_RECIPIENT ?? 'readback.app';

export interface HoldInfo { id: string; owner: string; agent: string; review: Review }

/** The exact text the owner signs to approve one held payment. Wallets show only this text, so it says it all. */
export function approvalText(h: HoldInfo): string {
  return [
    `Readback: approve a payment held for ${h.owner}.`,
    h.review.sentence,
    ...(h.review.recipient ? [`Full recipient address: ${h.review.recipient}`] : []),
    `Held because: ${h.review.holds.map((x) => `${x.check} (${x.why ?? x.status})`).join('; ')}`,
    `Request: sha256:${h.review.request_hash}`,
    `Hold: ${h.id} (agent ${h.agent})`,
    'Sign only if you expected exactly this payment.',
  ].join('\n');
}

export interface WebHumanOptions {
  /** Readback base URL, for example http://127.0.0.1:8787 */
  url: string;
  signedMandate: SignedMandate;
  fetch?: typeof fetch;
  pollMs?: number;
  /** How long to wait for the owner. Defaults to the guard's own human timeout, 10 minutes. */
  waitMs?: number;
  /** Called once the hold is posted, so the agent can say where to approve it. */
  onPosted?: (id: string, approveUrl: string) => void;
}

export function webHuman(opts: WebHumanOptions): Human {
  const f = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, '');
  const m: any = opts.signedMandate.mandate;
  const ownerKey = String((opts.signedMandate.signature as any)?.publicKey ?? '');

  return async (review) => {
    const hold: HoldInfo = { id: `h_${randomBytes(9).toString('base64url')}`, owner: m.owner, agent: m.agent, review };
    const nonce = randomBytes(32);
    const message = approvalText(hold);
    const r = await f(`${base}/v1/holds`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...hold, nonce: nonce.toString('base64'), message, recipient: APPROVAL_RECIPIENT }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`inbox_http_${r.status}`);
    opts.onPosted?.(hold.id, `${base}/#hold-${hold.id}`);

    // Wait for a decision, no longer than the guard would (its timeout is a decline either way).
    for (const end = Date.now() + (opts.waitMs ?? 600_000); Date.now() < end;) {
      await new Promise((res) => setTimeout(res, opts.pollMs ?? 2000));
      let h: any;
      try {
        const g = await f(`${base}/v1/holds/${encodeURIComponent(hold.id)}`, { signal: AbortSignal.timeout(10_000) });
        if (!g.ok) continue;
        h = await g.json();
      } catch { continue; }
      if (h?.status === 'pending') continue;
      if (h?.status !== 'approved') return false;
      const s = h.approval;
      return !!s && s.publicKey === ownerKey && verifyNep413({ publicKey: s.publicKey, signature: s.signature }, message, nonce, APPROVAL_RECIPIENT);
    }
    return false;
  };
}
