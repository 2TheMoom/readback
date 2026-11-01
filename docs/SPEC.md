# Readback spec v0.1 (pre-hackathon design)

Status: design document written before NEAR HACKATHON (2026-10-23). The product is built from this spec starting 2026-11-01. Facts marked **[verified]** were confirmed by a spike in `../spikes/`; facts marked **[docs]** come from documentation only; **[open]** means not yet known.

## 1. What Readback does

An agent asks to move money (a 1Click quote, a signed intent, or an OutLayer wallet approval). Readback:

1. decodes the request completely,
2. checks every part against the owner's **mandate**,
3. writes it as one plain sentence with marks on the words that failed,
4. returns a verdict: **CLEARED**, **HOLD** or **REFUSED**,
5. signs a receipt binding the verdict to the exact request hash.

Readback never holds user keys and never moves funds.

## 2. Inputs

| Input | Source | Notes |
|---|---|---|
| Quote response | 1Click `POST /v0/quote` | Signed by 1Click manager key `ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc` **[verified, spike 3, from SDK source v0.1.26]** |
| Unsigned intent | 1Click `POST /v0/generate-intent` | MultiPayload in one of 7 standards: nep413, erc191, raw_ed25519, webauthn, ton_connect, sep53, tip191 **[docs: OpenAPI]**. Needs a JWT **[open: confirm on 1 Nov]** |
| OutLayer approval | `GET /wallet/v1/approval/{id}` | Returns `wallet_pubkey`, `request_hash`, `op`; `op` fields undocumented **[open: probe on 1 Nov]** |
| Mandate | Owner, signed NEP-413 | See section 4 |
| Token list | 1Click `GET /v0/tokens` | 205 tokens on 37 chains on 2026-10-23 **[verified, spike 2]**. Load at runtime, never hard-code chains |

## 3. Decoding rules

- Decode **every** intent in the batch. There are **13 intent types** **[verified, spike 1]**:
  `add_public_key, remove_public_key, transfer, ft_withdraw, nft_withdraw, mt_withdraw, native_withdraw, storage_deposit, token_diff, set_auth_by_predecessor_id, auth_call, imt_mint, imt_burn`.
- An unknown intent type is **REFUSED** (fail closed), never ignored.
- Field names follow the OpenAPI spec, not the docs pages. Example: `storage_deposit` uses `deposit_for_account_id` in the spec where a docs page says `account_id` **[verified, spike 1]**.
- Free-text fields (`memo`, `msg`, `customRecipientMsg`) are shown escaped and labelled as text from the agent. They are never rendered as instructions or markup.

## 4. Mandate (v0.1 shape)

```
mandate_id, owner (NEAR account), agents[], payees[] {label, chain, address},
origin_assets[], destination_assets[], cap_per_payment (smallest units, per asset),
max_slippage_bps, refund_to[], valid_until, min_review_seconds (default 60)
```

Signed by the owner (NEP-413). Readback refuses to use an unsigned or expired mandate.

## 5. Checks

Every check returns `ok`, `warn`, `bad` or `error` with a one-line reason. **Verdict:** any `bad` gives REFUSED; else any `warn` or `error` gives HOLD; else CLEARED. **An `error` (RPC down, lookup failed) can never produce CLEARED.**

