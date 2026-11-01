// The demo agent's key: one ed25519 key pair in near-cli's file format, kept outside the repository.
// On NEAR it is a function-call key scoped to intents.near (checked on every start, see near.ts); in
// intents.near it is registered for the agent's own account, which is what lets it sign intents.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';

export const KEY_FILE = process.env.READBACK_AGENT_KEY_FILE ?? join(homedir(), '.readback', 'agent-key.json');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AgentKey { publicKey: string; secret: Uint8Array }

function insideRepo(path: string): boolean {
  const rel = relative(REPO, resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Load the key, or create one if the file does not exist. Refuses a key file inside the repository. */
export function loadOrCreateKey(path = KEY_FILE): AgentKey & { created: boolean } {
  if (insideRepo(path)) throw new Error(`refusing a key file inside the repository: ${path}`);
  if (!existsSync(path)) {
    const secret = ed25519.utils.randomPrivateKey();
    const pk = ed25519.getPublicKey(secret);
    const full = new Uint8Array(64); full.set(secret); full.set(pk, 32);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ public_key: 'ed25519:' + base58.encode(pk), private_key: 'ed25519:' + base58.encode(full) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { publicKey: 'ed25519:' + base58.encode(pk), secret, created: true };
  }
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const full = base58.decode(String(j.private_key).replace(/^ed25519:/, ''));
  const secret = full.slice(0, 32);
  const publicKey = 'ed25519:' + base58.encode(ed25519.getPublicKey(secret));
  if (j.public_key && j.public_key !== publicKey) throw new Error('key file public_key does not match its private_key');
  return { publicKey, secret, created: false };
}
