# Readback on OutLayer

The check engine runs a second time inside OutLayer's TEE (Intel TDX) for every payment, and the answer carries a
receipt that anyone can check: this exact module turned this exact input into this exact verdict, in an enclave.

## What is deployed

| | |
|---|---|
| Project | `readback.near/readback` |
| Module | `engine/target/wasm32-wasip2/release/readback-check.wasm`, 214,015 bytes |
| sha256 | `89a21ea9327a39899e44d60de66caa6d9ab2845f695ffe5f7489fbdb431e5d69` |
| Source | https://main.fastfs.io/readback.near/outlayer.near/89a21ea9327a39899e44d60de66caa6d9ab2845f695ffe5f7489fbdb431e5d69.wasm |
| Owner | `readback.near` (created by `setup/scripts/deployer.ts`) |

Rebuild and compare: `cd engine && cargo build --locked --release --target wasm32-wasip2 && sha256sum target/wasm32-wasip2/release/readback-check.wasm`.
The build reproduces this hash, and CI checks that the module gives byte-identical output to the native engine on
every test vector.

## How a verdict gets its receipt

Start the service with `READBACK_OUTLAYER=on` (it needs a payment key from `outlayer keys create`). For each
request it runs the engine locally, sends the same engine input to OutLayer, and checks the attestation record
(`service/src/outlayer.ts`):

1. the module that ran is the pinned build (`wasm_hash` and `executed_wasm_sha256`)
2. `input_hash` is sha256 of the bytes sent, `output_hash` sha256 of the verdict returned (keys sorted)
3. the TDX quote's `report_data` is the task hash over all of the record's fields, so none of them can be edited
   after the quote was signed (format from OutLayer's verifier, `crates/verify-core/src/preimage.rs`)
4. the quote's RTMR3 is the worker measurement the record names

The result is one more check, `enclave`: `ok` with a receipt when all of that holds and the enclave's verdict is
identical to the local one, `error` (HOLD) when there is no verified receipt, `bad` (REFUSED) when the two
verdicts differ. An agent can insist on it: `createGuard({ ..., requireEnclave: true })` refuses any answer the
enclave did not check, and a CLEARED one without a receipt (`READBACK_REQUIRE_ENCLAVE=1` for the demo agent).

What this service does not check itself: the quote's Intel signature chain, and whether the worker measurement
is an approved OutLayer build. OutLayer's own verifier ([out-layer/outlayer-verify](https://github.com/out-layer/outlayer-verify))
does both, from the task id in the receipt:

```sh
cargo install --git https://github.com/out-layer/outlayer-verify --rev 90c27d9d4fc843194ddc6f8ebaafa4eb320c3bb6 --locked outlayer-verify
outlayer-verify job <task_id> --api https://api.outlayer.ai --input <request.json> --output <response.json>
```

`--api` is needed with that version: its built-in default (api.outlayer.fastnear.com) now answers 410.

## Evidence

- [attested-vectors.json](attested-vectors.json): all 65 test vectors run in the enclave on mainnet, 2026-11-02.
  65 of 65 receipts verified, 65 of 65 outputs byte-identical to the native engine (11 CLEARED, 16 HOLD,
  38 REFUSED). Each row has its task id for `outlayer-verify`. Cost: $0.069.
- [verified-vectors.txt](verified-vectors.txt): the same 65 tasks through `outlayer-verify`, 2026-11-03.
  **65 of 65 PROVEN**: Intel signature chain valid (all eight checks, TCB UpToDate), worker measurements approved
  on chain by `worker.outlayer.near`, and each quote bound to that vector's exact input and output. To rerun one,
  write the inputs with `cd engine && RB_DUMP_DIR=vec cargo test --test vectors dump_inputs`, then
  `outlayer-verify job <task> --api https://api.outlayer.ai --input vec/<id>.in.json --output vec/<id>.out.json`.
- [bundles/V01-task-1239345.json](bundles/V01-task-1239345.json): a self-contained evidence bundle (record,
  Intel collateral, payloads) that re-verifies with no network: `outlayer-verify bundle <file> --offline`.
- `service/test/fixtures/outlayer-V01.json`: one real record, used by the tests to show that every edited field,
  a swapped quote, a different module, input or output is caught.
- Live demo agent, dry run with the enclave required: 1 USDC to the saved payee CLEARED, checked in task
  1239390; a lookalike address REFUSED.

## Costs and limits

About $0.001 and 0.4 s of enclave time per check (3.5M instructions; OutLayer's default limit is 1e9). The record
appears a second or two after the call returns; the service waits up to 20 s for it, then HOLDs.

Top up a payment key with USDC (`outlayer keys topup <nonce> --usd <amount>`), not with NEAR: the NEAR path in
CLI 0.2.1 loses the funds (https://github.com/out-layer/outlayer-cli/issues/5).
