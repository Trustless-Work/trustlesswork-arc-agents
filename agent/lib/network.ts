import { parseAbi } from "viem";

/** Arc testnet and the official Trustless Work contracts. These are the source of truth, not the API. */
export const ARC_TESTNET = {
  chainId: 5042002,
  circleBlockchain: "ARC-TESTNET",
  explorer: "https://explorer.testnet.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
} as const;

export type EscrowKind = "single-release" | "multi-release";

export const FACTORIES: Record<EscrowKind, `0x${string}`> = {
  "single-release": "0x829fE7040797Df140636901e79F1bA448B7e9ae0",
  "multi-release": "0x7B04302DCEC430D74e8e38B35Cef96EbaD51b7fC",
};

export const IMPLEMENTATIONS: Record<EscrowKind, `0x${string}`> = {
  "single-release": "0x1F0E0C5b704B3e10609Bf4862071Db815a0c839b",
  "multi-release": "0xF7fBE8aca4D4A2A7552167246Df439931da26A5A",
};

/** topic0 of the factories' EscrowCreated event; topic1 is the escrow, topic2 the deployer. */
export const ESCROW_CREATED_TOPIC = "0x6e235dc8d7bb9d0676726c636a9423d8a06a9948a695ffc1e48550812a7ad8ad";

/** Escrow events the agents read: who funded it and who opened each dispute (topic2 is that address). */
export const ESCROW_EVENT_TOPICS = {
  funded: "0x006d268809962dd9189e3397ca104a8badcff21cf02a88952e7b9209a9506952",
  disputedSingle: "0x5f610a9f802495e3f111f40e1eeee03788ef757060d842b50a0e0148b3da3131",
  disputedMulti: "0x8e7959eaaab499e7d93f7f1c5ba2b73f4489dbb0b1b40e0f28ade7f1384c7a0d",
} as const;

/** Runtime code of an EIP-1167 clone of `implementation`. Only the official factory can initialize one. */
export function cloneCode(implementation: string): string {
  return `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

/** The escrow calls an agent may sign. */
export const ESCROW_ABI = parseAbi([
  "function approveMilestones(uint32[] milestoneIndices)",
  "function approveAndReleaseMilestones(uint32[] milestoneIndices)",
  "function releaseFunds()",
  "function releaseFunds(uint32[] milestoneIndices)",
  "function disputeEscrow(string reason)",
  "function disputeMilestones(uint32[] milestoneIndices, string reason)",
  "function changeMilestoneStatus((uint32 milestoneIndex, string newStatus, bool setEvidence, string newEvidence)[] updates)",
  "function resolveDispute(address[] recipients, uint256[] amounts)",
  "function resolveDispute(uint32[] milestoneIndices, address[] recipients, uint256[] amounts)",
  "function withdrawRemainingFunds(address[] recipients, uint256[] amounts)",
]);

export function explorerTx(txHash: string): string {
  return `${ARC_TESTNET.explorer}/tx/${txHash}`;
}

export function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/** 0x1234…abcd */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
