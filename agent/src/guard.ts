// Agent-side guard: the only path from an agent to its signer. Every payment is read back by Readback
// first. REFUSED never reaches the signer, HOLD waits for a human, and anything unexpected (Readback
// unreachable, a malformed answer, an answer for a different request or mandate) counts as REFUSED.
// The signer receives a frozen copy of exactly what was checked, so nothing can be swapped in between.

import { createHash } from 'node:crypto';

export type Verdict = 'CLEARED' | 'HOLD' | 'REFUSED';
export interface PaymentRequest { kind: 'quote' | 'intent'; quote: unknown; intent?: unknown }
export interface SignedMandate { mandate: Record<string, unknown>; signature: Record<string, unknown> }
export interface Hold { check: string; status: string; why?: string }

/** What the human is shown on HOLD. `message` is the full text to show them. */
export interface Review { sentence: string; holds: Hold[]; request_hash: string; quote_hash?: string; message: string }
/** Resolve to exactly `true` to approve. Any other value, a throw or a timeout declines. */
export type Human = (review: Review) => Promise<unknown>;

export interface GuardOptions {
  /** Readback guard API base URL, for example http://127.0.0.1:8787 */
  url: string;
  signedMandate: SignedMandate;
  agent: string;
  askHuman?: Human;
  /** Accepted engine_sha256 values. Empty accepts any engine. */
  engines?: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  humanTimeoutMs?: number;
}

export interface Decision<T = unknown> {
  outcome: 'executed' | 'refused' | 'held' | 'failed';
  verdict: Verdict;
  reason: string;
  sentence?: string;
  request_hash: string;
  holds: Hold[];
  /** One plain line for the agent's model: what happened and what to do next. */
  note: string;
  result?: T;
  error?: string;
}

interface Checked { verdict: Verdict; reason: string; sentence?: string; holds: Hold[]; quote_hash?: string }

/** Recursive key-sorted compact JSON, the same canonical form the service hashes. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function requestHash(agent: string, req: PaymentRequest, mandate: unknown): string {
  return sha256(canonical({ kind: req.kind, agent, quote: req.quote, intent: req.intent ?? null, mandate }));
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) deepFreeze((v as any)[k]); Object.freeze(v); }
  return v;
}

/** The sentence shortens addresses; the human deciding gets the full one, since lookalikes differ in the middle. */
export function approvalMessage(sentence: string, holds: Hold[], hash: string, recipient?: string): string {
  return [
    'Readback is holding a payment for you.',
    sentence,
    ...(recipient ? [`Full recipient address: ${recipient}`] : []),
    `Held because: ${holds.map((h) => `${h.check} (${h.why ?? h.status})`).join('; ')}`,
    `Request: sha256:${hash}`,
    'Approve only if you expected exactly this payment.',
  ].join('\n');
}

function recipientOf(req: PaymentRequest): string | undefined {
  const r = (req.quote as any)?.quoteRequest?.recipient;
  return typeof r === 'string' ? r : undefined;
}

const sameOrFewerHolds =(now: Hold[], approved: Hold[]) =>
  now.every((h) => approved.some((a) => a.check === h.check && a.status === h.status && a.why === h.why));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

