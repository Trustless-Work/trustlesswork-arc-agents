import { twApiKey, twApiUrl } from "./config";
import type { EscrowView } from "./escrow";
import type { EscrowKind } from "./network";

/** An error answer from the Trustless Work API, with its stable `code`. */
export class TwApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = twApiKey();
  if (key) headers["x-api-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${twApiUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && attempt < 3) {
      const wait = Number(response.headers.get("retry-after") ?? "5");
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 30) * 1000));
      continue;
    }
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      throw new TwApiError(
        response.status,
        String(json.code ?? `HTTP_${response.status}`),
        String(json.detail ?? json.title ?? json.message ?? text.slice(0, 300)),
      );
    }
    return json as T;
  }
}

/** Reads an escrow. Without `kind`, tries single-release first, then multi-release. */
export async function getEscrow(address: string, kind?: EscrowKind): Promise<EscrowView> {
  if (kind) return call<EscrowView>("GET", `/escrow/${kind}/v2/${address}`);
  try {
    return await call<EscrowView>("GET", `/escrow/single-release/v2/${address}`);
  } catch (error) {
    if (error instanceof TwApiError && error.status === 404) {
      return call<EscrowView>("GET", `/escrow/multi-release/v2/${address}`);
    }
    throw error;
  }
}

export interface BuiltTransaction {
  to: `0x${string}`;
  data: `0x${string}`;
}

/** Builds (and simulates) an escrow call. The result is unsigned; the caller checks it against the chain. */
export async function buildEscrowCall(kind: EscrowKind, route: string, body: Record<string, unknown>): Promise<BuiltTransaction> {
  const result = await call<{ transaction?: { to?: string; data?: string } }>(
    "POST",
    `/escrow/${kind}/v2/${route}`,
    body,
  );
  const to = result.transaction?.to;
  const data = result.transaction?.data;
  if (!to || !data || !/^0x[0-9a-fA-F]*$/.test(data) || data.length % 2 !== 0) {
    throw new TwApiError(502, "BUILD_MALFORMED", "The API answered without a valid transaction.");
  }
  return { to: to as `0x${string}`, data: data as `0x${string}` };
}
