# Research

Experiments run between 23 and 25 October 2026, inside the NEAR HACKATHON window (the rules' Q-001: work from the 19 October announcement counts). Each script answers one question; the findings feed `../docs/SPEC.md` and the test vectors in `../docs/test-vectors/`.

These are experiments, not the product. They talk to public APIs (1Click quotes are dry runs with no funds; RPC calls are reads), and none of them sign a transaction.

| Script | Question | Finding |
|---|---|---|
| `s1-intent-schema.js` | What can an intent batch contain? | 13 intent types, including `add_public_key` and `auth_call` |
| `s2-live-quote.js` | What does a real 1Click quote look like? | Signed response, 37 chains, withdraw fee about 0.27 USDC |
| `s3-quote-signature.js` | Can we verify quotes without the SDK? | Yes; matches the SDK on 10/10 tamper cases. `appFees` and dry-quote fees are not signed |
| `s4-ed25519-curve.js` | Can we tell if a Solana address has a private key? | Yes; agrees with @noble/curves on 22,500 keys |
| `s5-address-classify.js` | Which chains could an address belong to? | One EVM address is valid on 17+ chains |
| `s6-fixtures.js` | Does 1Click refuse keyless Solana recipients? | No: it quotes them (HTTP 201) |
| `s7-*`, `s7-rust-wasi/` | Can the checks run as an OutLayer WASI module? | Yes: 132 KB, about 3.5M fuel, 10/10 vectors, 2,000/2,000 hash fuzz |
| `s8-wallet/` | Can we verify NEP-413 sign-in ourselves? | Yes; reproduces near-api-js reference signatures, verified with a real Meteor wallet |
| `s9-*` | Are the test vectors right? | An independent evaluator agrees with all 51 |
| `s10-evm-quotes.js` | How does 1Click treat EVM recipients? | Rejects bad checksums and token contracts; accepts contracts and lowercase |

## Run

```
cd research
npm install
node s3-quote-signature.js      # verify real quotes, offline
node s9-validate.js             # check every test vector, offline
```

Scripts that call 1Click or an RPC need network access. `s7-rust-wasi` needs Rust with the `wasm32-wasip1` target.
