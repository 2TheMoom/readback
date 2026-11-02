// Creates readback.near, the account that owns the Readback project on OutLayer. The OutLayer CLI signs with
// a full-access private key, and the owner's wallet key must never leave the wallet, so this account gets its
// own key, generated here and kept in ~/.readback. The owner's wallet key is added with full access too, so the
// owner can always recover or close it.
//
// Same path as the agent setup (src/server.ts provision()): the wallet sends one plain transfer to the new key's
// implicit account, which creates the named account through the `near` registrar and is then closed into it.
//
//   node scripts/deployer.ts            show the key's implicit account and what to send there
//   node scripts/deployer.ts create     create readback.near once the transfer has arrived (safe to re-run)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Account, KeyPair, PublicKey, actions } from 'near-api-js';
import { implicitAccount } from '../src/plan.ts';

const ACCOUNT = process.env.READBACK_DEPLOYER ?? 'readback.near';
const DIR = join(homedir(), '.readback');
const KEY_FILE = join(DIR, 'outlayer-deployer-key.json');
const MANDATE = join(DIR, 'mandate.json');
const RPC = 'https://free.rpc.fastnear.com';
/** NEAR the new account starts with; the rest of the transfer follows when the implicit account is closed. */
const START_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
const FUND_YOCTO = 800_000_000_000_000_000_000_000n; // 0.8 NEAR: storage, deploy and key deposits, a $1 top-up, gas

async function view(params: Record<string, unknown>): Promise<any> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }), signal: AbortSignal.timeout(10_000) });
  return (await r.json()).result;
}
const accountOf = async (id: string) => { const r = await view({ request_type: 'view_account', account_id: id }); return r && !r.error && r.amount !== undefined ? r : null; };
const keysOf = async (id: string) => (await view({ request_type: 'view_access_key_list', account_id: id }))?.keys ?? [];
const near = (y: bigint | string) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);
const txId = (r: any) => r?.transaction?.hash ?? r?.transaction_outcome?.id ?? '?';

async function until(check: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1500))) if (await check()) return;
  throw new Error(`${what} did not show up on chain within ${ms / 1000} s`);
}

function deployerKey(): KeyPair {
  if (existsSync(KEY_FILE)) return KeyPair.fromString(JSON.parse(readFileSync(KEY_FILE, 'utf8')).private_key);
  const kp = KeyPair.fromRandom('ed25519');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify({ purpose: `Full-access key of ${ACCOUNT}, the OutLayer project owner`, account_id: ACCOUNT, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }) + '\n', { mode: 0o600, flag: 'wx' });
  return kp;
}

/** The key the owner signed the mandate with: the wallet's own full-access key. */
function ownerKey(): { owner: string; publicKey: string } {
  const s = JSON.parse(readFileSync(MANDATE, 'utf8'));
  return { owner: s.mandate.owner, publicKey: s.signature.publicKey };
}

const kp = deployerKey();
const pk = kp.getPublicKey().toString();
const implicit = implicitAccount(pk);
const { owner, publicKey: ownerPk } = ownerKey();

if (process.argv[2] !== 'create') {
  const [acc, imp] = await Promise.all([accountOf(ACCOUNT), accountOf(implicit)]);
  console.log(`deployer key   ${pk} (${KEY_FILE})`);
  console.log(`${ACCOUNT.padEnd(14)} ${acc ? `exists, ${near(acc.amount)} NEAR` : 'not created yet'}`);
  console.log(`implicit       ${implicit} ${imp ? `holds ${near(imp.amount)} NEAR` : 'empty'}`);
  if (!acc) console.log(`\nSend ${near(FUND_YOCTO)} NEAR from ${owner} to ${implicit}, then run: node scripts/deployer.ts create`);
} else await create();

async function create() {
  if (!(await accountOf(ACCOUNT))) {
    const imp = await accountOf(implicit);
    if (!imp) throw new Error(`${implicit} has no NEAR yet: send the transfer first`);
    const r = await new Account(implicit, RPC, kp.toString() as any).signAndSendTransaction({ receiverId: 'near', actions: [actions.functionCall('create_account', { new_account_id: ACCOUNT, new_public_key: pk }, 30_000_000_000_000n, START_YOCTO)] });
    await until(async () => !!(await accountOf(ACCOUNT)), `${ACCOUNT} (tx ${txId(r)})`);
    console.log(`created ${ACCOUNT} (tx ${txId(r)})`);
  } else console.log(`${ACCOUNT} already exists`);

  let keys = await keysOf(ACCOUNT);
  if (!keys.some((k: any) => k.public_key === pk)) throw new Error(`${ACCOUNT} exists but the deployer key is not on it: not ours`);
  if (!keys.some((k: any) => k.public_key === ownerPk)) {
    const r = await new Account(ACCOUNT, RPC, kp.toString() as any).signAndSendTransaction({ receiverId: ACCOUNT, actions: [actions.addFullAccessKey(PublicKey.from(ownerPk))] });
    await until(async () => { keys = await keysOf(ACCOUNT); return keys.some((k: any) => k.public_key === ownerPk); }, 'the owner key');
    console.log(`added ${owner}'s wallet key with full access (tx ${txId(r)})`);
  }

  if (await accountOf(implicit)) {
    const r = await new Account(implicit, RPC, kp.toString() as any).signAndSendTransaction({ receiverId: implicit, actions: [actions.deleteAccount(ACCOUNT)] });
    await until(async () => !(await accountOf(implicit)), 'the implicit account closing');
    console.log(`closed ${implicit} into ${ACCOUNT} (tx ${txId(r)})`);
  }
  const acc = await accountOf(ACCOUNT);
  console.log(`${ACCOUNT}: ${near(acc.amount)} NEAR, keys ${(await keysOf(ACCOUNT)).map((k: any) => `${k.public_key.slice(0, 16)}… ${typeof k.access_key.permission === 'string' ? k.access_key.permission : 'FunctionCall'}`).join(', ')}`);
}
