import { defineTool } from "eve/tools";
import { z } from "zod";

import { performAction } from "../lib/actions";
import { requireAgent } from "../lib/agents";

export default defineTool({
  description:
    "Return USDC left in a finished escrow (released or resolved), as its dispute resolver. The distributions must add up exactly to the balance and may only pay the side that did the work or the side that paid (allowedRecipients in get_escrow).",
  inputSchema: z.object({
    escrow: z.string().describe("The escrow address."),
    distributions: z
      .array(z.object({ address: z.string(), amount: z.number().positive().describe("USDC, for example 0.25.") }))
      .min(1)
      .max(10)
      .describe("Who gets what, in USDC. Each address once."),
    reason: z.string().min(1).max(1_000).describe("Why the funds go there. Goes into your public decision log."),
  }),
  async execute({ escrow, distributions, reason }, ctx) {
    const agent = await requireAgent(ctx.session);
    return performAction(agent, {
      escrow,
      action: "withdraw-remaining-funds",
      milestoneIndexes: [],
      distributions,
      reason,
    });
  },
});
