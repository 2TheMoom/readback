# Pre-hackathon work log

All entries are research, design or throwaway experiments. No product code. Nothing here goes into the hackathon repo except the docs listed as carry-over in README.md.

## 2026-10-23

- Read NEAR HACKATHON rules (nearhackathon.com, HACKATHON.md, announcement). No written rule on prior work; site says "Build your project during the hackathon". Decision: research, design and throwaway spikes before 1 Nov; product code, repo and deploys from 1 Nov. Organizer clarification requested via Discord (pending).
- Concept work: compared three ideas, picked Readback (clear-signing for agent payments). Clickable design mock published as a private Claude Artifact.
- Spike 1 (`s1-intent-schema.js`): inventoried all 13 intent types and quote fields from the public 1Click OpenAPI spec.
- Spike 2 (`s2-live-quote.js`): one unauthenticated dry quote from the public 1Click API (no funds, no deposit address). Found 37 chains, a signed response, and a withdraw fee of 0.276 USDC on a 10 USDC send.
- Spike 3 (`s3-quote-signature.js`): independent quote-signature verifier; matches the official SDK on 10/10 tamper cases.
- Spike 4 (`s4-ed25519-curve.js`): from-scratch ed25519 on-curve test; agrees with @noble/curves on 20,000 random keys, 2,000 keypairs, 500 Solana PDAs.
- Spike 5 (`s5-address-classify.js`): address-to-candidate-chains classifier with real checksums (EIP-55, base58check, bech32/bech32m, Stellar CRC16, XRP).
- Wrote docs/SPEC.md (v0.1), docs/THREAT-MODEL.md (v0.1), docs/README-OUTLINE.md.
- Spike 6 (`s6-fixtures.js`): built verified fixtures (on-curve Acme address, on-curve one-character lookalike) and two fresh dry quotes. Found that 1Click returns a quote (HTTP 201) for an off-curve Solana recipient.
- Found the design mock's example Solana address was itself off-curve; replaced it in the mock with the verified fixture pair and corrected two lines of copy about off-curve addresses.
- Decision locked: Readback is the entry. Wrote docs/BUILD-PLAN.md (pre-1-Nov tasks, 14-day plan, Rust engine for the OutLayer enclave with a stated fallback).
- Design mock gained a full wallet connect flow (pick, wait, read-before-sign, signed/declined, account menu); 236/236 automated checks.

## 2026-10-24

- Spike 7 (`s7-rust-wasi/`, `s7-make-inputs.js`, `s7-run.js`, `s7-fuzz.js`, `s7-fuzz-shape.js`): Rust check engine for 8 checks, built for `wasm32-wasip1` (132 KB) and `wasm32-wasip2` (152 KB component). Run under Node WASI on 10 vectors built from real signed 1Click dry quotes: 10/10 match an independent JS reference and the spec; output about 190 bytes (limit 900). Hash differential fuzz 2,000/2,000 identical to the SDK. Fuzz found a byte-slicing panic on non-ASCII recipients; fixed (char-based). Shape fuzz 1,508 malformed inputs: no crash, never CLEARED.
- Installed wasmtime 50.0.0 (cargo install). Fuel measurement (`s7-fuel.js`): worst case 3.47M (P1) / 3.50M (P2) fuel, about 0.35% of OutLayer's default 1e9 budget; same verdicts as under Node WASI.

## 2026-10-25

- Spike 8 (`s8-wallet/`): NEP-413 sign-in. Hand-written NEP-413 hash reproduces both near-api-js reference signatures byte for byte and matches near-api-js on 500 random messages; 9 tamper/replay cases rejected; full-access key check verified on mainnet. Local server (127.0.0.1 only, message signing only) with single-use nonces: 10/10 tests incl. opening the live NEAR Connector wallet picker in Chrome. Found and fixed an RPC error-shape misread. Read near-connect source: signMessage return shape, default manifest on a mutable branch, custom manifest supported.
- Real-wallet run of spike 8 by Abu: Meteor Wallet extension, mainnet account `olumi15.near`, message signing only (no transaction). All 7 server checks passed; key confirmed FullAccess by an independent RPC call. Observed that Meteor shows the page origin and message, not the NEP-413 recipient: added T21 and the "everything important goes in the message text" rule.
- Checked 1Click auth: Partner Portal (partners.near-intents.org) signs up by email, Google or GitHub. Tested without a key: non-dry quote and generate-intent both return 201. Captured the real unsigned intent (transfer to the deposit address, recipient intents.near, deadline about 3 days out). Added the intent_binding check and the intent-deadline rule to SPEC.
- Spike 9 (`s9-build-vectors.js`, `s9-validate.js`): machine-readable test vector table at `docs/test-vectors/` (45 vectors: 13 quote, 11 intent, 21 destination; real signed fixtures; recorded RPC answers; fixed `now`). Expectations hand-written from SPEC; an independent evaluator agrees 45/45 after one spec clarification (dependent checks run only after format passes). Mutation test: disabling any of the 16 checks or mandate expiry fails at least one vector. SPEC section 12 records the clarified rules and corrects the intent-deadline note.
- Spike 10 (`s10-evm-quotes.js`): real signed dry quotes NEAR USDC to Base USDC and real `eth_getCode` answers from two public Base RPCs. Learned 1Click rejects broken EIP-55 checksums and token-contract recipients but accepts contract recipients and lowercase addresses. Test vectors extended to 51 (E01-E05, D22, mandate M2); evaluator 51/51 after fixing a fixture-name collision it caught; mutation test still covers every check.
- Design mock v10: audited every factual claim against verified data. Replaced "30 minutes before a deposit address expires" with the verified 3-day intent validity; check catalogue now 16 (added quote signature, fees, intent binding); EVM chain count stated as "at least 15". 237/237 mock checks pass.
