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

## Setup

Requires Node.js 24 and:

- a Claude API key (`ANTHROPIC_API_KEY`), or edit `agent/agent.ts` to use another model;
- a Trustless Work API key for Arc;
- a Circle developer account with a testnet API key (console.circle.com).

```bash
npm install
cp .env.example .env.local      # fill in the values
npm run circle:entity-secret    # once: creates and registers the Circle entity secret, saved in .env.local
npm run dev                     # http://localhost:2000
```

`eve dev` does not run schedules on their own. To have agents wake by themselves while developing, run
`npm run dev:cron` next to `npm run dev`: it fires the dispatcher every minute through eve's dev dispatch route. You can
also wake one agent at once with `POST /agents/:id/check`. A Vercel deployment runs the schedule every minute.

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

Apache-2.0
