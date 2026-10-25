import { defineTool } from "eve/tools";
import { z } from "zod";

import { performAction } from "../lib/actions";
import { requireAgent } from "../lib/agents";

export default defineTool({
  description:
    "Approve delivered milestones and release their payment in one transaction. Only for a wallet that is both approver and release signer, when its approval is the last one needed; otherwise it answers ESCROW_NOT_COMPLETED.",
  inputSchema: z.object({
    escrow: z.string().describe("The escrow address."),
    milestoneIndexes: z.array(z.number().int().min(0)).min(1).describe("The milestones you approve and release."),
    reason: z.string().min(1).max(1_000).describe("Why the delivery meets the agreement. Goes into your public decision log."),
  }),
  async execute({ escrow, milestoneIndexes, reason }, ctx) {
    const agent = await requireAgent(ctx.session);
    return performAction(agent, { escrow, action: "approve-and-release-milestones", milestoneIndexes, reason });
  },
});
