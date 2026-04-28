#!/usr/bin/env bun

import { Command } from "commander";
import {
  AnchorMode,
  PostConditionMode,
  Pc,
  broadcastTransaction,
  bufferCV,
  contractPrincipalCV,
  cvToJSON,
  fetchCallReadOnlyFunction,
  listCV,
  makeContractCall,
  noneCV,
  principalCV,
  someCV,
  uintCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { getAddressFromPrivateKey } from "@stacks/transactions";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";
type CycleStep =
  | "idle"
  | "borrow_planned"
  | "borrow_broadcast"
  | "borrow_confirmed"
  | "swap_planned"
  | "swap_broadcast"
  | "swap_confirmed"
  | "resupply_planned"
  | "resupply_broadcast"
  | "complete"
  | "blocked_partial_cycle"
  | "operator_cancelled";

interface SharedOptions {
  wallet: string;
  borrowAmountUstx?: string;
  slippageBps?: string;
  maxQuoteStalenessSeconds?: string;
  maxPriceImpactBps?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  waitSeconds?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
  feeUstx?: string;
}

interface SessionFile {
  version: number;
  expiresAt?: string;
  encrypted: { ciphertext: string; iv: string; authTag: string };
}

interface Checkpoint {
  cycleId: string;
  wallet: string;
  step: CycleStep;
  requestedBorrowAmountUstx: string;
  createdAt: string;
  updatedAt: string;
  borrowTxid?: string;
  swapTxid?: string;
  resupplyTxid?: string;
  swapEstimatedSbtc?: string;
  observedSbtcReceived?: string;
  resuppliedSbtc?: string;
  abortReason?: string;
  nextRequiredAction?: string;
}

const HIRO_API = "https://api.hiro.so";
const PYTH_HERMES_API = "https://hermes.pyth.network";
const EXPLORER = "https://explorer.hiro.so/txid";
const CONFIRM_TOKEN = "CYCLE";
const DEFAULT_FEE_USTX = 70_000n;
const DEFAULT_MIN_GAS_RESERVE_USTX = 500_000n;
const DEFAULT_WAIT_SECONDS = 240;
const DEFAULT_SLIPPAGE_BPS = 150;
const DEFAULT_MAX_QUOTE_STALENESS_SECONDS = 30;
const DEFAULT_MAX_PRICE_IMPACT_BPS = 500;
const DEFAULT_MEMPOOL_DEPTH_LIMIT = 0;
const PYTH_MAX_FEE_USTX = 10n;
const MAX_MASK = 18_446_744_073_709_551_615n;

const MARKET = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market";
const MARKET_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-market-vault";
const ASSETS = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-assets";
const EGROUP = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-egroup";
const STX_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-stx";
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc";
const STX_TOKEN = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx";
const STX_PYTH_FEED = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";
const SBTC_PYTH_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

class BlockedError extends Error {
  constructor(
    public code: string,
    message: string,
    public next: string,
    public data: JsonMap = {}
  ) {
    super(message);
  }
}

function stringify(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, stringify(val)])) as JsonMap;
  }
  if (value === undefined) return null;
  return value as Json;
}

function output(status: Status, action: string, data: JsonMap, error: JsonMap | null): void {
  console.log(JSON.stringify({ status, action, data: stringify(data), error: stringify(error) }, null, 2));
}

function success(action: string, data: JsonMap): void {
  output("success", action, data, null);
}

function blocked(action: string, code: string, message: string, next: string, data: JsonMap = {}): void {
  output("blocked", action, data, { code, message, next });
}

function fail(action: string, error: unknown): void {
  if (error instanceof BlockedError) {
    blocked(action, error.code, error.message, error.next, error.data);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  output("error", action, {}, { code: "ERROR", message, next: "Run doctor/status and inspect the failing check before retrying." });
}

function parseContractId(contractId: string): { address: string; name: string } {
  const [address, name] = contractId.split(".");
  if (!address || !name) throw new Error(`Invalid contract id: ${contractId}`);
  return { address, name };
}

function parsePositiveBigInt(value: string | undefined, label: string): bigint {
  if (!value) throw new Error(`${label} is required`);
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer in base units`);
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${label} must be greater than 0`);
  return parsed;
}

