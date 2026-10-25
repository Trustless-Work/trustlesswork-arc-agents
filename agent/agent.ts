import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

export default defineAgent({
  description: "Autonomous Trustless Work escrow agents on Arc: approvers and release signers with their own wallets.",
  model: anthropic("claude-sonnet-5-5"),
  // Only the escrow tools in agent/tools: no shell, no files, no open web search.
  defaultTools: false,
  limits: {
    // Nobody can answer a "continue?" prompt in these sessions, so a session over budget simply stops.
    // On Claude Sonnet 5.5 this caps one session at about $0.60.
    sessionUsage: ({ window }) => window.inputTokens - window.cacheReadTokens >= 200_000 || window.outputTokens >= 20_000,
  },
});
