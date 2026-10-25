import { defineSchedule } from "eve/schedules";

import agents from "../channels/agents";
import { dispatchWork } from "../lib/dispatch";

/** Every minute: find new escrows that name an agent, and wake each agent that has something to do. */
export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(
      dispatchWork((target, message, auth) => to(agents, target).send(message, { auth })).then((report) => {
        if (report.woken.length || report.errors.length) console.log("dispatch", JSON.stringify(report));
      }),
    );
  },
});