function parseNonNegativeBigInt(value: string | undefined, fallback: bigint, label: string): bigint {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseBps(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseNonNegativeInteger(value, fallback, label);
  if (parsed > 10_000) throw new Error(`${label} must be <= 10000 bps`);
  return parsed;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${url}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

async function fetchContractInterface(contractId: string): Promise<{ functions?: Array<{ name: string; access: string }> }> {
  const { address, name } = parseContractId(contractId);
  return fetchJson(`${HIRO_API}/v2/contracts/interface/${address}/${name}?proof=0`);
}

async function callReadOnly(contractId: string, functionName: string, args: Parameters<typeof fetchCallReadOnlyFunction>[0]["functionArgs"], sender: string) {
  const { address, name } = parseContractId(contractId);
  const cv = await fetchCallReadOnlyFunction({
    network: STACKS_MAINNET,
    contractAddress: address,
    contractName: name,
    functionName,
    functionArgs: args,
    senderAddress: sender,
  });
  return cvToJSON(cv);
}

function cvUint(value: any): bigint {
  if (value?.success === false) throw new Error(`Read-only call failed: ${JSON.stringify(value)}`);
  const raw = value?.value?.value ?? value?.value;
  if (typeof raw === "string") return BigInt(raw);
  if (typeof raw === "number") return BigInt(raw);
  throw new Error(`Expected uint CV JSON, got ${JSON.stringify(value)}`);
}

function cvOkUint(value: any): bigint {
  if (!value?.success) throw new Error(`Read-only response failed: ${JSON.stringify(value)}`);
  return cvUint(value.value);
}

function okValue(value: any): any {
  if (value?.success === false) return null;
  return value?.value?.value ?? value?.value ?? value;
}

function parseListEntries(value: unknown): JsonMap[] {
  if (!value || typeof value !== "object" || !("value" in value)) return [];
  const first = (value as { value: unknown }).value;
  const list = first && typeof first === "object" && "value" in first ? (first as { value: unknown }).value : first;
  return Array.isArray(list) ? list.map((entry) => (entry && typeof entry === "object" && "value" in entry ? (entry as { value: JsonMap }).value : entry as JsonMap)) : [];
}

async function getStxAvailable(wallet: string): Promise<bigint> {
  const response = await fetchJson<{ balance: string; locked: string }>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  return BigInt(response.balance) - BigInt(response.locked);
}

async function getPendingDepth(wallet: string): Promise<number> {
  const response = await fetchJson<{ total?: number; results?: unknown[] }>(`${HIRO_API}/extended/v1/tx/mempool?sender_address=${wallet}&limit=20`);
  return Number(response.total ?? response.results?.length ?? 0);
}

async function getFtBalance(wallet: string, contractId: string, functionName = "get-balance"): Promise<bigint> {
  return cvOkUint(await callReadOnly(contractId, functionName, [principalCV(wallet)], wallet));
}

async function getPosition(wallet: string): Promise<JsonMap> {
  return callReadOnly(MARKET_VAULT, "get-position", [principalCV(wallet), uintCV(MAX_MASK)], wallet) as Promise<JsonMap>;
}

function findPositionAmount(position: JsonMap, kind: "collateral" | "debt", assetId: bigint): bigint {
  const value = okValue(position);
  if (!value || typeof value !== "object") return 0n;
  for (const entry of parseListEntries(value[kind])) {
    const aid = BigInt(String((entry.aid as JsonMap)?.value ?? "0"));
    if (aid === assetId) return BigInt(String(((kind === "collateral" ? entry.amount : entry.scaled) as JsonMap)?.value ?? "0"));
  }
  return 0n;
}

function getMask(position: JsonMap): bigint {
  const value = okValue(position);
  if (!value || typeof value !== "object") return 0n;
  return BigInt(String((value.mask as JsonMap)?.value ?? "0"));
}

async function fetchPythPriceFeedBytes(feeds: string[]): Promise<{ bytes: Buffer; feeds: string[] }> {
  const uniqueFeeds = [...new Set(feeds.filter(Boolean))];
  if (uniqueFeeds.length === 0) return { bytes: Buffer.alloc(0), feeds: uniqueFeeds };
  const params = new URLSearchParams();
  params.set("encoding", "hex");
  for (const feed of uniqueFeeds) params.append("ids[]", feed);
  const payload = await fetchJson<{ binary?: { encoding?: string; data?: string[] } }>(`${PYTH_HERMES_API}/v2/updates/price/latest?${params.toString()}`);
  const hex = payload.binary?.data?.[0];
  if (!hex || payload.binary?.encoding !== "hex") throw new Error("Pyth Hermes did not return hex update bytes");
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0 || bytes.length > 8192) throw new Error(`Pyth update length ${bytes.length} is outside the V2 market limit`);
  return { bytes, feeds: uniqueFeeds };
}

function buildPriceFeeds(bytes: Buffer) {
  return bytes.length > 0 ? someCV(listCV([bufferCV(bytes)])) : noneCV();
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(stringify(data), null, 2)}\n`, "utf8");
}

function aibtcPath(...parts: string[]): string {
  return path.join(os.homedir(), ".aibtc", ...parts);
}

function checkpointPath(wallet: string): string {
  return aibtcPath("state", "bitflow-zest-sbtc-leverage-cycle", `${wallet}.json`);
}

async function readCheckpoint(wallet: string): Promise<Checkpoint | null> {
  return readJsonFile<Checkpoint>(checkpointPath(wallet));
}

async function writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
  checkpoint.updatedAt = new Date().toISOString();
  await writeJsonFile(checkpointPath(checkpoint.wallet), checkpoint);
}

async function decryptSessionAccount(walletId: string): Promise<{ address: string; privateKey: string } | null> {
  const session = await readJsonFile<SessionFile>(aibtcPath("sessions", `${path.basename(walletId)}.json`));
  if (!session || session.version !== 1) return null;
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) return null;
  const sessionKey = await fs.readFile(aibtcPath("sessions", ".session-key")).catch(() => null);
  if (!sessionKey || sessionKey.length !== 32) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(session.encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(session.encrypted.authTag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(session.encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8"));
}

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = crypto.scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
}

async function decryptKeystoreAccount(walletId: string, password: string): Promise<{ address: string; privateKey: string } | null> {
  const keystore = await readJsonFile<any>(aibtcPath("wallets", path.basename(walletId), "keystore.json"));
  if (!keystore) return null;
  let mnemonic: string | null = null;
  if (keystore.encrypted?.ciphertext) {
    mnemonic = await decryptAibtcKeystore(keystore.encrypted, password);
  } else {
    const legacy = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
    if (legacy) {
      const { decryptMnemonic } = await import("@stacks/encryption" as any);
      mnemonic = await decryptMnemonic(legacy, password);
    }
  }
  if (!mnemonic) return null;
  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
  return { privateKey: account.stxPrivateKey, address: getStxAddress(account) };
}

async function resolveSigner(expectedWallet: string): Promise<{ privateKey: string; address: string; source: string }> {
  const attempts: string[] = [];
  const config = await readJsonFile<{ activeWalletId?: string }>(aibtcPath("config.json"));
  const walletId = process.env.AIBTC_WALLET_ID || config?.activeWalletId;
  if (walletId) {
    try {
      const account = await decryptSessionAccount(walletId);
      if (account?.privateKey) {
        if (account.address !== expectedWallet) throw new Error(`session resolves to ${account.address}, expected ${expectedWallet}`);
        return { privateKey: account.privateKey, address: account.address, source: "AIBTC_SESSION_FILE" };
      }
      attempts.push("AIBTC_SESSION_FILE: no active unexpired session");
    } catch (error) {
      attempts.push(`AIBTC_SESSION_FILE: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    attempts.push("AIBTC_SESSION_FILE: no active wallet id");
  }
  const password = process.env.AIBTC_WALLET_PASSWORD?.trim();
  if (walletId && password) {
    try {
      const account = await decryptKeystoreAccount(walletId, password);
      if (account?.privateKey) {
        if (account.address !== expectedWallet) throw new Error(`keystore resolves to ${account.address}, expected ${expectedWallet}`);
        return { privateKey: account.privateKey, address: account.address, source: "AIBTC_KEYSTORE" };
      }
      attempts.push("AIBTC_KEYSTORE: no decryptable keystore");
    } catch (error) {
      attempts.push(`AIBTC_KEYSTORE: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    attempts.push("AIBTC_KEYSTORE: AIBTC_WALLET_PASSWORD or wallet id not set");
  }
  const privateKey = process.env.STACKS_PRIVATE_KEY?.trim();
  if (privateKey) {
    const address = getAddressFromPrivateKey(privateKey, "mainnet");
    if (address !== expectedWallet) throw new Error(`STACKS_PRIVATE_KEY resolves to ${address}, expected ${expectedWallet}`);
    return { privateKey, address, source: "STACKS_PRIVATE_KEY" };
  }
  attempts.push("STACKS_PRIVATE_KEY: not set");
  throw new Error(`Could not resolve signer. ${attempts.join("; ")}`);
}

async function waitForTx(txid: string, waitSeconds: number): Promise<JsonMap | null> {
  const deadline = Date.now() + waitSeconds * 1000;
  let last: JsonMap | null = null;
  while (Date.now() <= deadline) {
    try {
      const tx = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/tx/${txid}`);
      last = tx;
      const status = String(tx.tx_status ?? "");
      if (status === "success" || status === "failed" || status.startsWith("abort")) return tx;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("HTTP 404 ")) throw error;
      last = { tx_status: "not_indexed", tx_id: txid };
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return last;
}

