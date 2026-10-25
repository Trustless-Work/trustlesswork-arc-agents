import { defineTool } from "eve/tools";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

import { requireAgent } from "../lib/agents";
import { allowedRecipients } from "../lib/actions";
import { escrowHistory, isOfficialEscrow } from "../lib/chain";
import { escrowRolesOf } from "../lib/escrow";
import { ROLE_LABELS, allowedActions } from "../lib/roles";
import { store } from "../lib/store";
import { getEscrow, TwApiError } from "../lib/tw-api";

export default defineTool({
  description:
    "Read an escrow as it is now: its terms, roles, balance, milestones with their evidence and approvals, dispute and release state, plus which of your roles your wallet holds in it.",
  inputSchema: z.object({ escrow: z.string().describe("The escrow address (contractId).") }),
  async execute({ escrow }, ctx) {
    const agent = await requireAgent(ctx.session);
    if (!isAddress(escrow)) return { ok: false, code: "BAD_ESCROW", detail: `${escrow} is not an address.` };
    const address = getAddress(escrow);
    try {
      const view = await getEscrow(address);
      const roles = escrowRolesOf(view, agent.wallet.address, agent.roles);
      const watch = await store.getWatch(agent.id, address);
      const { escrowHash: _hash, ...terms } = view;
      // A dispute resolver needs to know who funded and who disputed, and whom it may pay.
      const judging = roles.includes("disputeResolver")
        ? await escrowHistory(address, watch?.createdBlock ? BigInt(watch.createdBlock) : undefined).then((history) => ({
            history: { funders: history.funders, disputedBy: history.disputedBy, deployer: watch?.deployer },
            allowedRecipients: allowedRecipients(view, history.funders, watch?.deployer),
          }))
        : {};
      return {
        ok: true,
        escrow: terms,
        you: {
          wallet: agent.wallet.address,
          roles: roles.map((role) => ROLE_LABELS[role]),
          allowedActions: allowedActions(roles),
          assignedByDispatcher: Boolean(watch),
        },
        ...judging,
        officialTrustlessWorkEscrow: await isOfficialEscrow(address, view.type),
      };
    } catch (error) {
      if (error instanceof TwApiError) return { ok: false, code: error.code, detail: error.detail };
      throw error;
    }
  },
});
