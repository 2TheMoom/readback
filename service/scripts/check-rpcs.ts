// Checks every configured RPC answers, and for the right chain. Public RPCs get discontinued without
// notice (near.lava.build and polygon-rpc.com were dead by 1 Nov 2026), and a dead one turns every
// payment on that chain into HOLD or REFUSED. Run: npm run check-rpcs. Exits 1 if any RPC fails.

import { EVM_CHAINS, EVM_RPCS, SOL_RPCS, NEAR_RPCS } from '../src/rpc.ts';

async function call(url: string, method: string, params: unknown[] = []): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const j: any = await r.json();
  if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message);
  return j.result;
}

const rows: Array<Promise<[string, string, string]>> = [];
for (const [chain, urls] of Object.entries(EVM_RPCS)) for (const url of urls) rows.push((async () => {
  try {
    const id = parseInt(await call(url, 'eth_chainId'), 16);
    if (id !== EVM_CHAINS[chain].id) return [chain, url, `WRONG CHAIN ${id}, expected ${EVM_CHAINS[chain].id}`];
    await call(url, 'eth_getCode', ['0x0000000000000000000000000000000000000000', 'latest']);
    return [chain, url, 'ok'];
  } catch (e) { return [chain, url, `FAIL ${(e as Error).message}`]; }
})());
for (const url of SOL_RPCS) rows.push(call(url, 'getGenesisHash').then((h) => ['sol', url, h === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' ? 'ok' : `WRONG CHAIN ${h}`] as [string, string, string], (e) => ['sol', url, `FAIL ${e.message}`]));
for (const url of NEAR_RPCS) rows.push(call(url, 'status').then((s) => ['near', url, s?.chain_id === 'mainnet' ? 'ok' : `WRONG CHAIN ${s?.chain_id}`] as [string, string, string], (e) => ['near', url, `FAIL ${e.message}`]));

const done = await Promise.all(rows);
for (const [c, u, s] of done) console.log(`${c.padEnd(8)} ${u.padEnd(52)} ${s}`);
const bad = done.filter((r) => r[2] !== 'ok');
console.log(`\n${done.length - bad.length} of ${done.length} RPCs ok`);
process.exit(bad.length ? 1 : 0);
