// The readback sentence: one plain sentence in the order a person reads a payment (who, how much, where,
// what else), with each word linked to the checks that guard it. Failed checks mark their word.

import type { EngineOutput, CheckStatus } from './engine.ts';
import { chainName, formatUnits, type TokenMap } from './tokens.ts';

export interface Part { text: string; checks?: string[]; status?: CheckStatus }
export interface Sentence { text: string; parts: Part[] }

const RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, error: 2, bad: 3 };
const short = (a: string) => (a.length > 16 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

export function buildSentence(agent: string, quote: any, intent: any, out: EngineOutput, tokens: TokenMap): Sentence {
  const req = quote?.quoteRequest ?? {}, q = quote?.quote ?? {};
  const word = (text: string, checks: string[]): Part => {
    const worst = checks.map((c) => out.c?.[c]).filter((s): s is CheckStatus => !!s).sort((a, b) => RANK[b] - RANK[a])[0];
    return { text, checks, status: worst ?? 'ok' };
  };
  const from = tokens[req.originAsset], to = tokens[req.destinationAsset];
  const amount = from ? `${formatUnits(String(q.amountIn ?? req.amount ?? ''), from.decimals)} ${from.symbol}` : `${req.amount} of ${req.originAsset}`;
  const sameAsset = from && to && from.symbol === to.symbol;
  const parts: Part[] = [
    { text: `${agent} asks to ${sameAsset ? 'send' : 'swap'} ` },
    word(amount, ['amount', 'quote_sig']),
    { text: from ? ` from ${chainName(from.blockchain)}` : '' },
    ...(sameAsset || !to ? [] : [{ text: ' into ' }, word(to.symbol, ['route'])]),
    { text: ' to ' },
    word(short(String(req.recipient ?? '')), ['payee', 'lookalike', 'format', 'curve', 'contract', 'mint', 'tag']),
    { text: ' on ' },
    word(to ? chainName(to.blockchain) : String(req.destinationAsset ?? ''), ['route']),
    { text: ', with any refund going to ' },
    word(short(String(req.refundTo ?? '')), ['refund']),
  ];
  if (out.c?.slippage && out.c.slippage !== 'ok') parts.push({ text: ', accepting ' }, word(`${Number(req.slippageTolerance) / 100}% slippage`, ['slippage']));
  if (out.c?.fees && out.c.fees !== 'ok' && to) parts.push({ text: ', after ' }, word(`${formatUnits(String(q.withdrawFee ?? '0'), to.decimals)} ${to.symbol} in fees`, ['fees']));
  if (out.c?.timing && out.c.timing !== 'ok') parts.push({ text: ', on a quote ' }, word(out.c.timing === 'bad' ? 'that has already expired' : 'that ends too soon to review', ['timing']));
  if (intent) {
    let msg: any = null;
    try { msg = JSON.parse(intent?.intent?.payload?.message ?? 'null'); } catch { /* unreadable */ }
    const extra = (msg?.intents ?? []).slice(1).map((i: any) => i?.intent).filter(Boolean);
    if (out.c?.intents && out.c.intents !== 'ok') parts.push({ text: ', ' }, word(extra.includes('add_public_key') ? 'and to add a new key that can sign for your account' : `and to run ${extra.join(', ') || 'an intent Readback does not recognise'}`, ['intents']));
    if (out.c?.intent_binding && out.c.intent_binding !== 'ok') parts.push({ text: ', ' }, word('with a signature that does not match the quote', ['intent_binding']));
    else if (msg?.deadline) parts.push({ text: `; the signature stays valid until ${String(msg.deadline).slice(0, 16).replace('T', ' ')} UTC` });
  }
  parts.push({ text: '.' });
  return { text: parts.map((p) => p.text).join(''), parts: parts.filter((p) => p.text !== '') };
}
