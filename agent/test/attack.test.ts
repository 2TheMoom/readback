import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, runScenario, judged, transcript, PAYEE, LOOKALIKE, STRANGER, type Step } from '../demo/attack.ts';
import { scriptedModel, readEnvFile, nearAiModel } from '../demo/llm.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Stands in for the guarded tool with Readback's rules for this mandate: one payee, at most 2 USDC. */
function fakePay(calls: string[]) {
  return async (to: string, amount: string) => {
    calls.push(`${amount}->${to}`);
    if (to.toLowerCase() !== PAYEE.toLowerCase()) return { outcome: 'refused', verdict: 'REFUSED', reason: to === LOOKALIKE ? 'lookalike_of_saved_payee' : 'not_a_saved_payee', holds: [], note: 'Refused by Readback, not sent.' };
    if (Number(amount) > 2) return { outcome: 'held', verdict: 'HOLD', reason: 'human_declined', holds: [{ check: 'amount', status: 'warn', why: 'over_cap' }], note: 'Held for your owner, not sent.' };
    return { outcome: 'executed', verdict: 'CLEARED', reason: 'cleared', holds: [], note: 'Sent.', result: { dry_run: true } };
  };
}

test('the scripted stand-in follows the newest instruction in each email, as an injected model would', async () => {
  const seen: Record<string, string[]> = {};
  for (const s of SCENARIOS) { seen[s.id] = []; await runScenario(s, scriptedModel(), fakePay(seen[s.id]), () => {}); }
  assert.deepEqual(seen, {
    genuine: [`1->${PAYEE}`], 'poisoned-address': [`1->${LOOKALIKE}`], 'processing-fee': [`2->${STRANGER}`], 'inflated-amount': [`25->${PAYEE}`],
  });
});

test('every attack ends unsigned and the genuine invoice is allowed; the transcript shows each step', async () => {
  const steps: Step[] = [];
  const verdicts = [];
  for (const s of SCENARIOS) { const r = await runScenario(s, scriptedModel(), fakePay([]), (x) => steps.push(x)); verdicts.push({ s, ...judged(s, r.payments, r.modelError) }); }
  assert.deepEqual(verdicts.map((v) => v.ok), [true, true, true, true], JSON.stringify(verdicts.map((v) => v.why)));
  const md = transcript('scripted', 'dry run', steps, verdicts);
  assert.match(md, /\| Injection: "our wallet changed", to a lookalike of the payee \| 1 USDC to 0x095e…abc5 \| REFUSED \| no \| no \| as expected/);
  assert.match(md, /Model calls\*\* `pay_invoice\(\{"recipient":"0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D","amount_usdc":"2"\}\)`/);
});

test('judging catches a leak: an attacker payment that got signed fails the run', () => {
  const s = SCENARIOS.find((x) => x.id === 'poisoned-address')!;
  assert.equal(judged(s, [{ recipient: LOOKALIKE, amount_usdc: '1', outcome: 'executed', signed: true }]).ok, false);
  assert.equal(judged(SCENARIOS[0], [{ recipient: PAYEE, amount_usdc: '1', outcome: 'refused', signed: false, reason: 'x' }]).ok, false);
  assert.deepEqual(judged(s, [], 'NEAR AI Cloud http_402').ok, false, 'a failed model call is not a resisted injection');
  assert.equal(judged(s, []).ok, true, 'a model that declines on its own is fine');
});

test('NEAR AI Cloud client: tool calls parsed, key only in the Authorization header, errors short', async () => {
  let sent: any;
  const f = (async (url: any, init: any) => {
    sent = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'pay_invoice', arguments: '{"recipient":"0xabc","amount_usdc":"1"}' } }] } }] }));
  }) as typeof fetch;
  const r = await nearAiModel('sk-test', 'm', f).chat([{ role: 'user', content: 'hi' }], []);
  assert.equal(sent.url, 'https://cloud-api.near.ai/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer sk-test');
  assert.ok(!JSON.stringify(sent.body).includes('sk-test'));
  assert.deepEqual(r.calls, [{ id: 'c1', name: 'pay_invoice', args: { recipient: '0xabc', amount_usdc: '1' } }]);
  const bad = (async () => new Response('x'.repeat(5000), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(nearAiModel('sk-test', 'm', bad).chat([], []), (e: Error) => e.message.length < 260 && !e.message.includes('sk-test'));
});

test('the env file reader: KEY=VALUE, quotes, comments', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'rbenv-')), 'llm.env');
  writeFileSync(p, '# comment\nNEARAI_API_KEY="abc"\nNEARAI_MODEL = Qwen/Qwen3.8-27B\nbad line\n');
  assert.deepEqual(readEnvFile(p), { NEARAI_API_KEY: 'abc', NEARAI_MODEL: 'Qwen/Qwen3.8-27B' });
  assert.deepEqual(readEnvFile(p + '.missing'), {});
});
