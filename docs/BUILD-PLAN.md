# Readback build plan (NEAR HACKATHON, 1-14 Nov 2026)

Decision locked 2026-10-23: Readback is the entry. Tracks: security, agents.
Deadline: submit by 14 Nov 23:59 UTC. Target: submit on 13 Nov, keep 14 Nov as buffer.

## Before 1 Nov (allowed: research, design, throwaway spikes, setup)

| Owner | Task |
|---|---|
| Abu | Post the eligibility question in NEAR Discord (draft is in chat) |
| Abu | Create the NEAR mainnet account for the prize payout (and for testing) |
| Abu | ~~1Click Partner Dashboard JWT~~ Not needed: quote and generate-intent work without it (verified 2026-10-25). Optional, only for partner fees |
| Claude | Toolchain spike: Rust `wasm32-wasip2` hello-world in OutLayer's shape (throwaway) |
| Claude | Wallet spike: NEAR wallet selector sign-in with NEP-413 message (throwaway) |
| Claude | ~~Machine-readable test vector table~~ Done 2026-10-25: docs/test-vectors/ (45 vectors, validated) |
| Claude | Demo script and X post draft: after the app ships (Abu, 2026-10-25) |

## Key design decision (pre-build)

The checks must run inside OutLayer's enclave to produce attested receipts, and OutLayer runs `wasm32-wasip2` modules built from Rust. So: **check engine in Rust** (one codebase for enclave and tests), **web app in TypeScript** built from the approved mock. If the Rust/WASI toolchain spike shows a blocker, fall back to running the engine as a normal service and drop the attestation claim, stated plainly in the README.

## The 14 days

| Day | Date | Goal | Done when |
|---|---|---|---|
| 1 | Sat 1 Nov | Create repo; day-1 probes | DONE: private repo pushed; generate-intent shape known (25 Oct); OutLayer `op` fields and vote rules read from source; Mode B GO, veto-only (SPEC 13) |
| 2 | Sun 2 Nov | Decoder for all 13 intent types; quote signature check | Vectors V07-V09, V15-V17 pass |
| 3 | Mon 3 Nov | Address checks: format, curve, payee, lookalike | V02-V06, V18, V19, V22, V23 pass |
| 4 | Tue 4 Nov | Amount, slippage, route, refund, timing, fees; verdict rules | V01, V10-V14, V26, V27 pass |
| 5 | Wed 5 Nov | Chain lookups (contract, mint) with two-RPC agreement | V20, V21, V24, V25 pass |
| 6 | Thu 6 Nov | Engine in OutLayer enclave; signed receipts | A receipt verifies with OutLayer's verifier |
| 7 | Fri 7 Nov | Guard API (Mode A) live; Mode B if day 1 said go | One real 1Click quote gets a verdict end to end |
| 8 | Sat 8 Nov | Web app from the mock: real wallet sign-in (near-connect, pinned manifest; verification proven in spike 8), queue, sentence view | Signed-in owner sees a real request read back |
| 9 | Sun 9 Nov | Mandates (NEP-413 signed), approve/refuse/override, log | Owner signs a mandate and an approval on mainnet |
| 10 | Mon 10 Nov | Break it: fund demo agent, public log | Strangers can attempt; every attempt logged with receipt |
| 11 | Tue 11 Nov | Mainnet end to end with real wallets and small funds; threat model pass | Every row of THREAT-MODEL has a test or a stated limit |
| 12 | Wed 12 Nov | README for human and AI judges; demo video | A fresh clone follows "do X, see Y" without help |
| 13 | Thu 13 Nov | Polish, X demo post (Abu posts), submit after Abu confirms payload | 201 from the submission API |
| 14 | Fri 14 Nov | Buffer only | |

## Changes after day 1 (2026-11-01)

- **Rules update:** HACKATHON.md Q-001 says work from the 19 Oct announcement counts, so research and spikes are inside the window and may be reused. Snapshot: `docs/rules/HACKATHON-2026-11-01.md`.
- **The Security track's official example is close to Readback**, so we cover every requirement it lists: an agent-side wrapper that refuses on REFUSED and asks a human on HOLD; a demo agent that signs with a function-call key scoped to one contract, with its limits explained; an attack script where a prompt-injected agent tries to pay a bad address and is stopped, with the log.
- **Stretch signals from that example:** receiver account age and activity, contract code changed recently, prior interactions between agent and receiver, a shared blocklist with evidence.

## Rules we keep during the build

- Every commit in the repo is from 1-14 Nov. History is never rewritten.
- Research code (now in `research/`) may be reused; anything reused is noted in the commit.
- No mainnet transaction, deploy, push, post or submission without Abu's explicit yes.
- Secrets in environment variables only.

## Biggest risks

1. Mode B (verifier as required approver) may not be possible. Mitigation: Mode A carries enforcement; Mode B becomes a reading aid.
2. JWT access. Retired 2026-10-25: generate-intent works without a key.
3. Rust on WASI. Retired 2026-10-24: spike 7 built P1 and P2 modules, matched the JS reference on 10/10 vectors and the SDK hash on 2,000 fuzz cases.
4. Scope. If day 10 slips, Break it ships as a smaller public log, not a funded agent.
