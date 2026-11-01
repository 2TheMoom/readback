// Local setup server for the demo agent (127.0.0.1 only). The owner's wallet signs the mandate and the one
// account-creation transaction in the browser. This server holds only the agent key file (shared with the
// agent) and a temporary key that registers the agent key in intents.near and is then deleted on chain.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { Account, KeyPair, PublicKey, actions } from 'near-api-js';
import { createAgentAccountTx, buildMandate, fundingQuote, spenderOf, OWNER_NEEDS_YOCTO, USDC_NEAR } from './plan.ts';
import { loadOrCreateKey } from '../../agent/demo/key.ts';
import { selfCheck } from '../../agent/demo/near.ts';
import { mandateMessage, MANDATE_RECIPIENT, verifyMandate } from '../../service/src/mandate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(homedir(), '.readback');
const TEMP_KEY = join(DIR, 'setup-temp-key.json');
const MANDATE = process.env.READBACK_MANDATE_FILE ?? join(DIR, 'mandate.json');
const RPC = 'https://free.rpc.fastnear.com';
const PORT = Number(process.env.PORT ?? 5320);
const manifest = JSON.parse(readFileSync(join(HERE, '..', 'manifest.json'), 'utf8'));
const pending = new Map<string, { mandate: any; expires: number }>();

async function view(params: Record<string, unknown>): Promise<any> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }), signal: AbortSignal.timeout(10_000) });
  return (await r.json()).result;
}
const accountOf = async (id: string) => { const r = await view({ request_type: 'view_account', account_id: id }); return r && !r.error && r.amount !== undefined ? r : null; };
const keysOf = async (id: string) => (await view({ request_type: 'view_access_key_list', account_id: id }))?.keys ?? [];

function tempKey(): KeyPair {
  if (existsSync(TEMP_KEY)) return KeyPair.fromString(JSON.parse(readFileSync(TEMP_KEY, 'utf8')).private_key);
  const kp = KeyPair.fromRandom('ed25519');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(TEMP_KEY, JSON.stringify({ purpose: 'Readback setup: registers the agent key in intents.near, then deleted', public_key: kp.getPublicKey().toString(), private_key: kp.toString() }) + '\n', { mode: 0o600, flag: 'wx' });
  return kp;
}

/** Everything the page shows, read live from chain. */
async function state(owner: string) {
  const spender = spenderOf(owner);
  const agent = loadOrCreateKey();
  const [ownerAcc, spenderAcc] = await Promise.all([accountOf(owner), accountOf(spender)]);
  const keys = spenderAcc ? await keysOf(spender) : [];
  const check = spenderAcc ? await selfCheck(fetch, spender, agent.publicKey, USDC_NEAR) : null;
  const temp = existsSync(TEMP_KEY) ? JSON.parse(readFileSync(TEMP_KEY, 'utf8')).public_key : null;
  return {
    owner, spender, agent_public_key: agent.publicKey,
    owner_near: ownerAcc ? ownerAcc.amount : null, owner_needs: OWNER_NEEDS_YOCTO.toString(),
    spender_exists: !!spenderAcc, spender_near: spenderAcc?.amount ?? null,
    spender_keys: keys.map((k: any) => ({ public_key: k.public_key, permission: typeof k.access_key.permission === 'string' ? k.access_key.permission : { receiver_id: k.access_key.permission.FunctionCall.receiver_id, method_names: k.access_key.permission.FunctionCall.method_names } })),
    temp_key_on_chain: !!temp && keys.some((k: any) => k.public_key === temp),
    agent_check: check,
    mandate_saved: existsSync(MANDATE),
  };
}

/** Register the agent key in intents.near with the temporary key, then delete the temporary key. */
async function register(owner: string) {
  const spender = spenderOf(owner);
  const agent = loadOrCreateKey();
  const kp = tempKey();
  const keys = await keysOf(spender);
  const temp = keys.find((k: any) => k.public_key === kp.getPublicKey().toString());
  if (!temp || temp.access_key.permission !== 'FullAccess') throw new Error('the temporary key is not on the agent account yet: create the account first');
  const acct = new Account(spender, RPC, kp.toString() as any);
  const steps: string[] = [];
  const already = (await selfCheck(fetch, spender, agent.publicKey, USDC_NEAR)).registered === true;
  if (!already) {
    const r: any = await acct.signAndSendTransaction({ receiverId: 'intents.near', actions: [actions.functionCall('add_public_key', { public_key: agent.publicKey }, 30_000_000_000_000n, 1n)] });
    steps.push(`registered the agent key in intents.near (tx ${r.transaction?.hash ?? r.transaction_outcome?.id})`);
  } else steps.push('agent key was already registered in intents.near');
  const d: any = await acct.signAndSendTransaction({ receiverId: spender, actions: [actions.deleteKey(PublicKey.from(kp.getPublicKey().toString()))] });
  steps.push(`deleted the temporary key from ${spender} (tx ${d.transaction?.hash ?? d.transaction_outcome?.id})`);
  if ((await keysOf(spender)).some((k: any) => k.public_key === kp.getPublicKey().toString())) throw new Error('temporary key still on chain after delete');
  rmSync(TEMP_KEY);
  return steps;
}

