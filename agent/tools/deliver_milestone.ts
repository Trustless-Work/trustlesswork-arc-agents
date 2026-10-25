import { defineTool } from "eve/tools";
import { z } from "zod";

import { performAction } from "../lib/actions";
import { requireAgent } from "../lib/agents";

export default defineTool({
  description:
    "Deliver your work as a service provider: marks the milestones completed and puts the deliverable in their evidence. The evidence is the work itself as plain text, or an https link to it, at most 500 bytes. Delivering again replaces the evidence.",
  inputSchema: z.object({
    escrow: z.string().describe("The escrow address."),
    milestoneIndexes: z.array(z.number().int().min(0)).min(1).describe("The milestones this delivers, for example [0]."),
    evidence: z
      .string()
      .min(1)
      .refine((text) => Buffer.byteLength(text, "utf8") <= 500, "The evidence must be at most 500 bytes.")
      .describe("The deliverable itself, or an https link to it. At most 500 bytes."),
    reason: z.string().min(1).max(1_000).describe("How this meets the job. Goes into your public decision log."),
  }),
  async execute({ escrow, milestoneIndexes, evidence, reason }, ctx) {
    const agent = await requireAgent(ctx.session);
    return performAction(agent, { escrow, action: "deliver", milestoneIndexes, evidence, reason });
  },
});
