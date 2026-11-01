// What the setup signs, built as plain data so the tests can check every field.
//
// Wallets refuse to let a dapp add a full-access key (Meteor blocks it: "Full access key request blocked"),
// so the owner's wallet never does. It sends one plain transfer to a temporary setup account whose key this
// computer holds; the setup server then creates the agent account through the `near` registrar and adds the
// keys itself (see server.ts provision()).

import { base58 } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3';

export const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const USDC_BASE_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
export const AGENT_NAME = 'invoice-bot';
/** NEAR the new agent account starts with: storage for the account and its keys, and gas for its setup calls. */
export const SPENDER_START_YOCTO = '50000000000000000000000'; // 0.05 NEAR
/** Gas the agent's function-call key may ever spend; it stops working after that. */
export const AGENT_ALLOWANCE_YOCTO = '250000000000000000000000'; // 0.25 NEAR
/**
 * What the setup account must hold: 0.05 for the agent account plus room for gas. NEAR checks a function call's
 * gas at a worst-case price before refunding most of it, so a 30 Tgas call needs about 0.031 NEAR available
 * (create_account asked for 0.0809 with its 0.05 deposit, observed 2026-11-01). The rest comes back to the owner.
 */
export const SETUP_FUND_YOCTO = '120000000000000000000000'; // 0.12 NEAR
export const OWNER_NEEDS_YOCTO = 125000000000000000000000n; // the transfer plus its own gas

/**
 * The agent's own account: a top-level name derived from the owner ("olumi15.near" -> "invoice-bot-olumi15.near").
 * Not a sub-account: only the owner's wallet could create one, and it would need a full-access key the wallet
 * refuses to add.
 */
export function spenderOf(owner: string): string {
  if (!/^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/.test(owner) || !owner.includes('.') || /^[0-9a-f]{64}$/.test(owner)) throw new Error('owner must be a named NEAR account such as you.near');
  const s = `${AGENT_NAME}-${owner.replace(/\.near$/, '').replace(/\./g, '-')}.near`;
  if (s.length > 64) throw new Error('agent account name would be longer than 64 characters');
  return s;
}

/** The implicit account of an ed25519 key: its 32 bytes in hex. */
export function implicitAccount(publicKey: string): string {
  const b = base58.decode(publicKey.replace(/^ed25519:/, ''));
  if (b.length !== 32) throw new Error('not an ed25519 public key');
  return Buffer.from(b).toString('hex');
}

/** The only transaction the owner's wallet signs: a plain transfer to the temporary setup account. */
export function fundSetupTx(owner: string, tempPublicKey: string, alreadyThere = 0n) {
  spenderOf(owner);
  const missing = BigInt(SETUP_FUND_YOCTO) - alreadyThere;
  if (missing <= 0n) throw new Error('the setup account already has enough NEAR');
  return { signerId: owner, receiverId: implicitAccount(tempPublicKey), actions: [{ type: 'Transfer' as const, params: { deposit: missing.toString() } }] };
}

/** The keys the setup server adds to the agent account: the owner keeps full control, the agent gets one contract. */
export function agentKeyActions(ownerPublicKey: string, agentPublicKey: string) {
  for (const k of [ownerPublicKey, agentPublicKey]) if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(k)) throw new Error(`not an ed25519 public key: ${k}`);
  if (ownerPublicKey === agentPublicKey) throw new Error('the owner and agent keys must differ');
  return {
    owner: { publicKey: ownerPublicKey, permission: 'FullAccess' as const },
    agent: { publicKey: agentPublicKey, permission: { receiverId: 'intents.near', methodNames: ['execute_intents'], allowance: AGENT_ALLOWANCE_YOCTO } },
  };
}

/** EIP-55 checksum form, or null if the input is not an address or has a wrong mixed-case checksum. */
export function checksumAddress(a: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  const hex = a.slice(2).toLowerCase();
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(hex))).toString('hex');
  const out = '0x' + [...hex].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
  const mixed = a.slice(2) !== a.slice(2).toLowerCase() && a.slice(2) !== a.slice(2).toUpperCase();
  return mixed && a !== out ? null : out;
}

export interface MandateInput { owner: string; payeeLabel: string; payeeAddress: string; capUsdc: string; validUntil: string }

/** The demo mandate: the agent may pay one saved payee on Base, in USDC, up to the cap, from its own account. */
export function buildMandate(i: MandateInput) {
  const spender = spenderOf(i.owner);
  const address = checksumAddress(i.payeeAddress.trim());
  if (!address) throw new Error('payee must be a Base (0x) address with a valid checksum');
  const label = i.payeeLabel.trim();
  if (!label || label.length > 40 || /[\n\r(),]/.test(label)) throw new Error('payee name must be 1 to 40 characters, without commas, brackets or line breaks');
  if (!/^\d{1,3}(\.\d{1,6})?$/.test(i.capUsdc) || Number(i.capUsdc) <= 0 || Number(i.capUsdc) > 100) throw new Error('cap must be between 0 and 100 USDC');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(i.validUntil) || Date.parse(i.validUntil) <= Date.now()) throw new Error('valid_until must be a future UTC time like 2026-11-30T23:59:59Z');
  const [w, f = ''] = i.capUsdc.split('.');
  return {
    id: 'R1', owner: i.owner, spender, agent: AGENT_NAME, dest_chain: 'base',
    payees: [{ label, chain: 'base', address }],
    origin_assets: [USDC_NEAR], destination_assets: [USDC_BASE_ASSET],
    cap: (w + f.padEnd(6, '0')).replace(/^0+(?=\d)/, ''), cap_symbol: 'USDC', cap_decimals: 6,
    max_slippage_bps: 50, refund_to: [spender], min_review_seconds: 60, valid_until: i.validUntil,
    fees: { max_pct: 5, same_value_assets: true },
  };
}

/**
 * 1Click quote that funds the agent from Base: the owner sends USDC on Base to the deposit address it returns,
 * and 1Click credits USDC to the agent account inside intents.near. Refunds go back to the owner's Base address.
 */
export function fundingQuote(owner: string, amountUnits: string, refundBaseAddress: string) {
  const refund = checksumAddress(refundBaseAddress.trim());
  if (!refund) throw new Error('refund address must be a Base (0x) address with a valid checksum');
  if (!/^[1-9]\d{0,8}$/.test(amountUnits)) throw new Error('bad amount');
  return {
    dry: false, depositMode: 'SIMPLE', swapType: 'EXACT_INPUT', slippageTolerance: 50,
    originAsset: USDC_BASE_ASSET, depositType: 'ORIGIN_CHAIN', destinationAsset: USDC_NEAR, amount: amountUnits,
    refundTo: refund, refundType: 'ORIGIN_CHAIN', recipient: spenderOf(owner), recipientType: 'INTENTS',
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}