async function checkContracts(wallet: string): Promise<JsonMap> {
  const [marketInterface, marketVaultInterface, sbtcVaultInterface] = await Promise.all([
    fetchContractInterface(MARKET),
    fetchContractInterface(MARKET_VAULT),
    fetchContractInterface(SBTC_VAULT),
  ]);
  const hasBorrow = marketInterface.functions?.some((fn) => fn.name === "borrow" && fn.access === "public");
  const hasSupply = marketInterface.functions?.some((fn) => fn.name === "supply-collateral-add" && fn.access === "public");
  const hasPosition = marketVaultInterface.functions?.some((fn) => fn.name === "get-position");
  const hasShares = sbtcVaultInterface.functions?.some((fn) => fn.name === "convert-to-shares");
  if (!hasBorrow || !hasSupply || !hasPosition || !hasShares) {
    throw new BlockedError("ZEST_ABI_MISSING", "One or more required Zest V2 functions is missing.", "Do not run until the live V2 ABI is verified.", { hasBorrow, hasSupply, hasPosition, hasShares });
  }
  await callReadOnly(EGROUP, "resolve", [uintCV(1n << 3n)], wallet);
  return {
    market: MARKET,
    marketVault: MARKET_VAULT,
    borrowFunction: "borrow",
    resupplyFunction: "supply-collateral-add",
    borrowPrimitive: "zest-borrow-asset-primitive",
    depositPrimitive: "zest-asset-deposit-primitive",
    swapSurface: "BitflowSDK.prepareSwap",
  };
}

async function collectContext(opts: SharedOptions, requireAmount: boolean) {
  if (process.env.NETWORK && process.env.NETWORK !== "mainnet") {
    throw new BlockedError("MAINNET_ONLY", "bitflow-zest-sbtc-leverage-cycle is mainnet-only.", "Set NETWORK=mainnet.");
  }
  if (!opts.wallet) throw new Error("--wallet is required");
  const borrowAmount = requireAmount ? parsePositiveBigInt(opts.borrowAmountUstx, "--borrow-amount-ustx") : (opts.borrowAmountUstx ? parsePositiveBigInt(opts.borrowAmountUstx, "--borrow-amount-ustx") : 0n);
  const minGasReserve = parseNonNegativeBigInt(opts.minGasReserveUstx, DEFAULT_MIN_GAS_RESERVE_USTX, "--min-gas-reserve-ustx");
  const mempoolDepthLimit = parseNonNegativeInteger(opts.mempoolDepthLimit, DEFAULT_MEMPOOL_DEPTH_LIMIT, "--mempool-depth-limit");
  const slippageBps = parseBps(opts.slippageBps, DEFAULT_SLIPPAGE_BPS, "--slippage-bps");
  const maxPriceImpactBps = parseBps(opts.maxPriceImpactBps, DEFAULT_MAX_PRICE_IMPACT_BPS, "--max-price-impact-bps");
  const maxQuoteStalenessSeconds = parseNonNegativeInteger(opts.maxQuoteStalenessSeconds, DEFAULT_MAX_QUOTE_STALENESS_SECONDS, "--max-quote-staleness-seconds");
  const [contracts, position, stxAvailable, pendingDepth, sbtcBalance, checkpoint] = await Promise.all([
    checkContracts(opts.wallet),
    getPosition(opts.wallet),
    getStxAvailable(opts.wallet),
    getPendingDepth(opts.wallet),
    getFtBalance(opts.wallet, SBTC_TOKEN),
    readCheckpoint(opts.wallet),
  ]);
  const sbtcCollateral = findPositionAmount(position, "collateral", 3n);
  const stxDebt = findPositionAmount(position, "debt", 0n);
  if (requireAmount && sbtcCollateral <= 0n) {
    throw new BlockedError("NO_SBTC_COLLATERAL", "Wallet has no tracked sBTC collateral in Zest V2.", "Deposit sBTC collateral before running a leverage cycle.", { sbtcCollateral });
  }
  if (stxAvailable < minGasReserve) {
    throw new BlockedError("INSUFFICIENT_GAS_RESERVE", `Need at least ${minGasReserve} uSTX available, found ${stxAvailable}.`, "Fund the wallet or lower the reserve only if safe.", { stxAvailable, minGasReserve });
  }
  return {
    wallet: opts.wallet,
    borrowAmount,
    minGasReserve,
    mempoolDepthLimit,
    slippageBps,
    maxPriceImpactBps,
    maxQuoteStalenessSeconds,
    contracts,
    position,
    mask: getMask(position),
    stxAvailable,
    pendingDepth,
    sbtcBalance,
    sbtcCollateral,
    stxDebt,
    checkpoint,
  };
}

