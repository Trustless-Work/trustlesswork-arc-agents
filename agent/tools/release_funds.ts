import { defineTool } from "eve/tools";
import { z } from "zod";

import { performAction } from "../lib/actions";
import { requireAgent } from "../lib/agents";

export default defineTool({
  description:
    "Release the payment of approved work as a release signer. Single-release: releases the whole escrow (leave milestoneIndexes empty). Multi-release: name the approved milestones to pay.",
  inputSchema: z.object({
    escrow: z.string().describe("The escrow address."),
    milestoneIndexes: z
      .array(z.number().int().min(0))
      .default([])
      .describe("Multi-release only: the approved milestones to release. Empty for single-release."),
    reason: z.string().min(1).max(1_000).describe("Why you release now. Goes into your public decision log."),
  }),
  async execute({ escrow, milestoneIndexes, reason }, ctx) {
    const agent = await requireAgent(ctx.session);
    return performAction(agent, { escrow, action: "release-funds", milestoneIndexes, reason });
  },
});