const send = (res: any, code: number, body: unknown, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    // A page from another origin must not drive this server: browsers send Origin on cross-site POSTs.
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://127.0.0.1:${PORT}`) return send(res, 403, { error: 'origin' });
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, readFileSync(join(HERE, '..', 'public', 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/near-connect.bundle.js') return send(res, 200, readFileSync(join(HERE, '..', 'public', 'near-connect.bundle.js')), 'text/javascript');
    if (req.method === 'GET' && url.pathname === '/manifest.json') return send(res, 200, { version: manifest.version, wallets: manifest.wallets });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await state(String(url.searchParams.get('owner'))));
    if (req.method !== 'POST') return send(res, 404, { error: 'not_found' });
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 20_000) return send(res, 413, { error: 'too_large' }); }
    const b = JSON.parse(raw || '{}');
    if (url.pathname === '/api/mandate/message') {
      const mandate = buildMandate(b);
      const nonce = randomBytes(32).toString('base64');
      pending.set(nonce, { mandate, expires: Date.now() + 10 * 60_000 });
      return send(res, 200, { mandate, message: mandateMessage(mandate as any), recipient: MANDATE_RECIPIENT, nonce });
    }
    if (url.pathname === '/api/mandate') {
      const p = pending.get(b.nonce);
      if (!p || Date.now() > p.expires) return send(res, 400, { error: 'unknown or expired nonce: start the mandate step again' });
      pending.delete(b.nonce);
      const signed = { mandate: p.mandate, signature: { accountId: b.accountId, publicKey: b.publicKey, signature: b.signature, nonce: b.nonce } };
      const v = await verifyMandate(fetch, signed as any);
      // Before the agent account exists the owner cannot control it yet; every other failure is final.
      if (!v.ok && v.reason !== 'owner_does_not_control_spender') return send(res, 400, { error: `mandate not accepted: ${v.reason}` });
      mkdirSync(DIR, { recursive: true });
      writeFileSync(MANDATE, JSON.stringify(signed, null, 2) + '\n');
      return send(res, 200, { saved: MANDATE, owner_public_key: b.publicKey, verified: v.reason });
    }
    if (url.pathname === '/api/plan/create') {
      const agent = loadOrCreateKey();
      return send(res, 200, createAgentAccountTx(b.owner, b.ownerPublicKey, agent.publicKey, tempKey().getPublicKey().toString()));
    }
    if (url.pathname === '/api/register') return send(res, 200, { steps: await register(b.owner) });
    if (url.pathname === '/api/funding') {
      const r = await fetch('https://1click.chaindefuser.com/v0/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fundingQuote(b.owner, b.amountUnits, b.refundAddress)) });
      const j: any = await r.json();
      if (!r.ok) return send(res, 400, { error: `1Click: ${j.message ?? r.status}` });
      return send(res, 200, { depositAddress: j.quote.depositAddress, amountIn: j.quote.amountInFormatted, amountOut: j.quote.amountOutFormatted, deadline: j.quote.deadline, recipient: j.quoteRequest.recipient });
    }
    if (url.pathname === '/api/check') {
      const signed = JSON.parse(readFileSync(MANDATE, 'utf8'));
      const spender = signed.mandate.spender;
      const [mandate, agent] = await Promise.all([verifyMandate(fetch, signed), selfCheck(fetch, spender, loadOrCreateKey().publicKey, USDC_NEAR)]);
      return send(res, 200, { mandate: mandate.reason, agent });
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    send(res, 400, { error: String((e as Error).message ?? e).slice(0, 300) });
  }
});

// The wallet's sandboxed script comes from a mutable URL; say so loudly if it changed since review.
async function executorCheck() {
  try {
    const buf = Buffer.from(await (await fetch(manifest.wallets[0].executor)).arrayBuffer());
    const h = createHash('sha256').update(buf).digest('hex');
    return h === manifest.executor_sha256 ? 'Meteor wallet script matches the reviewed version' : `WARNING: Meteor wallet script changed since review (${h.slice(0, 16)}...), read it before signing`;
  } catch { return 'WARNING: could not fetch the Meteor wallet script to compare'; }
}

server.listen(PORT, '127.0.0.1', async () => console.log(`Readback setup on http://127.0.0.1:${PORT}\n${await executorCheck()}`));
