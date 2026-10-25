import { defineDynamic, defineInstructions } from "eve/instructions";

import { agentIdOf, configFor, escrowOf } from "../lib/agents";
import { agentBriefing } from "../lib/briefing";
import { store } from "../lib/store";

/**
 * Adds the agent's own roles, wallet and standing instructions, read from the session's identity. On an escrow, the
 * instructions are the version the agent had when it picked that escrow up.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const auth = ctx.session.auth.initiator ?? ctx.session.auth.current;
      const id = agentIdOf(auth);
      const agent = id ? await store.getAgent(id) : undefined;
      if (!agent || agent.deletedAt) {
        return defineInstructions({
          content:
            "## Who you are\nThis session does not belong to an active Trustless Work agent. You have no wallet and no roles: do not try to act on any escrow, and say so.",
        });
      }
      const escrow = escrowOf(auth);
      const watch = escrow ? await store.getWatch(agent.id, escrow) : undefined;
      return defineInstructions({ content: agentBriefing(agent, configFor(agent, watch?.configVersion)) });
    },
  },
});