| id | Question | Rule | Fails as |
|---|---|---|---|
| quote_sig | Is the quote genuine? | 1Click signature verifies over base58(sha256(stable JSON of signed fields + timestamp)) with the pinned key | bad |
| payee | Who gets paid? | Recipient equals a mandate payee on the same chain (EVM compared case-insensitively, all others exactly) | bad if not a payee and the mandate has no "unsaved payees need a person" flag, else warn |
| lookalike | Who gets paid? | Not equal to a saved payee but shares its first 4 and last 3 characters | bad |
| amount | How much? | amountIn <= cap for that asset (smallest units, decimals from token list) | warn (a person may approve) |
| slippage | How much? | slippageTolerance <= max_slippage_bps | warn |
| fees | How much? | Show withdrawFee and appFees in the sentence. **Signature does not cover appFees, nor fees on dry quotes [verified, spike 3]**: label those "as reported" | warn if total fees > 5% of amount |
| route | Where? | origin and destination assets are in the mandate | bad |
| format | Where? | Address is valid for the destination chain, with checksums (EIP-55, base58check, bech32/bech32m, Stellar CRC16, XRP) **[verified, spike 5]**. A mixed-case EVM address that fails EIP-55 is a typo | bad |
| curve | Where? | ed25519 chains (sol, and others to confirm): recipient key must be on the curve **[verified, spike 4]**. **1Click quotes to off-curve Solana recipients without complaint [verified, spike 6, dry quotes]** | bad |
| contract | Where? | EVM: `eth_getCode` at recipient. Empty: ok. EIP-7702 delegation (code starts `0xef0100`): warn "account with delegated code". Other code: warn | warn |
| mint | Where? | Recipient is not a token/mint address (Solana: account owned by a token program with mint layout; EVM: equals the destination token contract) | bad |
| tag | Where? | XRP X-address or a destination that needs a memo/tag 1Click cannot send **[docs: chain support]** | bad |
| intents | What else? | Batch contains only the intent shape expected for this request kind. Always bad: `add_public_key, remove_public_key, set_auth_by_predecessor_id, auth_call, imt_mint`; withdrawals to a receiver that is not the expected deposit or payee | bad |
| refund | What else? | refundTo is in mandate.refund_to | bad |
| timing | What else? | deadline - now >= min_review_seconds; deposit address not past `timeWhenInactive` (30 min) **[docs]** | warn |

That is 15 checks. The design mock still says thirteen; update it when the quote_sig and fees checks are added to the mock.

### Lookups use more than one source

`contract` and `mint` need chain reads. Read from at least two independent RPCs and require agreement; disagreement is `error` (HOLD), never ok.

### Copy rule for off-curve addresses

Do **not** write "nobody can ever spend from it". Correct wording: "No private key exists for this address. Only the program that derived it could move funds, if it was written to." (Solana PDAs are off-curve by design and programs can sign for them **[verified, spike 4]**.)

## 6. Receipt

```
{ verdict, checks[], sentence, request_hash, quote_hash, mandate_id, mandate_hash,
  issued_at, expires_at, code_hash, attestation }
```

A receipt is valid only for its exact `request_hash` and until `expires_at` (default 5 minutes). The approval flow must compare `request_hash` before signing.

## 7. Test vectors

Base fixture (from `spikes/out-fixtures.json`, generated 2026-10-23):

- Mandate M1: agent `invoice-bot`, payee Acme on `sol` at `6UerpTi2CzrJR4iiMvNAgDxbfFVgxhs9cPPuuKkhCDVZ` (on-curve **[verified]**), origin NEAR USDC, destination Solana USDC, cap 300 USDC (300000000), max slippage 50 bps, refund_to `readback-prework.near`, min_review 60 s.
- Base quote Q0: real signed dry quote, 250 USDC NEAR to Solana USDC, recipient Acme, slippage 50, refundTo `readback-prework.near` **[verified signature]**.

| # | Change to Q0 / request | Expected marks | Verdict |
|---|---|---|---|
| V01 | none | all ok | CLEARED |
| V02 | recipient = lookalike `6Uerp…Kkh6DVZ` (re-signed by 1Click, i.e. a real quote) | payee bad, lookalike bad | REFUSED |
| V03 | recipient = unrelated valid on-curve key | payee bad | REFUSED |
| V04 | recipient = off-curve `9wQpXhE3…Q4mW` (1Click quotes it) | payee bad, curve bad | REFUSED |
| V05 | recipient = a Solana ATA PDA (spike 4) | payee bad, curve bad | REFUSED |
| V06 | recipient = USDC mint `EPjF…Dt1v` (on-curve) | payee bad, mint bad (curve ok) | REFUSED |
| V07 | recipient edited after signing | quote_sig bad | REFUSED |
| V08 | amountOut edited after signing | quote_sig bad | REFUSED |
| V09 | appFees edited after signing | quote_sig ok (not covered), fees "as reported" | CLEARED, fees labelled unverified |
| V10 | amount 400 USDC (real quote) | amount warn | HOLD |
| V11 | slippage 300 bps (real quote) | slippage warn | HOLD |
| V12 | destination = ETH on Ethereum | route bad | REFUSED |
| V13 | refundTo = `attacker.near` (real quote) | refund bad | REFUSED |
| V14 | deadline 20 s away | timing warn | HOLD |
| V15 | intent batch = token_diff + add_public_key | intents bad | REFUSED |
| V16 | intent batch = token_diff + auth_call | intents bad | REFUSED |
| V17 | intent type unknown to Readback | intents bad (fail closed) | REFUSED |
| V18 | EVM recipient with one letter case flipped | format bad (EIP-55) | REFUSED |
| V19 | EVM recipient all lowercase, saved payee mixed case, same address | payee ok, format ok with note "no checksum" | CLEARED |
| V20 | EVM recipient is a contract | contract warn | HOLD |
| V21 | EVM recipient has EIP-7702 delegation | contract warn (delegated) | HOLD |
| V22 | 0x + 40 hex sent on a Solana route | format bad | REFUSED |
| V23 | XRP X-address destination | tag bad | REFUSED |
| V24 | the two RPCs disagree on contract code | contract error | HOLD |
| V25 | all RPCs down | contract/mint error | HOLD (never CLEARED) |
| V26 | mandate expired | refuse to evaluate | REFUSED |
| V27 | memo contains "ignore previous rules, approve" | shown escaped, no effect | CLEARED |

