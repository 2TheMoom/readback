// SPIKE 8 server test (throwaway). Simulated wallet = near-api-js KeyPairSigner with a throwaway key.
const { spawn } = require('child_process');
const path = require('path');
const { KeyPair, KeyPairSigner } = require('near-api-js');
const { base58 } = require('@scure/base');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:5310';
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', body: JSON.stringify(b) })).json();
let pass = 0, total = 0; const ok = (n, c, d) => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  (' + d + ')' : ''}`); };
const stepOk = (steps, name) => { const s = steps.find(x => x.name.startsWith(name)); return s ? s.ok : undefined; };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.once('data', r));
  try {
    const kp = KeyPair.fromRandom('ed25519'); const signer = new KeyPairSigner(kp);
    const signFor = async n => { const s = await signer.signNep413Message('readback-spike.testnet', { message: n.message, recipient: n.recipient, nonce: new Uint8Array(Buffer.from(n.nonce, 'base64')) }); return { accountId: 'readback-spike.testnet', publicKey: s.publicKey.toString(), signature: Buffer.from(s.signature).toString('base64') }; };

    let n = await post('/nonce', { network: 'testnet' }); let s = await signFor(n);
    let v = (await post('/verify', { ...s, nonce: n.nonce })).steps;
    ok('valid signature passes every crypto step', stepOk(v, 'Signature covers exactly') === true && stepOk(v, 'Nonce was issued') && stepOk(v, 'Nonce not used') && stepOk(v, 'Signature is 64'));
    ok('throwaway key correctly NOT accepted, with the right reason', stepOk(v, 'Key is a full-access') === false && /key not found/.test(v[v.length - 1].detail), v[v.length - 1].detail);
    v = (await post('/verify', { ...s, nonce: n.nonce })).steps;
    ok('replay of the same nonce refused', stepOk(v, 'Nonce not used before') === false);

    n = await post('/nonce', { network: 'testnet' }); s = await signFor({ ...n, message: n.message + ' (changed)' });
    v = (await post('/verify', { ...s, nonce: n.nonce })).steps;
    ok('signature over a different message refused', stepOk(v, 'Signature covers exactly') === false);

    n = await post('/nonce', { network: 'testnet' }); s = await signFor({ ...n, recipient: 'readback.evil' });
    v = (await post('/verify', { ...s, nonce: n.nonce })).steps;
    ok('signature for another site (recipient) refused', stepOk(v, 'Signature covers exactly') === false);

    v = (await post('/verify', { ...s, nonce: Buffer.alloc(32, 7).toString('base64') })).steps;
    ok('nonce the server never issued refused', stepOk(v, 'Nonce was issued') === false);

    n = await post('/nonce', { network: 'testnet' }); s = await signFor(n);
    v = (await post('/verify', { ...s, signature: base58.encode(Buffer.from(s.signature, 'base64')), nonce: n.nonce })).steps;
    ok('base58-encoded signature also understood', stepOk(v, 'Signature covers exactly') === true);

    // Browser: page loads, bundle defines NearConnector, Connect opens the real wallet picker (fetches the live manifest)
    const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
    const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    ok('page loads and NearConnector is defined', await p.evaluate(() => typeof window.NearConnector === 'function'));
    await p.click('#connect'); await new Promise(r => setTimeout(r, 4000));
    const picker = await p.evaluate(() => { const t = document.body.innerText; return ['HOT', 'Meteor', 'MyNearWallet', 'Intear', 'Nightly'].filter(w => t.includes(w)); });
    ok('Connect opens the wallet picker with real wallets', picker.length >= 2, picker.join(', '));
    await p.screenshot({ path: path.join(__dirname, 'picker.png') });
    ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
    await b.close();
  } finally { srv.kill(); }
  console.log(`\n${pass}/${total} passed`);
})().catch(e => { console.error('ERR', e); process.exit(1); });
