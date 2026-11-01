# Readback agent guard and demo agent

`src/guard.ts` is the agent-side guard: the only path from an agent to its signer. `demo/` is a demo agent that pays from its own NEAR Intents balance through that guard.

## What the guard does

- **CLEARED:** the signer runs once, on a frozen copy of exactly the request Readback checked.
- **REFUSED:** the signer never runs, and no human is asked to override it.
- **HOLD:** a human is asked. They see the plain sentence, the full recipient address, the reasons and the request hash. Only an explicit `true` approves; any other answer, an error or a timeout declines. Readback then looks again, and anything new since the human answered is refused.
- **Anything unexpected is REFUSED:** Readback unreachable, an HTTP error, an answer for another request (`request_hash`) or mandate (`mandate_fingerprint`), an answer that does not add up (CLEARED with a failing check), or an engine that is not pinned.

## The demo agent's key, and its limits

The agent spends from its own account, `invoice-bot-<owner>.near`, never from the owner's account. Its key is one ed25519 key pair, kept in `~/.readback/agent-key.json` (outside the repository; the agent refuses a key file inside it).

**On NEAR, it is a function-call access key**, scoped to `intents.near` with the method `execute_intents` and a gas allowance. It can never be a full-access key: on every start the agent reads its own key from two NEAR RPCs and refuses to run if it has full access, is scoped to any other contract, or is not registered in `intents.near` (`npm run pay -- --check`). As a function-call key it cannot:

- transfer NEAR or attach any deposit, so it cannot call `add_public_key`, `remove_public_key` or `ft_transfer`, which all require 1 yoctoNEAR;
- call any contract other than `intents.near`;
- add or delete keys on the NEAR account, or delete the account.

When its gas allowance is used up the key stops working. The owner's full-access key stays on the agent account, so the owner can add a new key, remove this one, and withdraw the balance.

**Inside `intents.near` the same key can do far more, and that is the real limit to understand.** The owner registers it there once (`add_public_key`, 1 yoctoNEAR, which needs the owner's full-access key). After that, by the contract's design, a registered key "can sign intents on behalf of these accounts, even to add new ones" (`near/intents`, `AddPublicKey`). Intents are signed off chain and submitted by a relayer, so the NEAR key scoping above does not apply to them. With the agent key alone, intents can:

- move the agent account's whole Intents balance to any address on any chain;
- add a new key to the agent account in `intents.near`, or remove the owner's.

What actually limits the damage:

1. **The agent account holds only a small balance.** That balance is all the key can reach.
2. **Readback** clears a payment only if it matches the owner-signed mandate: saved payees, cap, chain, refund address and slippage, a genuine 1Click quote, and an intent bound to that quote and signed by the agent account. It refuses intents that add or remove keys or change authentication.
3. **The guard** signs only after Readback, and only what Readback checked.

What Readback cannot stop: if the machine running the agent is compromised, the attacker holds the key and can skip the guard. The agent account's balance is then at risk, which is why it should stay small.

## Setting up the demo agent

Use the setup page in `setup/` (see its README): the owner signs the mandate, sends one plain NEAR transfer, and the page does the rest. The demo agent on mainnet is `invoice-bot-olumi15.near` (set up 1 November 2026): one full-access key held by the owner's wallet, one function-call key for the agent, and only the agent key registered in `intents.near`.

## Commands

```
npm test                                    # 25 of 25: guard against the real service, and the demo agent
npm run pay -- --check                      # what the agent's key can do, read from two NEAR RPCs
npm run pay -- <recipient> <amount>         # dry run: quote, intent, Readback, signed intent; nothing submitted
npm run pay -- <recipient> <amount> --live  # also submits the signed intent, only if Readback allowed it
```
