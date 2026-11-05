import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { twApiUrl } from "../agent/lib/config";

describe("twApiUrl", () => {
  const original = process.env.TW_API_URL;
  afterEach(() => {
    process.env.TW_API_URL = original;
  });

  it("accepts a testnet URL, with or without a trailing slash", () => {
    process.env.TW_API_URL = "https://api.example.com/testnet/";
    expect(twApiUrl()).toBe("https://api.example.com/testnet");
  });

  it("refuses mainnet and a URL without a network, because the agents only work on testnet", () => {
    process.env.TW_API_URL = "https://api.example.com/mainnet";
    expect(() => twApiUrl()).toThrow("must end with /testnet");
    process.env.TW_API_URL = "https://api.example.com";
    expect(() => twApiUrl()).toThrow("must end with /testnet");
  });
});

describe("npm run dev", () => {
  it("keeps eve's self-modification extension away from the agents", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: { dev: string } };
    expect(scripts.dev).toContain("--no-default-extensions");
  });
});
