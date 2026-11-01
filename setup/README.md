# Demo agent setup

A local page (`npm install && npm run bundle && npm start`, then http://127.0.0.1:5320) that walks the owner through setting up `invoice-bot.<owner>.near`:

1. **Connect** Meteor. The page loads a pinned wallet list with only Meteor (`manifest.json`), not near-connect's default list from a mutable GitHub branch. Meteor's wallet script still loads from Meteor's own mutable URL, so the server compares its SHA-256 with the reviewed one on start and warns if it changed.
2. **Sign the mandate**: a NEP-413 message, no gas. The page shows the exact text first. Payee names cannot contain commas, brackets or line breaks, so the signed text cannot be made to read like a different list of payees.
3. **Create the agent account**: one transaction from the owner. It creates the account with 0.05 NEAR and three keys: the owner's wallet key (full access, so the owner keeps control and Readback can confirm it), the agent key (function-call: `intents.near`, `execute_intents`, 0.25 NEAR gas) and a temporary full-access key.
4. **Register the agent key** in `intents.near`. That call needs 1 yoctoNEAR, which a function-call key cannot attach, so the local server signs it with the temporary key and then deletes the temporary key on chain, and checks it is gone.
5. **Fund** the agent from Base through a 1Click deposit address. The owner sends USDC from their own Base wallet; refunds go back to it.
6. **Check**: the mandate verifies, the agent key is a function-call key for `intents.near` only, it is registered, and the balance has arrived.

Keys: the agent key (`~/.readback/agent-key.json`) and the temporary key (`~/.readback/setup-temp-key.json`, removed after step 4) never enter the repository or the browser. On Windows the files are not restricted to the owner by file mode; they rely on the user profile's permissions.

The server listens on 127.0.0.1 only and refuses POST requests from any other origin.
