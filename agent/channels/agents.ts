import { DELETE, defineChannel, GET, PATCH, POST } from "eve/channels";
import { extractBearerToken } from "eve/channels/auth";
import { getAddress, isAddress } from "viem";

import {
  AgentBusyError,
  AgentGoneError,
  agentPrincipal,
  createAgent,
  createAgentInput,
  deleteAgent,
  publicAgent,
  updateAgent,
  updateAgentInput,
} from "../lib/agents";
import { agentFactoryToken, isProduction } from "../lib/config";
import { attachEscrow, dispatchWork, sessionAddress, type Deliver, type WorkTarget } from "../lib/dispatch";
import { parseAddress, stepFinished, stepsRequested, turnEnded, turnStarted } from "../lib/activity";
import { store } from "../lib/store";
import { TwApiError } from "../lib/tw-api";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function problem(status: number, code: string, detail: string): Response {
  return json({ code, detail }, status);
}

/** Creating, editing and deleting agents needs AGENT_FACTORY_TOKEN when it is set, and always in production. */
function canManage(request: Request): boolean {
  const token = agentFactoryToken();
  if (!token) return !isProduction();
  return extractBearerToken(request.headers.get("authorization")) === token;
}

/**
 * The agent factory and the dispatcher's way in. Anyone can read an agent, its versions and its decision log. Nobody can
 * send an agent instructions; its name, instructions and scope can be edited (as a new, public version that escrows
 * already under way do not use), and an agent with no open escrows can be deleted.
 */
