/**
 * Creates the Circle entity secret for this deployment, registers it with Circle and saves it in .env.local.
 * Run it once, yourself: it needs CIRCLE_API_KEY in .env.local and never prints the secret.
 *
 *   npm run circle:entity-secret
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";

import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const ENV_FILE = ".env.local";
const RECOVERY_DIR = ".data/circle-recovery";

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const apiKey = process.env.CIRCLE_API_KEY?.trim();
if (!apiKey) {
  console.error(`Set CIRCLE_API_KEY in ${ENV_FILE} first (a testnet key from console.circle.com).`);
  process.exit(1);
}
if (process.env.CIRCLE_ENTITY_SECRET?.trim()) {
  console.error(`CIRCLE_ENTITY_SECRET is already set in ${ENV_FILE}. Registering a new one would replace it.`);
  process.exit(1);
}

const entitySecret = randomBytes(32).toString("hex");
mkdirSync(RECOVERY_DIR, { recursive: true });
await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: RECOVERY_DIR });

appendFileSync(ENV_FILE, `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`, { mode: 0o600 });
chmodSync(ENV_FILE, 0o600);
console.log(`Entity secret registered and saved in ${ENV_FILE}.`);
console.log(`Circle's recovery file is in ${RECOVERY_DIR}/. Keep a copy somewhere safe: it is the only way to reset the secret.`);
