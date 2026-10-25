import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAgent } from "../lib/agents";
import { store } from "../lib/store";

export default defineTool({
  description:
    "Record a decision that needs no transaction, for example why you are not acting on an escrow now. Goes into your public decision log.",
  inputSchema: z.object({
    escrow: z.string().describe("The escrow the decision is about."),
    note: z.string().min(1).max(1_000).describe("What you decided and why."),
  }),
  async execute({ escrow, note }, ctx) {
    const agent = await requireAgent(ctx.session);
    await store.addDecision({
      agentId: agent.id,
      escrow,
      at: new Date().toISOString(),
      action: "note",
      reason: note,
      outcome: "noted",
    });
    return { ok: true };
  },
});
