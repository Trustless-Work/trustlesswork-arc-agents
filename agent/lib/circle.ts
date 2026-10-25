import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";

import { circleCredentials, circleWalletSetId } from "./config";
import { ARC_TESTNET } from "./network";
import { store } from "./store";

let client: CircleDeveloperControlledWalletsClient | undefined;

function circle(): CircleDeveloperControlledWalletsClient {
  client ??= initiateDeveloperControlledWalletsClient(circleCredentials());
  return client;
}

export interface AgentWallet {
  walletId: string;
  address: `0x${string}`;
  accountType: string;
}

/** The wallet set agent wallets go into: CIRCLE_WALLET_SET_ID, or one created on first use and remembered. */
async function walletSetId(): Promise<string> {
  const configured = circleWalletSetId() ?? (await store.getWalletSetId());
  if (configured) return configured;
  const response = await circle().createWalletSet({ name: "Trustless Work agents" });
  const id = response.data?.walletSet?.id;
  if (!id) throw new Error("Circle did not return a wallet set.");
  await store.setWalletSetId(id);
  return id;
}

/**
 * A new smart contract account on Arc testnet for one agent. On testnet, Circle's Gas Station sponsors the gas of
 * SCA wallets, so the wallet needs no USDC to approve, release or dispute.
 */
/** Circle rejects wallet names with punctuation such as parentheses ("API parameter invalid"). */
export function walletName(agentName: string): string {
  const cleaned = agentName.replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 50).trim();
  return cleaned || "Trustless Work agent";
}

export async function createAgentWallet(agentId: string, name: string): Promise<AgentWallet> {
  const response = await circle().createWallets({
    walletSetId: await walletSetId(),
    blockchains: [ARC_TESTNET.circleBlockchain],
    count: 1,
    accountType: "SCA",
    metadata: [{ name: walletName(name), refId: agentId }],
  });
  const wallet = response.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) throw new Error("Circle did not return the new wallet.");
  return { walletId: wallet.id, address: wallet.address as `0x${string}`, accountType: wallet.accountType ?? "SCA" };
}

/** An existing wallet of this Circle account, assigned to the agent. It must live on Arc testnet. */
export async function getAssignedWallet(walletId: string): Promise<AgentWallet> {
  const response = await circle().getWallet({ id: walletId });
  const wallet = response.data?.wallet;
  if (!wallet?.address) throw new Error(`Circle has no wallet ${walletId} in this account.`);
  if (wallet.blockchain !== ARC_TESTNET.circleBlockchain) {
    throw new Error(`Wallet ${walletId} is on ${wallet.blockchain}, not ${ARC_TESTNET.circleBlockchain}.`);
  }
  if (wallet.state && wallet.state !== "LIVE") throw new Error(`Wallet ${walletId} is ${wallet.state}.`);
  return { walletId: wallet.id, address: wallet.address as `0x${string}`, accountType: wallet.accountType ?? "EOA" };
}

export interface SentCall {
  circleTransactionId: string;
  txHash: string;
  state: string;
}

/** Signs and sends one contract call from the agent's wallet, then waits until Circle reports it complete. */
export async function sendContractCall(walletId: string, to: `0x${string}`, data: `0x${string}`): Promise<SentCall> {
  const created = await circle().createContractExecutionTransaction({
    walletId,
    contractAddress: to,
    callData: data,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const id = created.data?.id;
  if (!id) throw new Error("Circle did not accept the transaction.");

  const done = await circle().getTransaction({
    id,
    waitForState: "COMPLETE",
    pollingInterval: 2_000,
    signal: AbortSignal.timeout(180_000),
  });
  const transaction = done.data?.transaction;
  if (!transaction?.txHash) throw new Error(`Circle transaction ${id} has no hash (state ${transaction?.state}).`);
  return { circleTransactionId: id, txHash: transaction.txHash, state: transaction.state ?? "COMPLETE" };
}
