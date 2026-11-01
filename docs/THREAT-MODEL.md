# Readback threat model v0.1 (pre-hackathon design)

Written 2026-10-23, before the build. Scope: Readback itself (the checker, its receipts, its approver key and its UI), not the chains or 1Click.

## Assets

1. The owner's funds (Readback never holds them, but its verdict gates them).
2. Approval authority: a CLEARED receipt, or Readback's approver signature in OutLayer mode.
3. Mandates: what the owner allowed.
4. Receipt integrity: a verdict must mean what it says, for exactly one request.
5. Owner privacy in public logs.

## Actors

- A compromised or prompt-injected **agent** (the main adversary).
- A **middleman** between 1Click and Readback (proxy, malicious SDK, tampered agent runtime).
- A **lying RPC** used for contract/mint lookups.
- A malicious or careless **Readback operator** (us), including a bad deploy.
- A **phishing clone** of the Readback UI.
- **Public Siege attackers** (invited).

## Threats and mitigations

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | Agent hands over a doctored quote (recipient, amount, deadline changed) | Verify the 1Click signature with the pinned key | Verified possible (spike 3) |
| T2 | Doctored fields the signature does not cover (appFees; fees on dry quotes) | Never clear on uncovered fields; label them "as reported"; prefer non-dry quotes | Known gap, by design on 1Click's side |
| T3 | Dangerous intent hidden in a batch (add_public_key, auth_call, set_auth_by_predecessor_id) | Decode all 13 types; deny-list plus expected-shape allow-list; unknown type refused | Designed |
| T4 | Address poisoning or lookalike payee | Full-address equality plus lookalike check; show the full address with differing characters highlighted | Designed (mock shows it) |
| T5 | Valid address on the wrong chain | Pin the chain from the mandate; checksum validation; 17 EVM chains share one format | Verified (spike 5) |
| T6 | Funds sent to an address with no key | Curve check; 1Click does not reject these on dry quotes | Verified (spikes 4, 6) |
| T7 | RPC lies about contract code or mint ownership | Two or more independent RPCs must agree; disagreement holds | Designed |
| T8 | Check-then-swap: verdict for request A, owner signs request B | Receipt binds `request_hash`; approval UI compares hash before signing; receipt expires in 5 min | Designed |
| T9 | Replay of an old CLEARED receipt | Expiry plus request_hash binding; approval ids are single use on OutLayer's side | Designed |
| T10 | Readback approver key stolen | Key lives only in the enclave; code hash pinned in owner settings; owner can remove Readback from the policy | Depends on day-1 OutLayer test |
| T11 | Operator ships bad code | Owner pins a code hash; new versions need owner approval; attestations let anyone check which binary ran | Designed; reproducible builds needed to tie binary to source |
| T12 | Readback offline | Fail closed: no verdict means nothing to approve. Accepted cost: payments wait | Accepted |
| T13 | Mandate tampering | Mandates are NEP-413 signed by the owner; Readback checks the signature and expiry | Designed |
| T14 | Text injection via memo/msg | Escape and label agent text; never interpret it | Designed |
| T15 | Cumulative cap race (many small payments at once) | Readback serializes per mandate and tracks spend; OutLayer docs say its own cumulative limits are best-effort | Designed |
| T16 | Phishing clone of the UI | Receipts verify independently of the UI; the approve message names the request hash | Partial |
| T17 | Public Siege log leaks owner data | Only the demo agent's attempts are logged; no personal data; demo funds only | Designed |

## Trust we cannot remove

- Intel TDX hardware and its attestation chain; whoever approves enclave builds on OutLayer.
- 1Click's signing key (we verify signatures, but trust that the key belongs to 1Click; taken from their SDK source).
- The chain data behind the token list.

## Out of scope

A saved payee whose own keys are stolen; a request that passes every rule but is a bad business decision; funds already lost (Readback explains, it cannot recover); 1Click's off-chain routing.

## Added 2026-10-25 (spike 8)

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T18 | Wallet connector loads wallet bridge scripts from mutable URLs (default manifest on a GitHub `main` branch, no integrity check) | Self-host a reviewed manifest; `excludedWallets`; bridges run in a sandboxed iframe; every owner signature verified server-side against the exact payload, so a swapped message never counts as approval of request X | Designed; verified that the library accepts a custom manifest |
| T19 | RPC error shape misread as a valid answer ("does not exist" arrives inside `result`) | Treat `result.error` as not found; tests cover missing key, function-call key, missing account | Verified (spike 8 caught a wrong reason message) |
| T20 | Sign-in signature replayed or reused on another site | Single-use server nonce burned on first use, 5-minute expiry, recipient bound to our domain | Verified (spike 8 tests) |
| T21 | Relay attack: a phishing page gets a Readback nonce and asks the owner to sign; the wallet shows the phishing origin but not the recipient, and does not compare them, so the signature is valid for Readback | Sign-in only grants a read-only session; every money-moving approval needs its own signature over a message that states the action in plain words plus the request hash, so a relayed signature can only approve what the owner read in their wallet; message tells the owner which domain to expect | Found 2026-10-25 (Meteor shows origin, not recipient) |