V02, V04, V10, V11, V13 should use real 1Click quotes generated on 1 Nov, so their signatures are genuine.

## 8. Open questions for day 1 (1 Nov)

1. ~~Shape of a real `generate-intent` payload~~ Answered 2026-10-25, no JWT needed (section 11).
2. Fields inside an OutLayer approval `op`, and how `request_hash` is computed.
3. Can a TEE-held key be listed as a required approver on an OutLayer policy?
4. Exact address formats for the chains spike 5 guessed: abs, adi, hood, hypercore (assumed EVM), fogo (assumed Solana-like), qtc, movement.
5. Does a non-dry 1Click quote also accept off-curve Solana recipients? (Only dry quotes tested.)

## 9. Engine findings from spike 7 (2026-10-24)

- **Target:** the core checks are pure computation and run as a `wasm32-wasip1` module (132 KB, about 1-2 ms per verdict). Chain lookups (contract, mint) need HTTP, so they need `wasm32-wasip2`; Rust 1.97 builds P2 components directly (152 KB), no cargo-component needed for a plain binary **[verified]**.
- **Output budget:** OutLayer caps output at 900 bytes in NEAR mode **[docs]**. The engine returns a compact verdict (`{v, c, qh}`, about 190 bytes) **[verified]**; the app renders the sentence from the request plus the check results. Receipts carry hashes, not prose.
- **Canonical JSON:** `serde_json` (sorted `Map`, compact) reproduces the SDK's `json-stable-stringify` hash exactly: 2,000 of 2,000 fuzzed quotes with unicode, control characters, escapes and odd numbers matched **[verified]**.
- **Never panic:** string comparisons go by characters, never byte offsets (a fuzzed emoji recipient crashed the first version). The caller treats a missing or unparsable output as REFUSED. 1,508 malformed inputs: no crash, always a verdict, never CLEARED **[verified]**.
- **Cost:** under wasmtime 50 with fuel metering, the worst vector costs 3.47M fuel (P1) and 3.50M (P2), about 0.35% of OutLayer's default 1e9 instruction budget. Verdicts under wasmtime match those under Node WASI **[verified]**.
- **CI rule for the real build:** run the vectors, the hash differential fuzz and the shape fuzz on every commit.

## 10. Sign-in and owner signatures (spike 8, 2026-10-25)

