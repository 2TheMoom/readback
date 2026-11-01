// What the setup asks the owner's wallet to sign, built as plain data so the tests can check every field.

import { keccak_256 } from '@noble/hashes/sha3';

export const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const USDC_BASE_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
export const AGENT_NAME = 'invoice-bot';
/** NEAR the new agent account starts with: storage for the account and its keys, and gas for registration. */
export const SPENDER_START_YOCTO = '50000000000000000000000'; // 0.05 NEAR
/** Gas the agent's function-call key may ever spend; it stops working after that. */
export const AGENT_ALLOWANCE_YOCTO = '250000000000000000000000'; // 0.25 NEAR
export const OWNER_NEEDS_YOCTO = 60000000000000000000000n; // 0.05 NEAR to the agent account plus about 0.01 for gas

export function spenderOf(owner: string): string {
  if (!/^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/.test(owner) || !owner.includes('.') || /^[0-9a-f]{64}$/.test(owner)) throw new Error('owner must be a named NEAR account such as you.near');
  const s = `${AGENT_NAME}.${owner}`;
  if (s.length > 64) throw new Error('agent account name would be longer than 64 characters');
  return s;
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

/**
 * One transaction from the owner: create the agent account, give it 0.05 NEAR, and add three keys. The owner's
 * own wallet key gets full access (the owner keeps control; Readback checks this). The agent key is a
 * function-call key for intents.near only. The temporary key exists only to register the agent key in
 * intents.near (that needs a 1 yoctoNEAR deposit, which a function-call key cannot attach) and is deleted
 * right after.
 */
export function createAgentAccountTx(owner: string, ownerPublicKey: string, agentPublicKey: string, tempPublicKey: string) {
  const spender = spenderOf(owner);
  for (const k of [ownerPublicKey, agentPublicKey, tempPublicKey]) if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(k)) throw new Error(`not an ed25519 public key: ${k}`);
  if (new Set([ownerPublicKey, agentPublicKey, tempPublicKey]).size !== 3) throw new Error('the three keys must differ');
  return {
    signerId: owner,
    receiverId: spender,
    actions: [
      { type: 'CreateAccount' as const },
      { type: 'Transfer' as const, params: { deposit: SPENDER_START_YOCTO } },
      { type: 'AddKey' as const, params: { publicKey: ownerPublicKey, accessKey: { permission: 'FullAccess' as const } } },
      { type: 'AddKey' as const, params: { publicKey: agentPublicKey, accessKey: { permission: { receiverId: 'intents.near', methodNames: ['execute_intents'], allowance: AGENT_ALLOWANCE_YOCTO } } } },
      { type: 'AddKey' as const, params: { publicKey: tempPublicKey, accessKey: { permission: 'FullAccess' as const } } },
    ],
  };
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
