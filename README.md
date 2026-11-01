# Readback

Readback reads every agent payment back to its owner as one plain sentence, marks anything that does not match what the owner allowed, and returns a verdict: CLEARED, HOLD or REFUSED.

Status: in development for NEAR HACKATHON (1 to 14 November 2026). Tracks: security, agents.

## What exists today

- `docs/SPEC.md`: the 16 checks, the verdict rules and how each input is decoded.
- `docs/test-vectors/`: 51 acceptance tests built on real, signed 1Click quotes and a real generated intent.
- `docs/THREAT-MODEL.md`: what can go wrong with Readback itself, and how it is handled.
- `research/`: the experiments behind the spec, with reproducible scripts.
- `engine/`: the check engine in Rust. All 16 checks; passes all 51 test vectors; never panics on hostile input; builds to a 190 KB WASI module (`readback-check`: JSON request on stdin, compact verdict on stdout) whose output is identical to the native build on every vector, within OutLayer's default fuel budget.
- `service/`: the guard API in Node. Payouts to Solana, Ethereum, Base and Arbitrum. It checks the owner's signed mandate (NEP-413, signed by the owner with a full-access key, confirmed on two NEAR RPCs), fetches live chain facts from two independent RPCs per chain, runs the WASI engine and returns the verdict with the plain sentence. Any RPC that is down or disagrees gives HOLD or REFUSED, never CLEARED.
- `agent/`: the agent-side guard, the only path from an agent to its signer. REFUSED never reaches the signer. HOLD asks a human, who sees the sentence, the full recipient address, the reasons and the request hash; only an explicit yes counts, and Readback looks again before anything is signed. The signer gets a frozen copy of exactly what was checked. An answer that is not about this exact request and mandate (`request_hash`, `mandate_fingerprint`), does not add up, or does not arrive at all counts as REFUSED.

The app is being built in this repository during the hackathon.

## Try the engine

```
cd engine
cargo test                      # see: 51 of 51 vectors pass, plus unit and robustness tests
```

## Try the service

```
cd service
npm install && npm run engine   # the engine module needs Rust with the wasm32-wasip1 target
npm test                        # see: 14 of 14 pass (all 51 vectors through WASI, mandates, end to end)
npm start                       # POST /v1/readback, GET /v1/health on 127.0.0.1:8787
```

## Use the guard in an agent

```ts
import { createGuard } from './agent/src/guard.ts';
import { terminalHuman } from './agent/src/human.ts';

const guard = createGuard({ url: 'http://127.0.0.1:8787', agent: 'invoice-bot', signedMandate, askHuman: terminalHuman() });
const decision = await guard.pay({ kind: 'quote', quote }, (checked) => mySigner(checked));
// decision.outcome: executed | refused | held | failed; decision.note is one plain line for the agent's model
```

`cd agent && npm test` runs it against the real service (17 of 17 pass, on Solana and Base, including a man in the middle who swaps the intent Readback sees).

Service settings come from the environment: `PORT`, `HOST`, `READBACK_ORIGINS` (allowed browser origins, comma separated), `READBACK_RECIPIENT` (the NEP-413 recipient mandates are signed for, default `readback.app`), `READBACK_ENGINE` (path to the engine module) and `READBACK_RPC_<CHAIN>` (two comma-separated URLs replacing a chain's default RPC pair, for example `READBACK_RPC_NEAR`).

## Work before 1 November

Research, the spec, the test vectors, the experiments in `research/` and a clickable design mock were made between 23 and 31 October 2026, which is inside the hackathon window under rule Q-001 (work from the 19 October announcement counts). `docs/WORKLOG.md` lists that work by date. No code from earlier projects is used.

## License

MIT. See `LICENSE`.
