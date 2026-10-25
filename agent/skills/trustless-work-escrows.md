---
description: "Load when you need detail on how Trustless Work escrows work on Arc: every role, the stages of single-release and multi-release escrows, disputes, fees, and what an API error code means."
---

# Trustless Work escrows on Arc, in detail

## Roles

| Role | Does |
| --- | --- |
| `approvers` | Approve milestones (the client, or an independent evaluator such as you) |
| `serviceProviders` | Mark milestones done and attach evidence (the worker) |
| `releaseSigners` | Release the funds once milestones are approved |
| `disputeResolvers` | Split the funds of a disputed escrow (a neutral judge) |
| `receiver` | Gets the payment (single-release; in multi-release each milestone has its own) |
| `platform` | Gets the platform fee |
| `admin` | Can edit the escrow before it is funded |

One wallet can be approver and release signer at once. A dispute resolver cannot hold any other role, and the admin
can also be only the platform.

## Single-release stages

Check them in order; the first that matches is the stage.

| # | The escrow shows | Who acts |
| --- | --- | --- |
| 1 | `released` or `dispute.resolved` is `true` | Nobody: the job is over |
| 2 | `dispute.isDisputed` is `true` | The dispute resolver |
| 3 | `balance` below `amount` | The funder |
| 4 | A milestone is not delivered | The service provider |
| 5 | Delivered, `approvalCount` below `target` | Each approver not yet in `approvedBy` |
| 6 | Every milestone approved, not released | A release signer |

## Multi-release stages

Each milestone has its own `amount`, `receiver`, approvals, dispute and release. The escrow is funded when `balance`
covers the `amount` of every open milestone (open: not released and not resolved). Then, per open milestone:

| # | The milestone shows | Who acts |
| --- | --- | --- |
| M1 | `dispute.isDisputed` is `true` | The dispute resolver |
| M2 | Not delivered | Its service provider |
| M3 | Delivered, `approvalCount` below `target` | Each approver not yet in its `approvedBy` |
| M4 | Approved, not released | A release signer, naming that milestone |

Several milestones can need you at once; act on the ones at the same stage in one call (`milestoneIndexes: [0, 1]`).

## Disputes

- Approvers, service providers, release signers, the receiver and the platform can open one, at any stage before
  release or resolution. Never the dispute resolver.
- While it is open, nothing can be released. The service provider can still update the evidence to answer it.
- The dispute resolver splits the disputed funds between any addresses. The decision is theirs, not the parties'.

## Fees

Every payment pays 0.3% to Trustless Work plus the platform fee, taken from the amount paid: releasing 1 USDC with no
platform fee pays the receiver 0.997 USDC. Amounts are in USDC (6 decimals).

## Error codes your tools may return

| Code | Meaning | What to do |
| --- | --- | --- |
| `ESCROW_NOT_COMPLETED` | Not every approval is in | Approve only; release later |
| `ESCROW_ALREADY_RELEASED`, `ESCROW_ALREADY_RESOLVED` | The escrow is closed | Nothing to do |
| `ESCROW_ALREADY_IN_DISPUTE`, `ESCROW_MILESTONE_ALREADY_DISPUTED` | Someone disputed first | Wait for the resolution |
| `ESCROW_UNAUTHORIZED_…`, `ESCROW_ONLY_…`, `ESCROW_ROLE_MISSING` | Your wallet lacks the role | Do not retry; record a note |
| `ESCROW_PROPERTIES_MISMATCH` | The escrow changed since the build | Read it again and retry once |
| `ESCROW_NOT_ASSIGNED` | The dispatcher never sent you this escrow | Do not act on it |
| `ESCROW_NOT_OFFICIAL`, `BUILD_…` | The build failed a safety check; nothing was signed | Do not retry; record a note |
| `DISTRIBUTION_RECIPIENT_NOT_ALLOWED` | You tried to pay someone who neither did the work nor funded the escrow | Pay only addresses in `allowedRecipients` |
| `DISTRIBUTIONS_TOTAL_MISMATCH` | The split does not add up to the disputed amount | Fix the amounts so they add up exactly |
| `ESCROW_NOT_IN_DISPUTE`, `EscrowNotFullyProcessed` | Nothing to resolve, or the escrow is not finished yet | Read the escrow again |
| `RATE_LIMITED` | Too many requests | Wait a moment and retry once |