export default defineChannel<undefined, void, WorkTarget>({
  turnPolicy: "queue",

  async receive({ message, target, auth }, { from }) {
    return from(sessionAddress(target)).send(message, { auth, idempotencyKey: target.key });
  },

  /** Records, live, that an agent is working on an escrow and what each step is. */
  events: {
    async "turn.started"(_data, channel, ctx) {
      const at = parseAddress(channel.continuation?.token);
      if (at) await turnStarted(at.agentId, at.escrow, ctx.session.id);
    },
    async "actions.requested"(data, channel) {
      const at = parseAddress(channel.continuation?.token);
      if (at) await stepsRequested(at.agentId, at.escrow, data.actions);
    },
    async "action.result"(data, channel) {
      const at = parseAddress(channel.continuation?.token);
      const output = data.result.output as { ok?: boolean } | undefined;
      if (at) await stepFinished(at.agentId, at.escrow, data.result.callId, output?.ok !== false);
    },
    async "message.completed"(data, channel) {
      const at = parseAddress(channel.continuation?.token);
      if (at && data.finishReason === "stop") await store.patchWatch(at.agentId, at.escrow, { lastSummary: data.message });
    },
    async "turn.completed"(_data, channel) {
      const at = parseAddress(channel.continuation?.token);
      if (at) await turnEnded(at.agentId, at.escrow);
    },
    async "turn.failed"(_data, channel) {
      const at = parseAddress(channel.continuation?.token);
      if (at) await turnEnded(at.agentId, at.escrow);
    },
    async "turn.cancelled"(_data, channel) {
      const at = parseAddress(channel.continuation?.token);
      if (at) await turnEnded(at.agentId, at.escrow);
    },
  },

  routes: [
    POST("/agents", async (request) => {
      if (!canManage(request)) return problem(401, "UNAUTHORIZED", "Creating agents needs the factory token.");
      const parsed = createAgentInput.safeParse(await request.json().catch(() => undefined));
      if (!parsed.success) {
        return json({ code: "VALIDATION_ERROR", detail: "Invalid agent.", errors: parsed.error.issues }, 400);
      }
      try {
        const agent = await createAgent(parsed.data);
        return json({ agent: publicAgent(agent) }, 201);
      } catch (error) {
        return problem(502, "AGENT_WALLET_FAILED", `The agent's wallet could not be set up: ${(error as Error).message}`);
      }
    }),

    /** Active agents; `?includeDeleted=true` adds the deleted ones, for the history of past escrows. */
    GET("/agents", async (request) => {
      const includeDeleted = new URL(request.url).searchParams.get("includeDeleted") === "true";
      const working = (await store.listWatches({ status: "open" })).filter((watch) => watch.working);
      return json({
        agents: (await store.listAgents({ includeDeleted })).map((agent) => ({
          ...publicAgent(agent),
          workingOn: working.filter((watch) => watch.agentId === agent.id).map((watch) => watch.escrow),
        })),
      });
    }),

    GET("/agents/:id", async (_request, { params }) => {
      const agent = await store.getAgent(params.id ?? "");
      if (!agent) return problem(404, "AGENT_NOT_FOUND", "No agent with that id.");
      return json({
        agent: publicAgent(agent),
        escrows: await store.listWatches({ agentId: agent.id }),
        decisions: await store.listDecisions(agent.id),
      });
    }),

    PATCH("/agents/:id", async (request, { params }) => {
      if (!canManage(request)) return problem(401, "UNAUTHORIZED", "Editing agents needs the factory token.");
      if (!(await store.getAgent(params.id ?? ""))) return problem(404, "AGENT_NOT_FOUND", "No agent with that id.");
      const parsed = updateAgentInput.safeParse(await request.json().catch(() => undefined));
      if (!parsed.success) {
        return json({ code: "VALIDATION_ERROR", detail: "Invalid change.", errors: parsed.error.issues }, 400);
      }
      try {
        const { agent, changed } = await updateAgent(params.id ?? "", parsed.data);
        return json({ agent: publicAgent(agent), changed });
      } catch (error) {
        if (error instanceof AgentGoneError) return problem(410, "AGENT_DELETED", error.message);
        throw error;
      }
    }),

    DELETE("/agents/:id", async (request, { params }) => {
      if (!canManage(request)) return problem(401, "UNAUTHORIZED", "Deleting agents needs the factory token.");
      if (!(await store.getAgent(params.id ?? ""))) return problem(404, "AGENT_NOT_FOUND", "No agent with that id.");
      try {
        return json({ agent: publicAgent(await deleteAgent(params.id ?? "")) });
      } catch (error) {
        if (error instanceof AgentBusyError) {
          return json({ code: "AGENT_HAS_OPEN_ESCROWS", detail: error.message, escrows: error.escrows }, 409);
        }
        if (error instanceof AgentGoneError) return problem(410, "AGENT_DELETED", error.message);
        throw error;
      }
    }),

    POST("/agents/:id/escrows", async (request, { params }) => {
      const agent = await store.getAgent(params.id ?? "");
      if (!agent) return problem(404, "AGENT_NOT_FOUND", "No agent with that id.");
      if (agent.deletedAt) return problem(410, "AGENT_DELETED", "This agent was deleted.");
      const body = (await request.json().catch(() => ({}))) as { escrow?: string };
      if (!body.escrow || !isAddress(body.escrow)) return problem(400, "BAD_ESCROW", "Send { \"escrow\": \"0x…\" }.");
      try {
        const result = await attachEscrow(agent, getAddress(body.escrow));
        return result.attached ? json(result, 201) : problem(409, "ESCROW_NOT_ATTACHED", result.reason ?? "Not attached.");
      } catch (error) {
        if (error instanceof TwApiError) return problem(error.status === 404 ? 404 : 502, error.code, error.detail);
        throw error;
      }
    }),

    /** An escrow as this agent sees it: the agent's own get_escrow tool, run as the agent, without a model. */
    GET("/agents/:id/escrows/:escrow", async (_request, { params, invokeTool }) => {
      const agent = await store.getAgent(params.id ?? "");
      if (!agent) return problem(404, "AGENT_NOT_FOUND", "No agent with that id.");
      if (agent.deletedAt) return problem(410, "AGENT_DELETED", "This agent was deleted.");
      const result = await invokeTool("get_escrow", { escrow: params.escrow }, { auth: agentPrincipal(agent) });
      return result.status === "completed" ? json(result.output) : problem(502, "TOOL_FAILED", JSON.stringify(result));
    }),

    /** Runs the dispatcher now for one agent, instead of waiting for the next minute. */
    POST("/agents/:id/check", async (_request, { params, from }) => {
      const agent = await store.getAgent(params.id ?? "");
      if (!agent) return problem(404, "AGENT_NOT_FOUND", "No agent with that id.");
      if (agent.deletedAt) return problem(410, "AGENT_DELETED", "This agent was deleted.");
      const deliver: Deliver = (target, message, auth) =>
        from(sessionAddress(target)).send(message, { auth, idempotencyKey: target.key });
      return json(await dispatchWork(deliver, { agentId: agent.id, force: true }));
    }),
  ],
});
