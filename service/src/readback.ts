// One Readback request: verify the owner's mandate, gather live chain facts for the recipient, run the
// engine, and read the request back as a sentence.

import { createHash } from 'node:crypto';
import { runEngine, engineSha256, type EngineOutput } from './engine.ts';
import { verifyMandate, fingerprint, canonical, type SignedMandate } from './mandate.ts';
import { evmCode, solAccount, EVM_RPCS, type Fetch } from './rpc.ts';
import { tokenList, type TokenMap } from './tokens.ts';
import { buildSentence, type Sentence } from './sentence.ts';

export interface ReadbackRequest { kind: 'quote' | 'intent'; agent?: string; quote: any; intent?: any; signed_mandate: SignedMandate }
export interface ReadbackResponse extends Partial<EngineOutput> {
  verdict: EngineOutput['v'] | 'REFUSED'; checks: EngineOutput['c']; sentence?: Sentence;
  evaluated_at: string; engine_sha256: string; request_hash?: string; mandate_fingerprint?: string; quote_hash?: string; facts?: unknown; reason?: string;
}

export interface Deps { fetch: Fetch; now?: () => Date }

/** Binds a verdict to the exact request. The agent-side guard recomputes it and refuses any answer that differs. */
export function requestHash(req: ReadbackRequest): string {
  const body = { kind: req.kind, agent: req.agent ?? null, quote: req.quote, intent: req.intent ?? null, mandate: req.signed_mandate?.mandate ?? null };
  return createHash('sha256').update(canonical(body)).digest('hex');
}

export async function readback(req: ReadbackRequest, deps: Deps): Promise<ReadbackResponse> {
  const now = (deps.now ?? (() => new Date()))();
  let base: { evaluated_at: string; engine_sha256: string; request_hash?: string } = { evaluated_at: now.toISOString(), engine_sha256: engineSha256() };
  if (!req || (req.kind !== 'quote' && req.kind !== 'intent') || !req.quote) return { ...base, verdict: 'REFUSED', checks: {}, reason: 'bad_request' };
  base = { ...base, request_hash: requestHash(req) };
  if (req.kind === 'intent' && !req.intent) return { ...base, verdict: 'REFUSED', checks: {}, reason: 'intent_missing' };

  const signed = await verifyMandate(deps.fetch, req.signed_mandate);
  if (!signed.ok) return { ...base, verdict: 'REFUSED', checks: {}, reason: `mandate_${signed.reason}` };
  const mandate = req.signed_mandate.mandate;

  let tokens: TokenMap = {};
  try { tokens = await tokenList(deps.fetch); } catch { /* sentence falls back to raw ids; no check depends on it except the EVM token-contract test */ }
  const destAsset = String(req.quote?.quoteRequest?.destinationAsset ?? '');
  const recipient = String(req.quote?.quoteRequest?.recipient ?? '');

  const rpc: Record<string, unknown> = {};
  if (mandate.dest_chain === 'sol') rpc.sol_account = await solAccount(deps.fetch, recipient);
  if (EVM_RPCS[mandate.dest_chain]) rpc.evm_code = await evmCode(deps.fetch, mandate.dest_chain, recipient);

  const out = runEngine({
    kind: req.kind, now: now.toISOString(), mandate, quote: req.quote, intent: req.intent ?? null,
    tokens: tokens[destAsset] ? { [destAsset]: { contractAddress: tokens[destAsset].contractAddress ?? null } } : {},
    rpc,
  });
  return {
    ...base, verdict: out.v, checks: out.c, why: out.why, err: out.err, quote_hash: out.qh,
    mandate_fingerprint: fingerprint(mandate), facts: rpc,
    sentence: buildSentence(req.agent ?? mandate.agent, req.quote, req.intent, out, tokens),
  };
}
