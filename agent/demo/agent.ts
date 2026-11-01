// The demo agent's one money-moving tool: pay someone from the agent's own intents.near balance. It runs only
// after the start-up self-check passes, and every payment goes through the Readback guard: the intent it signs
// is the frozen copy Readback checked. Submitting is off unless `live` is set.

import { createGuard, type Decision, type Human, type SignedMandate } from '../src/guard.ts';
import { selfCheck, type SelfCheck } from './near.ts';
import { getQuote, generateIntent, signIntent, submitIntent, type SignedIntent } from './intents.ts';
import type { AgentKey } from './key.ts';

type Fetch = typeof fetch;

export interface AgentOptions {
  key: AgentKey;
  signedMandate: SignedMandate;
  readbackUrl: string;
  askHuman?: Human;
  live?: boolean;
  fetch?: Fetch;
  /** Fetch used for Readback only (tests run the service in process). Defaults to `fetch`. */
  readbackFetch?: Fetch;
}

export type PayResult = Decision<{ dry_run: true; signed: SignedIntent } | { intentHash: string }> | { outcome: 'refused'; reason: string; note: string };

/** Smallest units from a decimal amount, without floating point ("2.5", 6 -> "2500000"). */
export function toUnits(amount: string, decimals: number): string | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m || (m[2] ?? '').length > decimals) return null;
  const units = (m[1] + (m[2] ?? '').padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  return /^0+$/.test(units) ? null : units;
}

export async function startAgent(opts: AgentOptions) {
  const f = opts.fetch ?? fetch;
  const m: any = opts.signedMandate.mandate;
  const spender: string = m.spender ?? m.owner;
  const check: SelfCheck = await selfCheck(f, spender, opts.key.publicKey, m.origin_assets[0]);
  if (!check.ok) return { ok: false as const, check };

  const guard = createGuard({ url: opts.readbackUrl, agent: m.agent, signedMandate: opts.signedMandate, askHuman: opts.askHuman, fetch: opts.readbackFetch ?? f });

  /** The tool the agent's model calls. `amount` is in the mandate's asset, for example "2.5" USDC. */
  async function pay(to: string, amount: string): Promise<PayResult> {
    const units = toUnits(amount, m.cap_decimals);
    if (!units) return { outcome: 'refused', reason: 'bad_amount', note: `Not sent: "${amount}" is not an amount.` };
    let quote: any, intent: any;
    try {
      quote = await getQuote(f, { originAsset: m.origin_assets[0], destinationAsset: m.destination_assets[0], amount: units, recipient: to, refundTo: m.refund_to[0], slippageBps: m.max_slippage_bps });
      intent = await generateIntent(f, quote.quote.depositAddress, spender);
    } catch (e) {
      return { outcome: 'refused', reason: 'quote_failed', note: `Not sent: 1Click would not quote this payment (${(e as Error).message.slice(0, 120)}).` };
    }
    return guard.pay({ kind: 'intent', quote, intent }, async (checked: any) => {
      const signed = signIntent(checked.intent.intent.payload, opts.key);
      return opts.live ? { intentHash: await submitIntent(f, signed) } : { dry_run: true as const, signed };
    });
  }

  return { ok: true as const, check, spender, pay };
}
