import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

/**
 * These agents have no shell and no file tools, so this only holds their skill. A pure-JavaScript one is enough, and it
 * needs no container, no VM and no paid sandbox service, wherever the service runs.
 */
export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
