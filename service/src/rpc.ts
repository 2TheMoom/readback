// Live chain facts for the engine, each from two independent public RPCs. A failure is reported as
// {error} and passed through: the engine turns missing or disagreeing answers into HOLD, never into ok.

export type Fetch = typeof fetch;

/** READBACK_RPC_<CHAIN>="url1,url2" replaces a default pair (public RPCs get discontinued; keyed ones live in env). */
function pair(chain: string, dflt: [string, string]): [string, string] {
  const urls = (process.env[`READBACK_RPC_${chain.toUpperCase()}`] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return urls.length === 2 ? [urls[0], urls[1]] : dflt;
}

/** Two independent public RPCs per chain. Chains not listed get no answers, so contract/mint checks HOLD. */
export const EVM_RPCS: Record<string, [string, string]> = Object.fromEntries(Object.entries({
  eth: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  arb: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  op: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
  pol: ['https://polygon.drpc.org', 'https://polygon-bor-rpc.publicnode.com'],
  bsc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
  avax: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
  gnosis: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'],
} as Record<string, [string, string]>).map(([c, d]) => [c, pair(c, d)]));
export const SOL_RPCS = pair('sol', ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']);
export const NEAR_RPCS = pair('near', ['https://free.rpc.fastnear.com', 'https://near.drpc.org']);

const TIMEOUT_MS = 6000;

async function jsonRpc(f: Fetch, url: string, method: string, params: unknown): Promise<{ result?: any; error?: string }> {
  try {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return { error: `http_${r.status}` };
    const j: any = await r.json();
    if (j.error) return { error: String(j.error.message ?? 'rpc_error').slice(0, 120) };
    return { result: j.result };
  } catch (e: any) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

/** eth_getCode from both RPCs: hex strings, or {error}. */
export async function evmCode(f: Fetch, chain: string, address: string): Promise<Array<string | { error: string }> | null> {
  const rpcs = EVM_RPCS[chain];
  if (!rpcs) return null;
  return Promise.all(rpcs.map(async (u) => {
    const r = await jsonRpc(f, u, 'eth_getCode', [address, 'latest']);
    return typeof r.result === 'string' ? r.result : { error: r.error ?? 'bad_result' };
  }));
}

/** Solana account owner and data length from both RPCs: null if the account does not exist. */
export async function solAccount(f: Fetch, address: string): Promise<Array<{ owner: string; data_len: number } | null | { error: string }>> {
  return Promise.all(SOL_RPCS.map(async (u) => {
    const r = await jsonRpc(f, u, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
    if (r.error) return { error: r.error };
    const v = r.result?.value;
    if (v === null) return null;
    if (!v || typeof v.owner !== 'string' || !Array.isArray(v.data)) return { error: 'bad_result' };
    return { owner: v.owner, data_len: Buffer.from(String(v.data[0]), 'base64').length };
  }));
}

/**
 * Is `publicKey` a FULL-ACCESS key on `accountId`? Both NEAR RPCs must say so. NEAR RPC reports a missing
 * key inside `result.error`, not as a top-level error (research/s8-wallet): that is "no", not "yes".
 */
export async function isFullAccessKey(f: Fetch, accountId: string, publicKey: string): Promise<{ ok: boolean; reason: string }> {
  const answers = await Promise.all(NEAR_RPCS.map((u) => jsonRpc(f, u, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey })));
  const kinds = answers.map((a) => {
    if (a.error) return 'unavailable';
    if (!a.result || a.result.error) return 'not_found';
    if (a.result.permission === 'FullAccess') return 'full_access';
    if (a.result.permission?.FunctionCall) return 'function_call';
    return 'unexpected';
  });
  if (kinds.every((k) => k === 'full_access')) return { ok: true, reason: 'full_access' };
  if (kinds.includes('unavailable') || kinds[0] !== kinds[1]) return { ok: false, reason: 'rpc_unavailable_or_disagree' };
  return { ok: false, reason: kinds[0] };
}
