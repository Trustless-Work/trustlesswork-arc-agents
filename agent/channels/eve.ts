import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * The default chat API, open only on a local dev server. In production nobody can talk to the agents: they only get
 * work from the dispatcher (agent/schedules/dispatch.ts).
 */
export default eveChannel({
  auth: [localDev()],
});
