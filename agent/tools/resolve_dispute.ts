import { defineTool } from "eve/tools";
import { z } from "zod";

import { performAction } from "../lib/actions";
import { requireAgent } from "../lib/agents";

export default defineTool({
  description:
    "Decide a dispute as its dispute resolver and split the disputed funds. The distributions must add up exactly to the disputed amount (single-release: the whole balance; multi-release: the disputed milestones' amount), and may only pay the side that did the work or the side that paid (allowedRecipients in get_escrow). Fees come out of each payment.",
  inputSchema: z.object({
    escrow: z.string().describe("The escrow address."),
    milestoneIndexes: z
      .array(z.number().int().min(0))
      .default([])
      .describe("Multi-release only: the disputed milestones this resolves. Empty for single-release."),
    distributions: z
      .array(z.object({ address: z.string(), amount: z.number().positive().describe("USDC, for example 0.75.") }))
      .min(1)
      .max(10)
      .describe("Who gets what, in USDC. Each address once."),
    reason: z.string().min(1).max(1_000).describe("Your ruling: what you found and why the split follows from the agreement."),
  }),
  async execute({ escrow, milestoneIndexes, distributions, reason }, ctx) {
    const agent = await requireAgent(ctx.session);
    return performAction(agent, { escrow, action: "resolve-dispute", milestoneIndexes, distributions, reason });
  },
});