function contextData(context: Awaited<ReturnType<typeof collectContext>>): JsonMap {
  return {
    network: "mainnet",
    wallet: context.wallet,
    contracts: context.contracts,
    position: {
      mask: context.mask,
      sbtcCollateral: context.sbtcCollateral,
      stxDebtScaled: context.stxDebt,
      walletSbtcBalance: context.sbtcBalance,
      walletStxAvailableUstx: context.stxAvailable,
    },
    requestedCycle: {
      borrowAmountUstx: context.borrowAmount,
      swap: "STX -> sBTC through Bitflow",
      resupply: "actual sBTC received -> Zest V2 collateral",
      slippageBps: context.slippageBps,
      maxPriceImpactBps: context.maxPriceImpactBps,
      maxQuoteStalenessSeconds: context.maxQuoteStalenessSeconds,
    },
    safety: {
      pendingDepth: context.pendingDepth,
      mempoolDepthLimit: context.mempoolDepthLimit,
      minGasReserveUstx: context.minGasReserve,
      postConditionMode: "deny",
      checkpointPath: checkpointPath(context.wallet),
      checkpoint: context.checkpoint,
    },
  };
}

async function ensureNoBlockingCheckpoint(wallet: string): Promise<void> {
  const checkpoint = await readCheckpoint(wallet);
  if (!checkpoint) return;
  if (checkpoint.step === "complete" || checkpoint.step === "operator_cancelled") return;
  throw new BlockedError("OPEN_CHECKPOINT", "An unresolved leverage-cycle checkpoint already exists.", "Run status, then resume or cancel the existing checkpoint before starting a new cycle.", { checkpoint });
}

async function ensurePendingDepth(wallet: string, limit: number): Promise<number> {
  const pendingDepth = await getPendingDepth(wallet);
  if (pendingDepth > limit) {
    throw new BlockedError("PENDING_TX_DEPTH", `Wallet has ${pendingDepth} pending transaction(s), limit is ${limit}.`, "Wait for pending transactions to confirm before continuing.", { pendingDepth, limit });
  }
  return pendingDepth;
}

async function buildBorrowTx(wallet: string, amount: bigint, privateKey: string, fee: bigint) {
  const market = parseContractId(MARKET);
  const token = parseContractId(STX_TOKEN);
  const { bytes, feeds } = await fetchPythPriceFeedBytes([STX_PYTH_FEED, SBTC_PYTH_FEED]);
  const postConditions = [
    Pc.principal(STX_VAULT).willSendLte(amount).ustx(),
    Pc.principal(wallet).willSendLte(PYTH_MAX_FEE_USTX).ustx(),
  ];
  const tx = await makeContractCall({
    contractAddress: market.address,
    contractName: market.name,
    functionName: "borrow",
    functionArgs: [
      contractPrincipalCV(token.address, token.name),
      uintCV(amount),
      someCV(principalCV(wallet)),
      buildPriceFeeds(bytes),
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
    postConditions,
    fee,
  });
  return { tx, postConditionCount: postConditions.length, priceFeedBytesLength: bytes.length, feeds };
}

async function broadcast(tx: Awaited<ReturnType<typeof makeContractCall>>): Promise<string> {
  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) throw new Error(`Broadcast failed: ${result.error}${"reason" in result ? ` - ${result.reason}` : ""}`);
  return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
}

async function getBitflowSDK(): Promise<any> {
  const { BitflowSDK } = await import("@bitflowlabs/core-sdk" as any);
  return new BitflowSDK({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST ?? "https://api.bitflowapis.finance",
    BITFLOW_API_KEY: process.env.BITFLOW_API_KEY ?? "",
    READONLY_CALL_API_HOST: HIRO_API,
    READONLY_CALL_API_KEY: process.env.READONLY_CALL_API_KEY ?? "",
    KEEPER_API_HOST: process.env.KEEPER_API_HOST ?? "https://api.bitflowapis.finance",
    KEEPER_API_URL: process.env.KEEPER_API_URL ?? "https://api.bitflowapis.finance",
    KEEPER_API_KEY: process.env.KEEPER_API_KEY ?? "",
    BITFLOW_PROVIDER_ADDRESS: process.env.BITFLOW_PROVIDER_ADDRESS ?? "",
  });
}

async function withMutedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function decimalFromAtomic(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function atomicFromDecimal(amount: number, decimals: number): bigint {
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)));
}

