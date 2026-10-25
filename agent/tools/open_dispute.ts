import { defineTool } from "eve/tools";
import { z } from "zod";

import { performAction } from "../lib/actions";
import { requireAgent } from "../lib/agents";

export default defineTool({
  description:
    "Open a dispute: it stops payment and hands the case to the escrow's dispute resolver. Use it when the agreement is broken (a delivery missing, wrong or unverifiable) or, as a service provider, when you cannot do the job. Never on an unfunded escrow.",
  inputSchema: z.object({
    escrow: z.string().describe("The escrow address."),
    milestoneIndexes: z
      .array(z.number().int().min(0))
      .default([])
      .describe("Multi-release only: the milestones you dispute. Empty for single-release (it disputes the whole escrow)."),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe("Your case, public and on-chain: what the agreement required, what you found, and the outcome you ask for."),
  }),
  async execute({ escrow, milestoneIndexes, reason }, ctx) {
    const agent = await requireAgent(ctx.session);
    return performAction(agent, { escrow, action: "dispute", milestoneIndexes, reason });
  },
});
