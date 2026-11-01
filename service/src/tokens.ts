// 1Click token list (asset id -> chain, symbol, decimals, contract address), cached for ten minutes.

import type { Fetch } from './rpc.ts';

export interface Token { assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress?: string }
export type TokenMap = Record<string, Token>;

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; tokens: TokenMap } | null = null;

export async function tokenList(f: Fetch, now = Date.now()): Promise<TokenMap> {
  if (cache && now - cache.at < TTL_MS) return cache.tokens;
  const r = await f('https://1click.chaindefuser.com/v0/tokens', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`token list http_${r.status}`);
  const list = (await r.json()) as Token[];
  const tokens: TokenMap = {};
  for (const t of list) tokens[t.assetId] = { assetId: t.assetId, blockchain: t.blockchain, symbol: t.symbol, decimals: t.decimals, contractAddress: t.contractAddress };
  cache = { at: now, tokens };
  return tokens;
}

export function resetTokenCache() { cache = null; }

const CHAIN_NAMES: Record<string, string> = {
  near: 'NEAR', sol: 'Solana', eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', op: 'Optimism', pol: 'Polygon', bsc: 'BNB Chain',
  avax: 'Avalanche', gnosis: 'Gnosis', btc: 'Bitcoin', tron: 'Tron', xrp: 'XRP Ledger', ton: 'TON', sui: 'Sui', aptos: 'Aptos',
  stellar: 'Stellar', doge: 'Dogecoin', ltc: 'Litecoin', zec: 'Zcash', bera: 'Berachain', scroll: 'Scroll', monad: 'Monad',
};
export const chainName = (id: string) => CHAIN_NAMES[id] ?? id;

/** Smallest units to a readable amount ("250000000", 6 -> "250"). */
export function formatUnits(amount: string, decimals: number): string {
  if (!/^\d+$/.test(amount ?? '')) return String(amount);
  const s = amount.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