export function createGuard(opts: GuardOptions) {
  const f = opts.fetch ?? fetch;
  const url = opts.url.replace(/\/+$/, '') + '/v1/readback';
  const mandate = opts.signedMandate?.mandate;
  const fingerprint = sha256(canonical(mandate));
  const refused = (reason: string): Checked => ({ verdict: 'REFUSED', reason, holds: [] });

  /** Ask Readback about one payment and check that the answer is about this payment. */
  async function check(req: PaymentRequest, hash: string): Promise<Checked> {
    let r: any;
    try {
      const res = await f(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: req.kind, agent: opts.agent, quote: req.quote, intent: req.intent, signed_mandate: opts.signedMandate }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) return refused(`guard_http_${res.status}`);
      r = await res.json();
    } catch {
      return refused('guard_unreachable');
    }
    if (!r || typeof r !== 'object' || !['CLEARED', 'HOLD', 'REFUSED'].includes(r.verdict)) return refused('guard_bad_answer');
    const checks: Record<string, string> = r.checks && typeof r.checks === 'object' ? r.checks : {};
    const why: Record<string, string> = r.why && typeof r.why === 'object' ? r.why : {};
    const holds = Object.keys(checks).filter((k) => checks[k] !== 'ok').sort().map((k) => ({ check: k, status: String(checks[k]), ...(why[k] ? { why: String(why[k]) } : {}) }));
    const sentence = typeof r.sentence?.text === 'string' ? r.sentence.text : undefined;
    if (r.verdict === 'REFUSED') return { verdict: 'REFUSED', reason: r.reason ?? (holds.filter((h) => h.status === 'bad').map((h) => h.why ?? h.check).join(', ') || 'refused'), sentence, holds };
    if (r.request_hash !== hash) return refused('answer_for_other_request');
    if (r.mandate_fingerprint !== fingerprint) return refused('answer_for_other_mandate');
    if (opts.engines?.length && !opts.engines.includes(r.engine_sha256)) return refused('engine_not_pinned');
    if (!sentence) return refused('guard_bad_answer');
    const statuses = Object.values(checks);
    if (r.verdict === 'CLEARED' && (statuses.length === 0 || holds.length > 0)) return refused('inconsistent_answer');
    if (r.verdict === 'HOLD' && (holds.length === 0 || statuses.includes('bad'))) return refused('inconsistent_answer');
    return { verdict: r.verdict, reason: r.verdict === 'CLEARED' ? 'cleared' : 'held', sentence, holds, quote_hash: r.quote_hash };
  }

  /**
   * Pay through Readback. `execute` (the agent's signer) is called at most once, only after CLEARED or a
   * human-approved HOLD, with a frozen copy of the request that was checked.
   */
  async function pay<T>(request: PaymentRequest, execute: (checked: Readonly<PaymentRequest>) => Promise<T>): Promise<Decision<T>> {
    let req: PaymentRequest;
    try { req = deepFreeze(JSON.parse(JSON.stringify({ kind: request.kind, quote: request.quote, intent: request.intent }))); }
    catch { req = { kind: 'quote', quote: null }; }
    const hash = requestHash(opts.agent, req, mandate);
    const done = (c: Checked, outcome: Decision['outcome'], reason = c.reason, extra: Partial<Decision<T>> = {}): Decision<T> => ({
      outcome, verdict: c.verdict, reason, sentence: c.sentence, request_hash: hash, holds: c.holds, note: note(outcome, c, reason), ...extra,
    });

    const first = await check(req, hash);
    if (first.verdict === 'REFUSED') return done(first, 'refused');
    let final = first;
    if (first.verdict === 'HOLD') {
      if (!opts.askHuman) return done(first, 'held', 'no_human');
      let approved: unknown;
      try { approved = await withTimeout(Promise.resolve(opts.askHuman({ sentence: first.sentence!, holds: first.holds, request_hash: hash, quote_hash: first.quote_hash, message: approvalMessage(first.sentence!, first.holds, hash, recipientOf(req)) })), opts.humanTimeoutMs ?? 600_000); }
      catch (e) { return done(first, 'held', (e as Error)?.message === 'timeout' ? 'human_timeout' : 'human_error'); }
      if (approved !== true) return done(first, 'held', 'human_declined');
      // The human answered for what they saw. Look again: anything new since then is refused, not waved through.
      const again = await check(req, hash);
      if (again.verdict === 'REFUSED') return done(again, 'refused');
      if (!sameOrFewerHolds(again.holds, first.holds)) return done({ ...again, verdict: 'REFUSED' }, 'refused', 'changed_since_approval');
      final = again;
    }
    try {
      return done(final, 'executed', final.verdict === 'HOLD' ? 'approved_by_human' : final.reason, { result: await execute(req) });
    } catch (e) {
      return done(final, 'failed', 'signer_failed', { error: String((e as Error)?.message ?? e) });
    }
  }

  return { pay, requestHash: (req: PaymentRequest) => requestHash(opts.agent, req, mandate) };
}

function note(outcome: Decision['outcome'], c: Checked, reason: string): string {
  const what = c.sentence ? ` ${c.sentence}` : '';
  const list = (hs: Hold[]) => hs.map((h) => `${h.check} (${h.why ?? h.status})`).join(', ');
  if (outcome === 'executed') return `Sent.${what}`;
  if (outcome === 'failed') return `Readback allowed it but signing failed.${what}`;
  if (outcome === 'held') return `Held for your owner, not sent: ${reason}.${what} Waiting on: ${list(c.holds)}.`;
  const bad = c.holds.filter((h) => h.status === 'bad');
  return `Refused by Readback, not sent: ${bad.length ? list(bad) : reason}.${what} Do not retry with changed details; tell your owner.`;
}