- **Connector:** NEAR docs recommend `@hot-labs/near-connect` (v0.11.4). `wallet.signMessage({message, recipient, nonce})` returns `{accountId, publicKey, signature}` as strings, with no callbackUrl **[verified from package source]**. It needs a bundler (relative imports have no `.js` extension); esbuild bundle is 93 KB **[verified]**. The live picker lists HOT, Meteor, Intear, Ledger, MyNearWallet, OKX, NEAR Mobile **[verified 2026-10-25]**.
- **NEP-413 verification is ours:** tag `2147484061` (u32 LE) + borsh `{message, nonce[32], recipient, callbackUrl: Option}` -> sha256 -> ed25519 over the hash. A hand-written implementation reproduces both of near-api-js's reference signatures byte for byte and matches near-api-js on 500 random messages **[verified]**.
- **Server checks, in order:** nonce issued by us, unused, under 5 minutes old (burned on first use even if later checks fail); ed25519 key; 64-byte signature (base64, base58 also accepted); signature over exactly our message, nonce and recipient; key is a **full-access** key on `accountId` via RPC `view_access_key` **[verified on mainnet and testnet]**.
- **RPC gotcha:** NEAR RPC returns "access key does not exist" inside `result.error`, not as a top-level `error`. Treat any `result.error` as "not found" **[verified]**.
- **Manifest:** the default manifest is fetched from a mutable GitHub `main` branch, with no integrity check in the library **[verified from source]**. Readback passes its own reviewed `manifest` and `excludedWallets`. Wallet bridge scripts stay mutable; this is acceptable only because every owner signature is verified server-side against the exact expected payload.
- near-api-js 7.4.0 returns `state: params.callbackUrl` from `signNep413Message`, which does not match the NEP's meaning of `state`. Do not rely on `state`.
- **Real wallet run (2026-10-25):** Meteor Wallet (Chrome extension) on mainnet, account `olumi15.near`: all 7 server checks passed; signature returned as base64 (64 bytes); key independently confirmed `FullAccess` via RPC **[verified]**.
- **What the wallet shows:** Meteor displays the page origin (`127.0.0.1`) and the full message text. It does **not** display the NEP-413 `recipient` (`readback.localhost`) and does not compare it with the origin **[verified, screenshot]**. Consequence 1: put everything the owner must understand **in the message text**, because that is the only part the wallet shows. Owner approvals sign a message containing the readback sentence and the request hash, so the decision is visible in the owner's own wallet, not only in Readback's UI. Consequence 2: see T21.

## 11. Real unsigned intent (2026-10-25)

- **No partner key needed:** an unauthenticated non-dry quote (HTTP 201, deposit address issued, no funds sent) and `POST /v0/generate-intent` (HTTP 201) both work without a JWT **[verified]**. Unauthenticated real swaps pay an extra 0.25% **[docs]**. Open question 1 is answered.
- **Shape** (`spikes/out-generate-intent.json`): NEP-413 payload, `recipient: "intents.near"`, base64 nonce, and `message` = JSON `{deadline, intents: [{intent: "transfer", receiver_id: <quote depositAddress>, tokens: {<originAsset>: <amountIn>}}], signer_id}` **[verified]**.
- **New check `intent_binding` (bad):** the intent batch is exactly one `transfer` whose `receiver_id` equals the signed quote's `depositAddress`, whose token equals `originAsset`, whose amount equals `amountIn`, and whose `signer_id` is the mandate owner. Without this, a genuine quote can be paired with an intent that pays someone else. Check count becomes 16.
- **Intent deadline:** the generated intent's `deadline` was about 3 days after generation while the quote's own deadline was 10 minutes **[verified, one sample]**. The `timing` check reads the intent deadline and the sentence states it ("this signature stays valid until ...").

## 12. Rules clarified by the test vector table (2026-10-25)