async function prepareSwap(wallet: string, privateKey: string, amountUstx: bigint, slippageBps: number, maxPriceImpactBps: number, fee: bigint) {
  const sdk = await getBitflowSDK();
  const tokens = await withMutedConsole(() => sdk.getAvailableTokens());
  const stxToken = tokens.find((token: any) => (token.symbol ?? "").toLowerCase() === "stx" || (token.tokenId ?? "").toLowerCase() === "token-stx");
  const sbtcToken = tokens.find((token: any) => (token.symbol ?? "").toLowerCase() === "sbtc" || (token.tokenId ?? "").toLowerCase().includes("sbtc"));
  if (!stxToken || !sbtcToken) throw new BlockedError("BITFLOW_TOKEN_NOT_FOUND", "Bitflow token list did not include STX and sBTC.", "Do not run until the Bitflow token surface is reachable.");
  const tokenInId = stxToken.tokenId ?? stxToken["token-id"];
  const tokenOutId = sbtcToken.tokenId ?? sbtcToken["token-id"];
  const tokenInDecimals = Number(stxToken.tokenDecimals ?? 6);
  const tokenOutDecimals = Number(sbtcToken.tokenDecimals ?? 8);
  const amountHuman = decimalFromAtomic(amountUstx, tokenInDecimals);
  const quotedAt = new Date().toISOString();
  const quote = await withMutedConsole(() => sdk.getQuoteForRoute(tokenInId, tokenOutId, amountHuman));
  if (!quote?.bestRoute?.route) throw new BlockedError("BITFLOW_NO_ROUTE", "Bitflow returned no STX -> sBTC route.", "Retry later or choose a different cycle size.");
  const priceImpactRaw = quote.bestRoute.priceImpact ?? null;
  const priceImpactBps = priceImpactRaw === null ? null : Math.round(Number(priceImpactRaw) * 100);
  if (priceImpactBps !== null && priceImpactBps > maxPriceImpactBps) {
    throw new BlockedError("PRICE_IMPACT_TOO_HIGH", "Bitflow quote price impact exceeds the configured limit.", "Lower --borrow-amount-ustx or raise --max-price-impact-bps only after reviewing risk.", { priceImpactBps, maxPriceImpactBps });
  }
  const swapParams = await withMutedConsole(() => sdk.prepareSwap({
    route: quote.bestRoute.route,
    amount: amountHuman,
    tokenXDecimals: tokenInDecimals,
    tokenYDecimals: tokenOutDecimals,
  }, wallet, slippageBps / 10_000));
  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress,
    contractName: swapParams.contractName,
    functionName: swapParams.functionName,
    functionArgs: swapParams.functionArgs,
    postConditions: swapParams.postConditions,
    postConditionMode: PostConditionMode.Deny,
    network: STACKS_MAINNET,
    senderKey: privateKey,
    anchorMode: AnchorMode.Any,
    fee,
  });
  return {
    tx,
    quotedAt,
    tokenInId,
    tokenOutId,
    tokenInDecimals,
    tokenOutDecimals,
    amountHuman,
    expectedAmountOutHuman: Number(quote.bestRoute.quote ?? 0),
    expectedAmountOutAtomic: atomicFromDecimal(Number(quote.bestRoute.quote ?? 0), tokenOutDecimals),
    priceImpactBps,
    route: quote.bestRoute.route,
    swapCall: `${swapParams.contractAddress}.${swapParams.contractName}.${swapParams.functionName}`,
    postConditionCount: swapParams.postConditions?.length ?? 0,
  };
}

async function buildDepositTx(wallet: string, amountSbtc: bigint, privateKey: string, fee: bigint) {
  const market = parseContractId(MARKET);
  const token = parseContractId(SBTC_TOKEN);
  const expectedShares = cvOkUint(await callReadOnly(SBTC_VAULT, "convert-to-shares", [uintCV(amountSbtc)], wallet));
  if (expectedShares <= 0n) throw new BlockedError("ZERO_RESUPPLY_SHARES", "Received sBTC converts to zero Zest vault shares.", "Stop and inspect the partial cycle before retrying.", { amountSbtc, expectedShares });
  const postConditions = [
    Pc.principal(wallet).willSendLte(amountSbtc).ft(SBTC_TOKEN, "sbtc-token"),
    Pc.principal(MARKET).willSendLte(amountSbtc).ft(SBTC_TOKEN, "sbtc-token"),
    Pc.principal(wallet).willSendLte(expectedShares).ft(SBTC_VAULT, "zft"),
  ];
  const tx = await makeContractCall({
    contractAddress: market.address,
    contractName: market.name,
    functionName: "supply-collateral-add",
    functionArgs: [
      contractPrincipalCV(token.address, token.name),
      uintCV(amountSbtc),
      uintCV(expectedShares),
      noneCV(),
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
    postConditions,
    fee,
  });
  return { tx, expectedShares, postConditionCount: postConditions.length };
}

function txProof(txid: string, tx: JsonMap | null, fallbackFunction: string, postConditionCount: number): JsonMap {
  return {
    txid,
    explorer: `${EXPLORER}/${txid}?chain=mainnet`,
    status: tx?.tx_status ?? "unknown",
    sender: tx?.sender_address ?? null,
    contract: tx?.contract_call && typeof tx.contract_call === "object" ? (tx.contract_call as JsonMap).contract_id : null,
    function: tx?.contract_call && typeof tx.contract_call === "object" ? (tx.contract_call as JsonMap).function_name : fallbackFunction,
    result: tx?.tx_result ?? null,
    postConditionMode: tx?.post_condition_mode ?? "deny",
    postConditionCount: tx?.post_conditions && Array.isArray(tx.post_conditions) ? tx.post_conditions.length : postConditionCount,
  };
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, false);
  success("doctor", {
    result: context.pendingDepth <= context.mempoolDepthLimit ? "ready" : "blocked-by-pending-tx",
    details: contextData(context),
  });
}

async function runStatus(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, false);
  success("status", contextData(context));
}

async function runPlan(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, true);
  if (context.pendingDepth > context.mempoolDepthLimit) {
    throw new BlockedError("PENDING_TX_DEPTH", "Wallet has pending transactions above the configured limit.", "Wait for pending txs before planning a cycle.", { pendingDepth: context.pendingDepth, limit: context.mempoolDepthLimit });
  }
  await ensureNoBlockingCheckpoint(context.wallet);
  const sdk = await getBitflowSDK();
  const tokens = await withMutedConsole(() => sdk.getAvailableTokens());
  const stxToken = tokens.find((token: any) => (token.symbol ?? "").toLowerCase() === "stx" || (token.tokenId ?? "").toLowerCase() === "token-stx");
  const sbtcToken = tokens.find((token: any) => (token.symbol ?? "").toLowerCase() === "sbtc" || (token.tokenId ?? "").toLowerCase().includes("sbtc"));
  const quote = stxToken && sbtcToken
    ? await withMutedConsole(() => sdk.getQuoteForRoute(stxToken.tokenId ?? stxToken["token-id"], sbtcToken.tokenId ?? sbtcToken["token-id"], decimalFromAtomic(context.borrowAmount, Number(stxToken.tokenDecimals ?? 6)))).catch(() => null)
    : null;
  success("plan", {
    ...contextData(context),
    plannedStateMachine: [
      "borrow_planned",
      "borrow_broadcast",
      "borrow_confirmed",
      "swap_planned",
      "swap_broadcast",
      "swap_confirmed",
      "resupply_planned",
      "resupply_broadcast",
      "complete",
    ],
    quote: quote?.bestRoute ? {
      source: "BitflowSDK.getQuoteForRoute",
      tokenIn: stxToken?.tokenId ?? stxToken?.["token-id"] ?? "STX",
      tokenOut: sbtcToken?.tokenId ?? sbtcToken?.["token-id"] ?? "sBTC",
      expectedAmountOutHuman: quote.bestRoute.quote,
      priceImpact: quote.bestRoute.priceImpact ?? null,
    } : null,
    proofObligations: [
      "borrow tx success on v0-4-market.borrow",
      "swap tx success through Bitflow STX -> sBTC route",
      "resupply tx success on v0-4-market.supply-collateral-add",
      "each tx sender matches --wallet",
      "each tx uses deny postcondition mode",
      "checkpoint records each confirmed leg",
    ],
  });
}

