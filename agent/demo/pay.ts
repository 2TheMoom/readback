// node demo/pay.ts <recipient> <amount>        dry run: everything up to the signed intent, nothing submitted
// node demo/pay.ts <recipient> <amount> --live  also submits, if Readback allows it
// node demo/pay.ts --check                      only the start-up self-check (what the agent's key can do)
//
// Environment: READBACK_MANDATE_FILE (the owner-signed mandate JSON), READBACK_URL (default
// http://127.0.0.1:8787), READBACK_AGENT_KEY_FILE (default ~/.readback/agent-key.json).

import { readFileSync } from 'node:fs';
import { loadOrCreateKey, KEY_FILE } from './key.ts';
import { startAgent } from './agent.ts';
import { terminalHuman } from '../src/human.ts';

const args = process.argv.slice(2);
const key = loadOrCreateKey();
if (key.created) console.log(`Created the agent key at ${KEY_FILE}\nPublic key: ${key.publicKey}\nAdd it to the agent account as a function-call key for intents.near, then register it in intents.near (see agent/README.md).`);

const mandateFile = process.env.READBACK_MANDATE_FILE;
if (!mandateFile) { console.error('Set READBACK_MANDATE_FILE to the owner-signed mandate.'); process.exit(2); }
const signedMandate = JSON.parse(readFileSync(mandateFile, 'utf8'));

const agent = await startAgent({ key, signedMandate, readbackUrl: process.env.READBACK_URL ?? 'http://127.0.0.1:8787', askHuman: terminalHuman(), live: args.includes('--live') });
const c = agent.check;
console.log(`Agent key ${key.publicKey}\n  on NEAR: ${typeof c.permission === 'object' ? `function-call key, only ${c.permission.receiver_id}, methods ${c.permission.method_names.join(', ') || '(all)'}, gas allowance ${c.permission.allowance ?? 'unlimited'}` : c.permission}\n  in intents.near: ${c.registered === true ? 'registered' : c.registered}\n  balance: ${c.balance}`);
if (!agent.ok) { console.error(`Refusing to run: ${c.problems.join(', ')}`); process.exit(1); }
if (args.includes('--check')) process.exit(0);

const [to, amount] = args.filter((a) => !a.startsWith('--'));
if (!to || !amount) { console.error('usage: node demo/pay.ts <recipient> <amount> [--live]'); process.exit(2); }
const d = await agent.pay(to, amount);
console.log(`\n${d.outcome.toUpperCase()}: ${d.note}`);
if ('result' in d && d.result) console.log(JSON.stringify(d.result, null, 2));
