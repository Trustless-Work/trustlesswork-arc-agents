import { readFileSync } from "node:fs";

/** Reads configuration lazily, at call time, so a missing value fails the action that needs it and nothing else. */

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string, hint: string): string {
  const value = optional(name);
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

export function twApiUrl(): string {
  return required("TW_API_URL", "Set it to the Trustless Work API for Arc.").replace(/\/+$/, "");
}

let cachedKey: string | undefined;

/** The Trustless Work API key, from TW_API_KEY_FILE or TW_API_KEY. Empty when the API needs none. */
export function twApiKey(): string {
  if (cachedKey !== undefined) return cachedKey;
  const file = optional("TW_API_KEY_FILE");
  cachedKey = file ? readFileSync(file, "utf8").trim() : (optional("TW_API_KEY") ?? "");
  return cachedKey;
}

export function arcRpcUrl(): string {
  return optional("ARC_RPC_URL") ?? "https://rpc.testnet.arc.io";
}

export function circleCredentials(): { apiKey: string; entitySecret: string } {
  const hint = "Agents sign with Circle developer-controlled wallets; see README.md.";
  return {
    apiKey: required("CIRCLE_API_KEY", hint),
    entitySecret: required("CIRCLE_ENTITY_SECRET", hint),
  };
}

export function circleWalletSetId(): string | undefined {
  return optional("CIRCLE_WALLET_SET_ID");
}

export function dataDir(): string {
  return optional("AGENTS_DATA_DIR") ?? ".data";
}

export function agentFactoryToken(): string | undefined {
  return optional("AGENT_FACTORY_TOKEN");
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