async function runCycle(opts: RunOptions): Promise<void> {
  if (opts.confirm !== CONFIRM_TOKEN) {
    blocked("run", "CONFIRMATION_REQUIRED", "This composed write skill requires explicit confirmation.", "Re-run with --confirm=CYCLE.", { requiredConfirm: CONFIRM_TOKEN });
    return;
  }
  const context = await collectContext(opts, true);
  await ensureNoBlockingCheckpoint(context.wallet);
  await ensurePendingDepth(context.wallet, context.mempoolDepthLimit);
  const signer = await resolveSigner(context.wallet);
  const fee = parseNonNegativeBigInt(opts.feeUstx, DEFAULT_FEE_USTX, "--fee-ustx");
  const waitSeconds = parseNonNegativeInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds");
  const cycleId = `cycle-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const checkpoint: Checkpoint = {
    cycleId,
    wallet: context.wallet,
    step: "borrow_planned",
    requestedBorrowAmountUstx: context.borrowAmount.toString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextRequiredAction: "broadcast borrow",
  };
  await writeCheckpoint(checkpoint);

  const borrow = await buildBorrowTx(context.wallet, context.borrowAmount, signer.privateKey, fee);
  checkpoint.step = "borrow_broadcast";
  checkpoint.nextRequiredAction = "wait for borrow confirmation";
  await writeCheckpoint(checkpoint);
  const borrowTxid = await broadcast(borrow.tx);
  checkpoint.borrowTxid = borrowTxid;
  await writeCheckpoint(checkpoint);
  const borrowTx = await waitForTx(borrowTxid, waitSeconds);
  if (String(borrowTx?.tx_status ?? "") !== "success") {
    checkpoint.step = "blocked_partial_cycle";
    checkpoint.abortReason = "borrow did not confirm successfully";
    checkpoint.nextRequiredAction = "inspect borrow tx before resume";
    await writeCheckpoint(checkpoint);
    throw new BlockedError("BORROW_NOT_SUCCESSFUL", "Borrow transaction did not confirm successfully.", "Inspect the borrow tx before resuming.", { checkpoint, tx: borrowTx });
  }
  checkpoint.step = "borrow_confirmed";
  checkpoint.nextRequiredAction = "plan fresh Bitflow swap";
  await writeCheckpoint(checkpoint);

  await ensurePendingDepth(context.wallet, context.mempoolDepthLimit);
  const sbtcBeforeSwap = await getFtBalance(context.wallet, SBTC_TOKEN);
  const swap = await prepareSwap(context.wallet, signer.privateKey, context.borrowAmount, context.slippageBps, context.maxPriceImpactBps, fee);
  const quoteAgeSeconds = (Date.now() - new Date(swap.quotedAt).getTime()) / 1000;
  if (quoteAgeSeconds > context.maxQuoteStalenessSeconds) {
    throw new BlockedError("STALE_SWAP_QUOTE", "Bitflow quote became stale before swap broadcast.", "Rerun or resume to fetch a fresh quote.", { quoteAgeSeconds, maxQuoteStalenessSeconds: context.maxQuoteStalenessSeconds });
  }
  checkpoint.step = "swap_broadcast";
  checkpoint.swapEstimatedSbtc = swap.expectedAmountOutAtomic.toString();
  checkpoint.nextRequiredAction = "wait for swap confirmation";
  await writeCheckpoint(checkpoint);
  const swapTxid = await broadcast(swap.tx);
  checkpoint.swapTxid = swapTxid;
  await writeCheckpoint(checkpoint);
  const swapTx = await waitForTx(swapTxid, waitSeconds);
  if (String(swapTx?.tx_status ?? "") !== "success") {
    checkpoint.step = "blocked_partial_cycle";
    checkpoint.abortReason = "swap did not confirm successfully";
    checkpoint.nextRequiredAction = "inspect swap tx before resume";
    await writeCheckpoint(checkpoint);
    throw new BlockedError("SWAP_NOT_SUCCESSFUL", "Swap transaction did not confirm successfully.", "Inspect the swap tx before resuming.", { checkpoint, tx: swapTx });
  }
  const sbtcAfterSwap = await getFtBalance(context.wallet, SBTC_TOKEN);
  const receivedSbtc = sbtcAfterSwap > sbtcBeforeSwap ? sbtcAfterSwap - sbtcBeforeSwap : 0n;
  if (receivedSbtc <= 0n) {
    checkpoint.step = "blocked_partial_cycle";
    checkpoint.abortReason = "swap confirmed but no positive sBTC balance delta was observed";
    checkpoint.nextRequiredAction = "inspect wallet balances before resume";
    await writeCheckpoint(checkpoint);
    throw new BlockedError("NO_SBTC_RECEIVED", "Swap confirmed but no positive sBTC balance delta was observed.", "Inspect swap events and wallet balance before resuming.", { sbtcBeforeSwap, sbtcAfterSwap });
  }
  checkpoint.step = "swap_confirmed";
  checkpoint.observedSbtcReceived = receivedSbtc.toString();
  checkpoint.nextRequiredAction = "resupply received sBTC";
  await writeCheckpoint(checkpoint);

  await ensurePendingDepth(context.wallet, context.mempoolDepthLimit);
  const deposit = await buildDepositTx(context.wallet, receivedSbtc, signer.privateKey, fee);
  checkpoint.step = "resupply_broadcast";
  checkpoint.resuppliedSbtc = receivedSbtc.toString();
  checkpoint.nextRequiredAction = "wait for resupply confirmation";
  await writeCheckpoint(checkpoint);
  const resupplyTxid = await broadcast(deposit.tx);
  checkpoint.resupplyTxid = resupplyTxid;
  await writeCheckpoint(checkpoint);
  const resupplyTx = await waitForTx(resupplyTxid, waitSeconds);
  if (String(resupplyTx?.tx_status ?? "") !== "success") {
    checkpoint.step = "blocked_partial_cycle";
    checkpoint.abortReason = "resupply did not confirm successfully";
    checkpoint.nextRequiredAction = "inspect resupply tx before resume";
    await writeCheckpoint(checkpoint);
    throw new BlockedError("RESUPPLY_NOT_SUCCESSFUL", "Resupply transaction did not confirm successfully.", "Inspect the resupply tx before resuming.", { checkpoint, tx: resupplyTx });
  }
  checkpoint.step = "complete";
  checkpoint.nextRequiredAction = "cycle complete";
  await writeCheckpoint(checkpoint);
  const postPosition = await getPosition(context.wallet);
  success("run", {
    cycleId,
    wallet: context.wallet,
    signer: { source: signer.source, address: signer.address },
    state: checkpoint,
    transactions: {
      borrow: txProof(borrowTxid, borrowTx, "borrow", borrow.postConditionCount),
      swap: txProof(swapTxid, swapTx, "swap", swap.postConditionCount),
      resupply: txProof(resupplyTxid, resupplyTx, "supply-collateral-add", deposit.postConditionCount),
    },
    amounts: {
      borrowedUstx: context.borrowAmount,
      swapExpectedSbtcAtomic: swap.expectedAmountOutAtomic,
      observedSbtcReceived: receivedSbtc,
      resuppliedSbtc: receivedSbtc,
      resupplyExpectedShares: deposit.expectedShares,
    },
    postPosition,
  });
}

async function runResume(opts: RunOptions): Promise<void> {
  const checkpoint = await readCheckpoint(opts.wallet);
  if (!checkpoint) throw new BlockedError("NO_CHECKPOINT", "No checkpoint exists for this wallet.", "Start a new cycle with run --confirm=CYCLE.");
  if (checkpoint.step === "complete" || checkpoint.step === "operator_cancelled") {
    success("resume", { checkpoint, note: "No partial cycle remains to resume." });
    return;
  }
  if (opts.confirm !== CONFIRM_TOKEN) {
    blocked("resume", "CONFIRMATION_REQUIRED", "Resuming a partial leverage cycle requires explicit confirmation.", "Re-run with --confirm=CYCLE after inspecting the checkpoint.", { checkpoint });
    return;
  }
  if (checkpoint.step !== "borrow_confirmed" && checkpoint.step !== "swap_confirmed") {
    blocked("resume", "UNSUPPORTED_RESUME_STEP", "This checkpoint step requires manual review before automatic resume.", "Inspect the checkpoint and transaction state before continuing.", { checkpoint });
    return;
  }
  const context = await collectContext({ ...opts, borrowAmountUstx: checkpoint.requestedBorrowAmountUstx }, true);
  const signer = await resolveSigner(context.wallet);
  const fee = parseNonNegativeBigInt(opts.feeUstx, DEFAULT_FEE_USTX, "--fee-ustx");
  const waitSeconds = parseNonNegativeInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds");
  let swapTx: JsonMap | null = null;
  let swapTxid = checkpoint.swapTxid ?? "";
  let receivedSbtc = checkpoint.observedSbtcReceived ? BigInt(checkpoint.observedSbtcReceived) : 0n;
  let swapPostConditionCount = 0;
  let swapExpectedSbtcAtomic = checkpoint.swapEstimatedSbtc ? BigInt(checkpoint.swapEstimatedSbtc) : 0n;

  if (checkpoint.step === "borrow_confirmed") {
    await ensurePendingDepth(context.wallet, context.mempoolDepthLimit);
    const sbtcBeforeSwap = await getFtBalance(context.wallet, SBTC_TOKEN);
    const swap = await prepareSwap(context.wallet, signer.privateKey, context.borrowAmount, context.slippageBps, context.maxPriceImpactBps, fee);
    const quoteAgeSeconds = (Date.now() - new Date(swap.quotedAt).getTime()) / 1000;
    if (quoteAgeSeconds > context.maxQuoteStalenessSeconds) {
      throw new BlockedError("STALE_SWAP_QUOTE", "Bitflow quote became stale before swap broadcast.", "Rerun resume with a larger --max-quote-staleness-seconds only if this latency is acceptable.", { quoteAgeSeconds, maxQuoteStalenessSeconds: context.maxQuoteStalenessSeconds });
    }
    checkpoint.step = "swap_broadcast";
    checkpoint.swapEstimatedSbtc = swap.expectedAmountOutAtomic.toString();
    checkpoint.nextRequiredAction = "wait for swap confirmation";
    await writeCheckpoint(checkpoint);
    swapTxid = await broadcast(swap.tx);
    checkpoint.swapTxid = swapTxid;
    await writeCheckpoint(checkpoint);
    swapTx = await waitForTx(swapTxid, waitSeconds);
    if (String(swapTx?.tx_status ?? "") !== "success") {
      checkpoint.step = "blocked_partial_cycle";
      checkpoint.abortReason = "swap did not confirm successfully";
      checkpoint.nextRequiredAction = "inspect swap tx before resume";
      await writeCheckpoint(checkpoint);
      throw new BlockedError("SWAP_NOT_SUCCESSFUL", "Swap transaction did not confirm successfully.", "Inspect the swap tx before resuming.", { checkpoint, tx: swapTx });
    }
    const sbtcAfterSwap = await getFtBalance(context.wallet, SBTC_TOKEN);
    receivedSbtc = sbtcAfterSwap > sbtcBeforeSwap ? sbtcAfterSwap - sbtcBeforeSwap : 0n;
    if (receivedSbtc <= 0n) throw new BlockedError("NO_SBTC_RECEIVED", "Swap confirmed but no positive sBTC balance delta was observed.", "Inspect swap events and wallet balance before resuming.", { sbtcBeforeSwap, sbtcAfterSwap });
    checkpoint.step = "swap_confirmed";
    checkpoint.observedSbtcReceived = receivedSbtc.toString();
    checkpoint.nextRequiredAction = "resupply received sBTC";
    await writeCheckpoint(checkpoint);
    swapPostConditionCount = swap.postConditionCount;
    swapExpectedSbtcAtomic = swap.expectedAmountOutAtomic;
  }

  await ensurePendingDepth(context.wallet, context.mempoolDepthLimit);
  const deposit = await buildDepositTx(context.wallet, receivedSbtc, signer.privateKey, fee);
  checkpoint.step = "resupply_broadcast";
  checkpoint.resuppliedSbtc = receivedSbtc.toString();
  checkpoint.nextRequiredAction = "wait for resupply confirmation";
  await writeCheckpoint(checkpoint);
  const resupplyTxid = await broadcast(deposit.tx);
  checkpoint.resupplyTxid = resupplyTxid;
  await writeCheckpoint(checkpoint);
  const resupplyTx = await waitForTx(resupplyTxid, waitSeconds);
  if (String(resupplyTx?.tx_status ?? "") !== "success") {
    checkpoint.step = "blocked_partial_cycle";
    checkpoint.abortReason = "resupply did not confirm successfully";
    checkpoint.nextRequiredAction = "inspect resupply tx before resume";
    await writeCheckpoint(checkpoint);
    throw new BlockedError("RESUPPLY_NOT_SUCCESSFUL", "Resupply transaction did not confirm successfully.", "Inspect the resupply tx before resuming.", { checkpoint, tx: resupplyTx });
  }
  checkpoint.step = "complete";
  checkpoint.nextRequiredAction = "cycle complete";
  await writeCheckpoint(checkpoint);
  const borrowTx = checkpoint.borrowTxid ? await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/tx/${checkpoint.borrowTxid}`).catch(() => null) : null;
  if (!swapTx && swapTxid) swapTx = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/tx/${swapTxid}`).catch(() => null);
  success("resume", {
    cycleId: checkpoint.cycleId,
    wallet: context.wallet,
    signer: { source: signer.source, address: signer.address },
    state: checkpoint,
    transactions: {
      borrow: checkpoint.borrowTxid ? txProof(checkpoint.borrowTxid, borrowTx, "borrow", 2) : null,
      swap: swapTxid ? txProof(swapTxid, swapTx, "swap", swapPostConditionCount) : null,
      resupply: txProof(resupplyTxid, resupplyTx, "supply-collateral-add", deposit.postConditionCount),
    },
    amounts: {
      borrowedUstx: context.borrowAmount,
      swapExpectedSbtcAtomic,
      observedSbtcReceived: receivedSbtc,
      resuppliedSbtc: receivedSbtc,
      resupplyExpectedShares: deposit.expectedShares,
    },
  });
}

async function runCancel(opts: SharedOptions): Promise<void> {
  const checkpoint = await readCheckpoint(opts.wallet);
  if (!checkpoint) throw new BlockedError("NO_CHECKPOINT", "No checkpoint exists for this wallet.", "Nothing to cancel.");
  if (checkpoint.step === "complete") {
    success("cancel", { checkpoint, note: "Completed checkpoints are retained for proof and do not need cancellation." });
    return;
  }
  checkpoint.step = "operator_cancelled";
  checkpoint.nextRequiredAction = "operator reviewed and cancelled checkpoint";
  await writeCheckpoint(checkpoint);
  success("cancel", { checkpoint });
}

function addSharedOptions(command: Command): Command {
  return command
    .requiredOption("--wallet <stacks-address>", "wallet that owns collateral and signs the cycle")
    .option("--borrow-amount-ustx <uSTX>", "STX borrow amount in micro-STX")
    .option("--slippage-bps <bps>", "Bitflow swap slippage tolerance in basis points", String(DEFAULT_SLIPPAGE_BPS))
    .option("--max-quote-staleness-seconds <seconds>", "maximum Bitflow quote age before swap broadcast", String(DEFAULT_MAX_QUOTE_STALENESS_SECONDS))
    .option("--max-price-impact-bps <bps>", "maximum Bitflow quote price impact in basis points", String(DEFAULT_MAX_PRICE_IMPACT_BPS))
    .option("--min-gas-reserve-ustx <uSTX>", "minimum STX reserve before each write", DEFAULT_MIN_GAS_RESERVE_USTX.toString())
    .option("--mempool-depth-limit <count>", "maximum pending sender tx count before each leg", String(DEFAULT_MEMPOOL_DEPTH_LIMIT))
    .option("--wait-seconds <seconds>", "seconds to poll Hiro for each transaction", String(DEFAULT_WAIT_SECONDS));
}

const program = new Command();
program.name("bitflow-zest-sbtc-leverage-cycle").description("Execute one Bitflow + Zest sBTC leverage cycle with resume safety.");

addSharedOptions(program.command("doctor").description("Check dependency and wallet readiness"))
  .action((opts: SharedOptions) => runDoctor(opts).catch((error) => fail("doctor", error)));

addSharedOptions(program.command("status").description("Read Zest position and saved cycle state"))
  .action((opts: SharedOptions) => runStatus(opts).catch((error) => fail("status", error)));

addSharedOptions(program.command("plan").description("Preview one leverage cycle without broadcasting"))
  .action((opts: SharedOptions) => runPlan(opts).catch((error) => fail("plan", error)));

addSharedOptions(program.command("run").description("Broadcast one confirmed leverage cycle"))
  .option("--confirm <token>", "required confirmation token")
  .option("--fee-ustx <uSTX>", "fee per transaction in micro-STX", DEFAULT_FEE_USTX.toString())
  .action((opts: RunOptions) => runCycle(opts).catch((error) => fail("run", error)));

addSharedOptions(program.command("resume").description("Inspect/resume a partial saved cycle state"))
  .option("--confirm <token>", "reserved for future automatic resume")
  .option("--fee-ustx <uSTX>", "fee per transaction in micro-STX", DEFAULT_FEE_USTX.toString())
  .action((opts: RunOptions) => runResume(opts).catch((error) => fail("resume", error)));

addSharedOptions(program.command("cancel").description("Mark unresolved saved cycle state as operator-cancelled"))
  .action((opts: SharedOptions) => runCancel(opts).catch((error) => fail("cancel", error)));

program.parse(process.argv);
