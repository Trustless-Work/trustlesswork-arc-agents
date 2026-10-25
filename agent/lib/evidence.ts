import { createHash } from "node:crypto";
import { isIP } from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 60_000;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (!isIP(host)) return false;
  return (
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80")
  );
}

export interface FetchedEvidence {
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
  text: string;
}

/** Downloads a delivery's evidence and hashes it, so the agent can compare it with a `sha256:` in the evidence. */
export async function fetchEvidence(rawUrl: string): Promise<FetchedEvidence> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Only https links can be opened.");
  if (isPrivateHost(url.hostname)) throw new Error("Links to private or local hosts are not opened.");

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "TrustlessWorkAgent/0.1 (+https://trustlesswork.com)" },
  });
  if (response.url && isPrivateHost(new URL(response.url).hostname)) {
    throw new Error("The link redirected to a private or local host.");
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MAX_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const body = Buffer.concat(chunks);
  const text = body.toString("utf8");
  return {
    url: response.url || url.toString(),
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bytes: size,
    sha256: truncated ? "" : createHash("sha256").update(body).digest("hex"),
    truncated: truncated || text.length > MAX_TEXT,
    text: text.slice(0, MAX_TEXT),
  };
}
