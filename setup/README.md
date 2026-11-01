# Demo agent setup

A local page (`npm install && npm run bundle && npm start`, then http://127.0.0.1:5320) that walks the owner through setting up the agent account `invoice-bot-<owner>.near`:

1. **Connect** Meteor. The page loads a pinned wallet list with only Meteor (`manifest.json`), not near-connect's default list from a mutable GitHub branch. Meteor's wallet script still loads from Meteor's own mutable URL, so the server compares its SHA-256 with the reviewed one on start and warns if it changed.
2. **Sign the mandate**: a NEP-413 message, no gas. The page shows the exact text first. Payee names cannot contain commas, brackets or line breaks, so the signed text cannot be made to read like a different list of payees.
3. **Send NEAR to the setup account**: one plain transfer (0.12 NEAR) from the owner's wallet to the implicit account of a temporary key this computer holds. No keys, no contract call. Wallets refuse to let a page add full-access keys (Meteor: "Full access key request blocked"), so the wallet never does.
4. **Create the agent account** (no wallet): with the temporary key the server calls the `near` registrar's `create_account` (0.05 NEAR), adds the owner's wallet key with full access and the agent key as a function-call key (`intents.near`, `execute_intents`, 0.25 NEAR gas), registers the agent key in `intents.near` (`add_public_key` with 1 yoctoNEAR, which a function-call key cannot attach), deletes the temporary key, closes the setup account so its remaining NEAR returns to the owner, and deletes the key file. Each step reads the chain first, so it resumes after a failure. It will not delete the temporary key before the owner's key has full access.
5. **Fund** the agent from Base through a 1Click deposit address. The owner sends USDC from their own Base wallet; refunds go back to it.
6. **Check**: the mandate verifies, the agent key is a function-call key for `intents.near` only, it is registered, and the balance has arrived.

Keys: the agent key (`~/.readback/agent-key.json`) and the temporary key (`~/.readback/setup-temp-key.json`, deleted at the end of step 4) never enter the repository or the browser. On Windows the files are not restricted to the owner by file mode; they rely on the user profile's permissions.

The server listens on 127.0.0.1 only and refuses POST requests from any other origin.
