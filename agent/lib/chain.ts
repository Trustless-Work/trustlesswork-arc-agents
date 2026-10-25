import { createPublicClient, defineChain, getAddress, http, toHex, type PublicClient } from "viem";

import { arcRpcUrl } from "./config";
import {
  ARC_TESTNET,
  cloneCode,
  ESCROW_CREATED_TOPIC,
  ESCROW_EVENT_TOPICS,
  FACTORIES,
  IMPLEMENTATIONS,
  sameAddress,
  type EscrowKind,
} from "./network";

let client: PublicClient | undefined;

function arc(): PublicClient {
  client ??= createPublicClient({
    chain: defineChain({
      id: ARC_TESTNET.chainId,
      name: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [arcRpcUrl()] } },
    }),
    transport: http(arcRpcUrl(), { retryCount: 3, retryDelay: 1_000 }),
  });
  return client;
}

/** True when `address` is a clone of the official implementation of `kind`, so the official factory created it. */
export async function isOfficialEscrow(address: `0x${string}`, kind: EscrowKind): Promise<boolean> {
  const code = await arc().getCode({ address });
  return (code ?? "0x").toLowerCase() === cloneCode(IMPLEMENTATIONS[kind]);
}

export async function latestBlock(): Promise<bigint> {
  return arc().getBlockNumber();
}

export interface EscrowHistory {
  /** Every address that funded the escrow, oldest first. */
  funders: `0x${string}`[];
  /** Who opened each dispute, oldest first. */
  disputedBy: `0x${string}`[];
  /** First block scanned; older events are not in the lists. */
  fromBlock: bigint;
}

/**
 * Who funded the escrow and who disputed it, from its own events. Scans back from the latest block in 9,999-block
 * chunks to `fromBlock` (its creation, when known), or about a day otherwise.
 */
export async function escrowHistory(address: `0x${string}`, fromBlock?: bigint): Promise<EscrowHistory> {
  const latest = await latestBlock();
  const chunk = 9_999n;
  const floor = fromBlock ?? (latest > chunk * 20n ? latest - chunk * 20n : 0n);
  const funders: `0x${string}`[] = [];
  const disputedBy: `0x${string}`[] = [];
  for (let to = latest; to >= floor; to -= chunk) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    const logs = (await arc().request({
      method: "eth_getLogs",
      params: [
        {
          address,
          fromBlock: toHex(from),
          toBlock: toHex(to),
          topics: [[ESCROW_EVENT_TOPICS.funded, ESCROW_EVENT_TOPICS.disputedSingle, ESCROW_EVENT_TOPICS.disputedMulti]],
        },
      ],
    })) as { topics: string[]; blockNumber: string; logIndex: string }[];
    // Newest chunk first, so prepend each chunk to keep the lists oldest first.
    const sorted = logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    const chunkFunders: `0x${string}`[] = [];
    const chunkDisputers: `0x${string}`[] = [];
    for (const log of sorted) {
      const who = log.topics[2];
      if (!who) continue;
      const address = getAddress(`0x${who.slice(26)}`);
      (log.topics[0] === ESCROW_EVENT_TOPICS.funded ? chunkFunders : chunkDisputers).push(address);
    }
    funders.unshift(...chunkFunders);
    disputedBy.unshift(...chunkDisputers);
    if (from === floor) break;
  }
  return { funders: [...new Set(funders)], disputedBy, fromBlock: floor };
}

export interface CreatedEscrow {
  escrow: `0x${string}`;
  deployer: `0x${string}`;
  kind: EscrowKind;
  blockNumber: bigint;
}

/** EscrowCreated events of both official factories in [fromBlock, toBlock] (at most 9,999 blocks). */
export async function escrowsCreated(fromBlock: bigint, toBlock: bigint): Promise<CreatedEscrow[]> {
  const logs = (await arc().request({
    method: "eth_getLogs",
    params: [
      {
        address: [FACTORIES["single-release"], FACTORIES["multi-release"]],
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
        topics: [ESCROW_CREATED_TOPIC],
      },
    ],
  })) as { address: string; topics: string[]; blockNumber: string }[];

  return logs.flatMap((log) => {
    const [, escrowTopic, deployerTopic] = log.topics;
    if (!escrowTopic || !deployerTopic) return [];
    const kind = sameAddress(log.address, FACTORIES["single-release"]) ? "single-release" : "multi-release";
    return [
      {
        escrow: getAddress(`0x${escrowTopic.slice(26)}`),
        deployer: getAddress(`0x${deployerTopic.slice(26)}`),
        kind,
        blockNumber: BigInt(log.blockNumber),
      },
    ];
  });
}
