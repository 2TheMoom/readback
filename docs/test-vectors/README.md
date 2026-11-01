# Readback test vectors v0.1

The acceptance tests for the Readback check engine. Written before the hackathon (2026-10-25) as design data; the engine built from 1 Nov must pass every vector.

## Files

- `vectors.json`: 65 vectors (13 Solana quote, 5 Base quote, 9 NEAR quote, 14 intent, 24 destination). Each has an `id`, a `kind`, its inputs, and a hand-written `expect`.
- `fixtures/quotes/*.json`: real 1Click quote responses, signed by the 1Click manager key. The signatures stay verifiable forever.
- `fixtures/intents/I_live.json`: a real unsigned intent from `POST /v0/generate-intent`, paired with `Q_live`.
- `fixtures/mandates.json`: `M1` (NEAR USDC to Solana USDC, payee Acme) and `M2` (NEAR USDC to Base USDC, payees Dana and a contract vault).
- `fixtures/tokens.json`: token metadata from the 1Click token list (asset id, chain, decimals, contract address).
- `fixtures/rpc/base-eth_getCode.json`: real `eth_getCode` answers recorded on 2026-10-25 from two independent public Base RPCs.

## Kinds

| kind | Inputs | Checks that apply |
|---|---|---|
| `quote` | a signed quote, a mandate, optional mutations | quote_sig, payee, lookalike, format, then curve (ed25519 chains) or contract (EVM), mint, amount, slippage, fees, route, refund, timing |
| `intent` | `quote` inputs plus a generated intent | everything in `quote`, plus intents and intent_binding |
| `destination` | a chain and an address, recorded RPC responses | format, then (only if format is ok) curve, contract, mint, tag |

## Rules

- **Verdict:** any `bad` gives REFUSED; else any `warn` or `error` gives HOLD; else CLEARED. An `error` can never produce CLEARED.
- **Expect convention:** `expect.bad`, `expect.warn`, `expect.error` list the checks that are not ok. Every other applicable check must be ok. A string `expect.error` (for example `mandate_expired`) means the whole evaluation is refused.
- **Time:** each vector carries its own `now`. Never use the real clock in these tests.
- **Network:** none. Chain lookups come from the vector's `rpc` field: two recorded answers from independent sources. `null` means the account does not exist; `{error}` means that source failed.
- **Mutations:** `set` writes a value at a path, `push` appends to an array. Paths start at the quote response root; `msg.` paths edit the parsed JSON inside the intent's NEP-413 `message`.

## How these were checked

- Expectations were written by hand from `../SPEC.md`, not computed.
- An independent reference evaluator (pre-hackathon spike, not product code) agrees with the original 51. The three spender vectors (I12 to I14, mandate M3) were added on 1 Nov and are checked by the engine and service tests only.
- Mutation test: switching off any one of the 16 checks, or the mandate-expiry rule, makes at least one vector fail.

## Known gaps (to extend during the build)

- Six checks are each covered by a single vector: amount, slippage, route, tag, refund, mandate expiry.
- EVM quotes cover Base only; other EVM chains share the rules but have no signed fixtures.
- Two EVM cases cannot have signed quotes because 1Click refuses them (broken EIP-55 checksum: 400 "recipient is not valid"; the destination token contract: 400 "Internal server error"). They are covered by a post-signing mutation (E05) and a destination vector (D22).
- Fees are only checked for same-value assets (USDC to USDC).
