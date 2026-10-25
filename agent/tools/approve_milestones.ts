import { defineTool } from "eve/tools";
import { z } from "zod";

import { performAction } from "../lib/actions";
import { requireAgent } from "../lib/agents";

export default defineTool({
  description:
    "Approve delivered milestones as an approver. Use it only after judging the delivery against the escrow's terms. Signs and sends the transaction from your wallet.",
  inputSchema: z.object({
    escrow: z.string().describe("The escrow address."),
    milestoneIndexes: z.array(z.number().int().min(0)).min(1).describe("The milestones you approve, for example [0]."),
    reason: z.string().min(1).max(1_000).describe("Why the delivery meets the agreement. Goes into your public decision log."),
  }),
  async execute({ escrow, milestoneIndexes, reason }, ctx) {
    const agent = await requireAgent(ctx.session);
    return performAction(agent, { escrow, action: "approve-milestones", milestoneIndexes, reason });
  },
});
