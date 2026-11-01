import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spenderOf, checksumAddress, fundSetupTx, implicitAccount, agentKeyActions, buildMandate, fundingQuote, AGENT_ALLOWANCE_YOCTO } from '../src/plan.ts';
import { mandateMessage, verifyMandate } from '../../service/src/mandate.ts';
import { signMandate, fakeFetch } from '../../service/test/helpers.ts';

const OWNER_PK = 'ed25519:2FyNFybi7ET9GNTjHEC3Q7VG2igPz93kiDvkp6mXNYCt';
const AGENT_PK = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const ADDR = '0xF4129032DA0F457Fba9abF216220835bed856128';
const input = { owner: 'olumi15.near', payeeLabel: 'Abu on Base', payeeAddress: ADDR, capUsdc: '2', validUntil: '2026-11-30T23:59:59Z' };

test('the agent account is a top-level name derived from a named owner', () => {
  assert.equal(spenderOf('olumi15.near'), 'invoice-bot-olumi15.near');
  assert.equal(spenderOf('abu.tg'), 'invoice-bot-abu-tg.near');
  for (const bad of ['near', 'a'.repeat(64), 'Olumi.near', 'x..near', 'a'.repeat(50) + '.near']) assert.throws(() => spenderOf(bad), undefined, bad);
});

test('EIP-55: known vector, lowercase is checksummed, a broken mixed-case checksum is refused', () => {
  assert.equal(checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.equal(checksumAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.equal(checksumAddress('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), null);
  assert.equal(checksumAddress('6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkhCDVZ'), null);
});

test('the only wallet transaction is a plain 0.12 NEAR transfer to the setup key\'s implicit account', () => {
  const tx = fundSetupTx('olumi15.near', OWNER_PK);
  assert.deepEqual(fundSetupTx('olumi15.near', OWNER_PK, 70000000000000000000000n).actions, [{ type: 'Transfer', params: { deposit: '50000000000000000000000' } }], 'a top-up sends only what is missing');
  assert.throws(() => fundSetupTx('olumi15.near', OWNER_PK, 120000000000000000000000n), /already has enough/);
  assert.equal(tx.receiverId, implicitAccount(OWNER_PK));
  assert.match(tx.receiverId, /^[0-9a-f]{64}$/);
  assert.deepEqual(tx.actions, [{ type: 'Transfer', params: { deposit: '120000000000000000000000' } }]);
  assert.equal(implicitAccount('ed25519:11111111111111111111111111111111'), '0'.repeat(64));
});

test('the keys the server adds: the owner with full access, the agent for intents.near only', () => {
  const k = agentKeyActions(OWNER_PK, AGENT_PK);
  assert.deepEqual(k.owner, { publicKey: OWNER_PK, permission: 'FullAccess' });
  assert.deepEqual(k.agent, { publicKey: AGENT_PK, permission: { receiverId: 'intents.near', methodNames: ['execute_intents'], allowance: AGENT_ALLOWANCE_YOCTO } });
  assert.throws(() => agentKeyActions(OWNER_PK, OWNER_PK), /must differ/);
  assert.throws(() => agentKeyActions(OWNER_PK, 'ed25519:nope'), /not an ed25519/);
});

test('the demo mandate: Base, one payee in full, a cap, and payments only from the agent account', () => {
  const m = buildMandate(input);
  assert.deepEqual([m.spender, m.dest_chain, m.cap, m.refund_to], ['invoice-bot-olumi15.near', 'base', '2000000', ['invoice-bot-olumi15.near']]);
  const text = mandateMessage(m as any);
  assert.ok(text.includes(`Abu on Base (base ${ADDR})`), text);
  assert.ok(text.includes('up to 2 USDC per payment'));
  assert.ok(text.includes('Payments come only from invoice-bot-olumi15.near.'));
  assert.equal(buildMandate({ ...input, payeeAddress: ADDR.toLowerCase() }).payees[0].address, ADDR, 'lowercase input is stored checksummed');
});

test('mandate inputs that could mislead the signer are refused', () => {
  for (const [field, value] of [
    ['payeeLabel', 'Acme (base 0xabc), Evil'], ['payeeLabel', 'two\nlines'], ['payeeLabel', ''],
    ['payeeAddress', '0xF4129032DA0F457Fba9abF216220835bed856129'.replace('F4', 'f4')], ['payeeAddress', 'olumi.eth'],
    ['capUsdc', '0'], ['capUsdc', '1000'], ['capUsdc', '1.1234567'], ['validUntil', '2020-01-01T00:00:00Z'], ['validUntil', 'next week'],
  ]) assert.throws(() => buildMandate({ ...input, [field]: value }), undefined, `${field}=${value}`);
});

test('a signed demo mandate is accepted only once the owner key controls the agent account', async () => {
  const m = buildMandate(input) as any;
  const { signed, key } = signMandate(m);
  const own = `olumi15.near:${key.publicKey}`, sp = `invoice-bot-olumi15.near:${key.publicKey}`;
  assert.equal((await verifyMandate(fakeFetch({ nearKeys: { [own]: 'FullAccess' } }), signed)).reason, 'owner_does_not_control_spender');
  assert.equal((await verifyMandate(fakeFetch({ nearKeys: { [own]: 'FullAccess', [sp]: 'FullAccess' } }), signed)).reason, 'ok');
});

test('funding comes from Base into the agent account inside intents.near, refunds to the owner on Base', () => {
  const q = fundingQuote('olumi15.near', '3000000', ADDR.toLowerCase());
  assert.deepEqual([q.depositType, q.recipientType, q.recipient, q.refundType, q.refundTo, q.dry], ['ORIGIN_CHAIN', 'INTENTS', 'invoice-bot-olumi15.near', 'ORIGIN_CHAIN', ADDR, false]);
  assert.throws(() => fundingQuote('olumi15.near', '0', ADDR));
});