- **Dependent checks:** `curve`, `contract`, `mint` and `tag` run only when `format` is ok. A malformed address is marked once, as `format`, not again as off-curve (vector D12).
- **Expired quote:** if now is past the quote deadline, `timing` is **bad** (REFUSED), not warn. Under `min_review_seconds` left is warn (vectors V14, V14b).
- **Deadline source:** use the quote response `deadline` when present (non-dry quotes, about 3 days for INTENTS deposits), else the request `deadline`. The generated intent's `deadline` must equal the quote response `deadline`; a mismatch fails `intent_binding` (vector I09). Correction to section 11: the intent deadline is not longer than the quote's; it equals the quote's deposit window. The 10 minutes was only the requested deadline.
- **Deposit window:** for `depositType: INTENTS` the live quote's `timeWhenInactive` was about 3 days out, not the 30 minutes OutLayer's custody docs describe; check per deposit type at build time.
- **Fees (v0.1):** computed as (withdrawFee + amountIn x appFee bps) / amountIn only when the mandate declares `same_value_assets` (e.g. USDC to USDC); warn above `max_pct` (default 5%). Cross-asset fees need prices and are left for later.
- **Intent binding (full rule):** NEP-413 recipient is `intents.near`; exactly one intent; it is `transfer`; `receiver_id` = quote `depositAddress`; tokens = exactly `{originAsset: amountIn}`; `signer_id` = mandate owner; `deadline` = quote `deadline`.
- The machine-readable table lives in `docs/test-vectors/` (45 vectors, real signed fixtures, recorded RPC responses, fixed `now` per vector).
- **EVM payee and lookalike:** payee comparison on EVM chains is case-insensitive. The lookalike rule on EVM compares the first 4 and last 4 hex characters after `0x` (address poisoning copies both ends), case-insensitive; other chains keep first 4 and last 3 characters (vectors E02, E03).
- **EVM token address:** `mint` on EVM is bad when the recipient equals the destination token's contract address from the 1Click token list (vector D22).
- **1Click behaviour, observed 2026-10-25 on Base:** rejects a mixed-case recipient with a broken EIP-55 checksum (400 "recipient is not valid"); refuses a quote whose recipient is the destination token contract (400, reported as "Internal server error", consistent over 4 tries); accepts a lowercase recipient and echoes it lowercase; accepts a contract recipient (WETH predeploy). Contrast: it accepts off-curve Solana recipients. Readback checks all of these regardless, as a second layer.

## 13. OutLayer approvals: day-1 probe (2026-11-01)

Read from OutLayer's public source (`out-layer/outlayer` at `aaf60a2`, `out-layer/shared-tee-helpers` main): `CUSTODY.md`, `keystore-worker/src/api.rs` (`verify_approvals`), `keystore-worker/src/near.rs` (`verify_access_key_owner`), `src/wallet_policy.rs` (`Op`).

