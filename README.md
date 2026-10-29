# Trustless Work agents on Arc

Autonomous agents that take a role in [Trustless Work](https://trustlesswork.com) escrows on Arc testnet. Anyone can
create one with its roles, and the agent gets its own Circle wallet. From then on it works alone: when an escrow names
its wallet, the agent reads it and does its part. No person signs for it.

## Roles

| Role | What the agent does | Woken when |
| --- | --- | --- |
| Approver | Judges each delivery against the escrow's terms, then approves it or disputes it | A funded milestone is delivered |
| Release signer | Releases approved work (with approver too: approves and releases in one step) | Every approval is in |
| Service provider | Does the job, delivers it as evidence (text or a link, 500 bytes), answers disputes on its work; it can also be the receiver | The escrow is funded; its work is disputed |
| Dispute resolver | Judges disputes and splits the disputed funds; returns funds left in a finished escrow | A dispute opens; a finished escrow still holds USDC |
| Admin | Holds the admin slot (and the platform slot) and never edits the escrow, so no person can change its terms | Never: it has nothing to do on its own |

One agent is one wallet, so its roles follow the contract's rules for one address (the same on Stellar and Arc): a
dispute resolver holds no other role, and an admin shares its address only with the platform. Approver, release
signer and service provider combine freely. `POST /agents` rejects any other combination.

Built with [eve](https://eve.dev), Vercel's agent framework, and Circle developer-controlled wallets.

## How it works

1. **Create an agent** with `POST /agents`: a name, its roles and, optionally, standing instructions and an existing
   Circle wallet. Without a wallet, the agent gets a new smart contract account on Arc testnet, whose gas Circle
   sponsors. Its roles and wallet never change. Its name, instructions and scope can be edited with
   `PATCH /agents/:id`: each edit is a new public version with its own `configHash`, and an escrow keeps the version
   the agent had when it picked the escrow up, so nobody can change a judge's criteria in the middle of a job.
   `DELETE /agents/:id` deletes an agent with no open escrows; its record and decision log stay, marked deleted.
2. **Name the agent in an escrow.** Whoever creates the escrow puts the agent's wallet address in its roles. The
   escrow decides what the agent can really do; the agent's roles decide what it will try.
3. **The dispatcher** (`agent/schedules/dispatch.ts`, every minute) scans the factories for new escrows that name an
   agent, and wakes an agent when one of its escrows needs it (see "Woken when" above). It wakes it once per escrow
   state, and at most twice if the state does not change, so an idle escrow costs no model calls.
4. **The agent decides** in its own session for that escrow, with the escrow tools only (no shell, no files):
   `get_escrow`, `fetch_evidence`, `approve_milestones`, `approve_and_release`, `release_funds`, `deliver_milestone`,
   `open_dispute`, `resolve_dispute`, `return_leftover_funds` and `record_note`. Every decision goes into its public
   decision log with the reason.

### What protects the funds

Every transaction goes through `agent/lib/actions.ts` before it is signed:

- the agent's roles, and the roles its wallet holds in that escrow, must allow the action;
- the escrow must be one the dispatcher assigned to the agent;
- the Trustless Work API builds the call, and the result is checked against the chain: it must go to the escrow
  itself, the escrow must be a clone of the official implementation (only the official factory can create one), and
  the decoded call must be exactly the function and arguments requested.

The model never chooses the wallet, the contract or the call data. Approvers and release signers cannot send funds
anywhere: a release always pays the receiver set in the escrow. A dispute resolver can split funds between any
addresses on-chain, so the code limits it to the side that did the work (service providers and receivers) and the
side that paid (the funders, read from the escrow's own events, and its creator), never to itself.

### Who controls what

Be precise about this when you describe it. The agent's decisions are its own: nobody approves them, and production
exposes no route to chat with an agent or sign for it. But the deployment still has an operator. Whoever controls the
Vercel project can change the code, and whoever holds the Circle entity secret controls the wallets created with it.
Whoever holds the factory token can also edit an agent's name, instructions and scope, or delete it once it has no open
escrows; roles and wallet never change, every edit is a public version, and escrows under way keep the version they
started with. The open code, the version history and the decision log make that power visible; they do not remove it.
To have no key holder at all, the signer must live outside this stack (for example, in an attested enclave).

## Run it locally on Arc testnet

The service runs on your machine and its agents work on Arc testnet. You need:

| What | Where to get it |
| --- | --- |
| Node.js 24 | [nodejs.org](https://nodejs.org) |
| `curl` and `jq` | Your system's package manager |
| A Claude API key (`ANTHROPIC_API_KEY`) | [console.anthropic.com](https://console.anthropic.com). Or edit `agent/agent.ts` to use another model |
| A Trustless Work API key for Arc (`TW_API_KEY`) | Ask any member of the Trustless Work team on Telegram, or post in our [Telegram group](https://t.me/+9FJnzKamvEdiZjNh) that you need an API key for the Arc API |
| A Circle developer account and a testnet API key (`CIRCLE_API_KEY`) | [console.circle.com](https://console.circle.com) |

The agents use Claude Sonnet 5.5, and one decision costs about $0.04. Gas costs you nothing: agent wallets are smart
contract accounts, and Circle sponsors their gas on testnet.

### 1. Install and configure

```bash
git clone https://github.com/Trustless-Work/trustlesswork-arc-agents.git
cd trustlesswork-arc-agents
npm install
cp .env.example .env.local      # fill in ANTHROPIC_API_KEY, TW_API_KEY and CIRCLE_API_KEY
npm run circle:entity-secret    # once: creates and registers the Circle entity secret, saved in .env.local
```

The entity secret controls every wallet the service creates. The script also saves Circle's recovery file in
`.data/circle-recovery/`: keep a copy somewhere safe, because it is the only way to reset the secret. `.env.local` and
`.data/` are git-ignored.

### 2. Start the service

```bash
npm run dev         # http://localhost:2000
npm run dev:cron    # in a second terminal
```

`eve dev` does not run schedules on its own, so `npm run dev:cron` fires the dispatcher every minute through eve's dev
dispatch route. You can also wake one agent at once with `POST /agents/:id/check`. A Vercel deployment runs the
schedule every minute.

### 3. Create the agents

This example fills every role of the escrow with an agent: a writer delivers a post, a reviewer judges it, an arbiter
settles disputes, and an admin holds the admin slot so nobody can change the terms. Each agent gets a new wallet.

```bash
create() {
  curl -s -X POST http://localhost:2000/agents -H 'content-type: application/json' -d "$1" |
    jq -r 'if .agent then "\(.agent.name)  id \(.agent.id)  wallet \(.agent.wallet.address)" else . end'
}
create '{"name":"Writer","roles":["serviceProvider"],"instructions":"You write short social media posts. Deliver the post itself as the evidence."}'
create '{"name":"Reviewer","roles":["approver","releaseSigner"],"instructions":"You review short social media posts. Approve only if every requirement in the escrow description is met exactly, including length limits counted in characters."}'
create '{"name":"Arbiter","roles":["disputeResolver"],"instructions":"Settle disputes on the escrow terms and the evidence: pay the writer for work that meets them, refund the client otherwise."}'
create '{"name":"Admin","roles":["admin"]}'
```

Note each agent's id and wallet.

### 4. Create and fund an escrow that names them

Agents never create or fund escrows; a client does, with its own wallet and testnet USDC from
[faucet.circle.com](https://faucet.circle.com) (network: Arc testnet). The escrow puts the agents' wallets in its roles:

| Escrow role | Wallet |
| --- | --- |
| Service provider and receiver | Writer |
| Approver and release signer | Reviewer |
| Dispute resolver | Arbiter |
| Platform and admin | Admin |

Two ways to be the client:

- **An AI agent with the Circle CLI.** Install the
  [Trustless Work Arc skill](https://github.com/Trustless-Work/trustlesswork-arc-skill) in an agent such as Claude Code,
  log in to an Agent Wallet as its README says, and give it a prompt like this one:

  ```text
  You are a CLIENT agent. Create and fund a Trustless Work single-release escrow on Arc testnet, then stop.

  - Trustless Work API: https://arc-api-demo-production.up.railway.app. API key: in <KEY_FILE>; never print it.
  - Your wallet (Circle Agent Wallet, logged in on testnet, holding testnet USDC): <YOUR_WALLET>
  - Amount: 1 USDC, in one milestone: "A post about Arc, at most 280 characters, with no emojis."
  - Roles: service provider and receiver <WRITER_WALLET>; approver and release signer <REVIEWER_WALLET>;
    dispute resolver <ARBITER_WALLET>; platform and admin <ADMIN_WALLET>.

  Report the escrow address and the transaction hashes.
  ```

- **Your own wallet and the API.** The Trustless Work API builds each call (`deploy`, then `approve-token` and `fund`
  under `/escrow/single-release/v2/`), and you sign and send it with any Arc testnet wallet. The routes are in the
  [API docs](https://arc-api-demo-production.up.railway.app/docs).

### 5. Watch them work

Within a minute or two of the funding, the writer delivers, the reviewer approves and releases or opens a dispute, and
the arbiter settles any dispute. Follow each agent with:

```bash
curl -s http://localhost:2000/agents/<AGENT_ID> | jq
```

It shows the escrows the agent watches and its decision log, with the reason for each decision and a link to every
transaction on the Arc testnet explorer.

### If something does not work

| What you see | What to do |
| --- | --- |
| `AGENT_WALLET_FAILED` with `CIRCLE_API_KEY is not set` (or `CIRCLE_ENTITY_SECRET`) | Fill it in `.env.local` (step 1) and restart `npm run dev` |
| `API_KEY_INVALID` from the Trustless Work API | Check `TW_API_KEY` in `.env.local`. Keys expire after 90 days; ask the team for a new one |
| An agent never reacts | Check that `npm run dev:cron` is running. The first scan only looks about 16 minutes back, so for an escrow created before the service first ran, call `POST /agents/:id/escrows` with `{"escrow": "<address>"}` |
| `RATE_LIMITED` | The service waits and retries on its own. A key allows 60 requests a minute, and the service reads each open escrow at most once a minute; if you run many escrows at once, ask the team for a higher limit |

## API

| Route | Does |
| --- | --- |
| `POST /agents` | Creates an agent. Body: `{"name", "roles": ["approver", "releaseSigner"], "instructions"?, "onlyEscrowsFrom"?: [address], "wallet"?: {"walletId"}}`. Needs `Authorization: Bearer $AGENT_FACTORY_TOKEN` when that is set, and always in production |
| `GET /agents` | Lists agents. `?includeDeleted=true` adds deleted ones |
| `PATCH /agents/:id` | Edits `name`, `instructions` or `onlyEscrowsFrom` as a new version. Same token rule as creating |
| `DELETE /agents/:id` | Deletes an agent with no open escrows (`409 AGENT_HAS_OPEN_ESCROWS` otherwise). Same token rule |
| `GET /agents/:id` | An agent, the escrows it watches and its decision log |
| `GET /agents/:id/escrows/:escrow` | An escrow as the agent sees it (its own `get_escrow` tool) |
| `POST /agents/:id/escrows` | Asks the agent to watch an escrow created before it existed or outside the scan. Body: `{"escrow"}` |
| `POST /agents/:id/check` | Runs the dispatcher now for that agent |

Example:

```bash
curl -s -X POST http://localhost:2000/agents -H 'content-type: application/json' \
  -d '{"name":"Post reviewer","roles":["approver","releaseSigner"],"instructions":"Reject posts with emojis."}'
```

## Development

```bash
npm test           # unit tests
npm run typecheck
npx eve info       # what eve discovered
```

The agent registry and decision log live in `.data/agents.json`, which is enough for local tests on one process. A
deployment needs a database behind the same functions in `agent/lib/store.ts`.

## License

[Apache-2.0](LICENSE)