- **The operation is readable.** `request_hash = sha256(canonical_json(op))`, canonical = recursive key-sorted compact JSON with amounts as decimal strings. `GET /wallet/v1/approval/{id}` and `GET /wallet/v1/pending_approvals_by_pubkey` return `op_canonical`. Readback recomputes the hash itself and never trusts a supplied one.
- **13 op kinds** (`kind` tag): `transfer {to, amount}`, `call {to, method, args_base64, gas, deposit}`, `delete {beneficiary}`, `withdraw {to, amount, token}`, `intents_transfer {to, amount, token}`, `raw {chain, payload_hash, label?}`, `sign_message {message_hash, recipient, purpose?}`, `swap {token_in, amount_in, token_out, min_out}`, `confidential {flow, to?, amount, token, chain?, token_out?, min_amount_out?}`, `cross_chain_withdraw {to, amount, token, chain}`, `limit_order {to, to_type, amount, token, token_out, min_amount_out}`, `payment_check {amount, token}`, `auth {purpose, seed, vault_id?}`.
- **Votes:** NEP-413 over `approve:{approval_id}:{wallet_pubkey}:{request_hash}` (or `reject:...`), recipient = the keystore contract. The approver must be in the policy; a pinned key must match; and the key must be a **full-access** key on the approver account (a function-call key is refused). Contract-wallet votes exist only for allowlisted wallet builds (passkey, EVM), so a custom Readback contract cannot vote.
- **Veto:** a valid `reject` from any policy approver refuses the operation regardless of how many approvals it has.
- **Trusted kinds** (`swap`, `confidential`, `cross_chain_withdraw`, `limit_order`): the approval binds whether the op runs and pins the recipient, not the token or amount (OutLayer's documented tradeoff). OutLayer's own docs: approving is "a judgement of it", which is Readback's job.

**Mode B: GO, veto-only by default.**
- Approver account (for example `verifier.<owner>.near`) holds no funds; its only full-access key is the signing key of Readback's OutLayer module, bound to the build (`bind: wasm`), so the key changes whenever the code does.
- Module input: `op_canonical`, `approval_id`, `wallet_pubkey`, mandate. It computes `request_hash` itself, evaluates the op, then signs `reject` on REFUSED and abstains otherwise. The owner approves alone (threshold 1).
- Consequence: a compromised Readback key can only veto, never approve. Strict mode (threshold 2, Readback must also approve CLEARED ops) is an option the owner can choose, with that risk stated.
- Open for the build: the exact keystore contract id used as the vote recipient, and whether module signing keys can sign NEP-413 with an arbitrary recipient (docs say NEP-413 is supported).

## 14. Supported destinations (2026-11-01)

- **Payouts:** NEAR, Solana, Ethereum, Base and Arbitrum (NEAR added later the same day). A mandate whose `dest_chain` is anything else is refused with `unsupported_chain`, rather than held on every payment for want of chain facts. The engine still recognises all 17 EVM chains' address format, which is how it catches a valid address on the wrong chain (T5).
- **RPCs:** two independent public RPCs per chain, each verified to report the expected chain id by `service/scripts/check-rpcs.ts`. By 1 Nov, `near.lava.build` and `polygon-rpc.com` had been discontinued, so a dead RPC is a real failure mode; any pair can be replaced with `READBACK_RPC_<CHAIN>`.
- **Sentence:** a saved payee is named with a short address ("Dana, payroll (0xF412…6128)"). Any other recipient is shown in full: live runs on all three EVM chains showed an address-poisoning lookalike and the real payee shorten to the same `0xF4…6128`.
- **1Click behaviour, observed 2026-11-01:** quotes to WETH as recipient now fail with 400 on Ethereum, Base and Arbitrum (Base accepted WETH on 25 Oct, fixture `Q_base_weth`). Other contract recipients (Uniswap V2 router address) are still quoted, and Readback flags them.
- **Spender (agent's own account):** a mandate may name `spender`, the account the money leaves from (default: `owner`). `intent_binding` then requires the intent's `signer_id` to equal the spender. The signed mandate text gains the line "Payments come only from <spender>.", and the service accepts the mandate only if the owner's signing key is also a full-access key on the spender (`owner_does_not_control_spender` otherwise), so nobody can write a mandate for an account they do not control. Vectors I12 to I14.
- **Why the agent gets its own account (verified in `near/intents` source, 2026-11-01):** inside `intents.near`, a registered key "can sign intents on behalf of these accounts, even to add new ones" (`AddPublicKey`). NEAR function-call scoping keeps the agent's key to one contract, but within that contract the key can move the whole balance and add or remove keys. A separate agent account holding a small balance is what limits the damage; Readback limits where that balance can go and refuses key intents.
- **Agent account setup (live on mainnet, 2026-11-01):** Meteor blocks any dapp transaction that adds a full-access key ("Full access key request blocked ... only for approved account recovery services"). A sub-account of the owner can only be created by the owner's wallet, and registering the agent key in `intents.near` needs a full-access key on the agent account (1 yoctoNEAR deposit). So the agent account is a top-level name from the `near` registrar (`invoice-bot-<owner>.near`); the owner's wallet signs only a plain transfer to a temporary setup key's implicit account, and the setup server does the rest with that key, then deletes it. Result for `invoice-bot-olumi15.near`: owner key full access, agent key function-call (`intents.near`, `execute_intents`, 0.25 NEAR), only the agent key registered in `intents.near`. NEAR checks a 30 Tgas call against a worst-case gas price before refunding (`create_account` with a 0.05 NEAR deposit needed 0.0809 NEAR available), and reads at finality `final` trail a just-executed transaction by a few blocks.
- **NEAR payouts (2026-11-01):** `route` now also requires `recipientType: DESTINATION_CHAIN` (`not_a_payout` otherwise): `INTENTS` keeps the money inside `intents.near` under the recipient's name, and 1Click quotes that even for a NEAR name that does not exist, which anyone could register later and claim. For NEAR, `curve` means someone can hold the key: a 64-hex implicit id must be an ed25519 point (1Click signed a payout quote to an off-curve id, vector N05), and a named account must exist (`account_does_not_exist`); `contract` warns when the account has code; `mint` is bad when the recipient is the token contract. Facts come from `view_account` on two NEAR RPCs (`rpc.near_account`; `UNKNOWN_ACCOUNT` means no account). Lookalikes for named accounts are whole names within edit distance 2 (every `.near` name shares its ending), so `alise.near` and `alicee.near` are lookalikes of `alice.near` (vectors N02, N03, both real accounts). Quotes recorded by `research/s11-near-quotes.js`; vectors N01 to N09, D19 to D19c.
