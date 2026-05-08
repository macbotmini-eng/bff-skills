#!/usr/bin/env bun
/**
 * sbtc-leverage-unwind-planner
 *
 * Composed write skill that safely reduces or closes a leveraged sBTC
 * position on Stacks. Repays Zest debt first, re-reads canonical state,
 * then optionally withdraws collateral or swaps residuals. Refuses
 * unsafe withdraw-first orderings, persists checkpoint state, and resumes
 * from partial states without overwriting them.
 *
 * Subcommands per PRD https://github.com/BitflowFinance/bff-skills/issues/562 §Required CLI Surface:
 *   doctor   — read-only wallet/Zest/swap/gas/nonce/mempool/checkpoint readiness
 *   status   — read-only canonical Zest debt/collateral/health/liquidatable read
 *   plan     — ordered unwind plan (mode A/B/C/D); does NOT broadcast
 *   run      — execute the unwind; requires --confirm UNWIND
 *   resume   — resume an unresolved unwind from checkpoint
 *   cancel   — mark an unresolved unwind as cancelled (operator-acknowledged)
 *
 * Output contract: every subcommand prints exactly ONE JSON object to stdout.
 * Per aibtcdev/skills CONTRIBUTING.md Code Style + bff-skills Issue #484.
 */

import { Command } from "commander";
import {
  AnchorMode,
  Pc,
  PostConditionMode,
  broadcastTransaction,
  bufferCV,
  contractPrincipalCV,
  cvToJSON,
  fetchCallReadOnlyFunction,
  getAddressFromPrivateKey,
  listCV,
  makeContractCall,
  noneCV,
  principalCV,
  someCV,
  uintCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

// ─── Output contract types ──────────────────────────────────────────────────

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";
type Action = "doctor" | "status" | "plan" | "run" | "resume" | "cancel";

type UnwindMode =
  | "A-direct-repay"
  | "B-swap-for-repay"
  | "C-collateral-release-assisted"
  | "D-post-repay-withdraw";

type UnwindState =
  | "idle"
  | "unwind_plan_created"
  | "optional_swap_for_repay_planned"
  | "optional_swap_for_repay_broadcast"
  | "optional_swap_for_repay_confirmed"
  | "repay_planned"
  | "repay_broadcast"
  | "repay_confirmed"
  | "post_repay_position_read"
  | "optional_collateral_withdraw_planned"
  | "optional_collateral_withdraw_broadcast"
  | "optional_collateral_withdraw_confirmed"
  | "optional_residual_swap_planned"
  | "optional_residual_swap_broadcast"
  | "optional_residual_swap_confirmed"
  | "complete"
  | "blocked_partial_unwind";

type BlockedCode =
  | "STALE_QUOTE"
  | "INSUFFICIENT_REPAY_ASSET"
  | "UNSAFE_COLLATERAL_WITHDRAWAL"
  | "PENDING_TX"
  | "UNRESOLVED_CHECKPOINT"
  | "WALLET_INVALID"
  | "WALLET_LOCKED"
  | "BALANCE_INSUFFICIENT"
  | "CONTRACT_UNREACHABLE"
  | "MARKET_ABI_MISSING"
  | "MISSING_REPAY_TARGET"
  | "MISSING_REPAY_TARGET_EXCLUSIVE"
  | "MISSING_DEBT_ASSET"
  | "UNSUPPORTED_DEBT_ASSET"
  | "MISSING_COLLATERAL_ASSET"
  | "UNSUPPORTED_COLLATERAL_ASSET"
  | "AGGREGATOR_BLOCKED"
  | "SWAP_TX_NOT_SUCCESS"
  | "REPAY_TX_NOT_SUCCESS"
  | "WITHDRAW_TX_NOT_SUCCESS"
  | "CHECKPOINT_CHAIN_DIVERGENCE";

interface AssetConfig {
  symbol: string;
  aliases: string[];
  underlying: string;
  assetName: string;
  vault?: string;
  decimals: number;
  canCollateral: boolean;
  canBorrow: boolean;
  pythFeed?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const NETWORK = "mainnet";
const HIRO_API = "https://api.hiro.so";
const PYTH_HERMES_API = "https://hermes.pyth.network";
const PYTH_MAX_FEE_USTX = 10n;
const EXPLORER = "https://explorer.hiro.so/txid";
const STATE_DIR = path.join(os.homedir(), ".aibtc", "sbtc-leverage-unwind-planner");

// Zest V2 surface — canonical mainnet contracts (verified via live Hiro contract interface 2026-05-05).
// Mirrors the constants in our merged primitives at:
// https://github.com/aibtcdev/skills/tree/main/zest-borrow-asset-primitive
// https://github.com/aibtcdev/skills/tree/main/zest-asset-deposit-primitive
const MARKET = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market";
const MARKET_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-market-vault";
const ASSETS = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-assets";
const EGROUP = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-egroup";
const STX_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-stx";

// Write fns on v0-4-market
const FN_REPAY = "repay";
const FN_COLLATERAL_REMOVE_REDEEM = "collateral-remove-redeem";
// Reference: borrow exists on v0-4-market (used to verify the same market that minted debt is the one we repay)
const FN_BORROW_REF = "borrow";
// Read fns
const FN_GET_BITMAP = "get-bitmap"; // on ASSETS
const FN_GET_POSITION = "get-position"; // on MARKET_VAULT, args (user, bitmap)
const FN_GET_ASSET_STATUS = "get-asset-status"; // on ASSETS, arg (asset principal)

// Confirm tokens (distinct per subcommand)
const CONFIRM_RUN = "UNWIND";
const CONFIRM_RESUME = "RESUME";
const CONFIRM_CANCEL = "CANCEL";

// Defaults
const DEFAULT_MAX_QUOTE_STALENESS_SECONDS = 30;
const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_MIN_HEALTH_FACTOR = 1.5;
const DEFAULT_MIN_GAS_RESERVE_USTX = 200_000n;
const DEFAULT_MEMPOOL_DEPTH_LIMIT = 5;
const DEFAULT_WAIT_SECONDS = 240;

// Asset config — mirror of the merged borrow primitive's table; unwind only needs the
// canBorrow set as candidate debt assets (STX is the first required target per PRD).
const ASSET_CONFIGS: AssetConfig[] = [
  {
    symbol: "STX",
    aliases: ["stx", "wstx"],
    underlying: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx",
    assetName: "wstx",
    vault: STX_VAULT,
    decimals: 6,
    canCollateral: true,
    canBorrow: true,
    pythFeed: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17",
  },
  {
    symbol: "sBTC",
    aliases: ["sbtc", "btc"],
    underlying: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    assetName: "sbtc-token",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
    decimals: 8,
    canCollateral: true,
    canBorrow: true,
    pythFeed: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  },
  {
    symbol: "stSTX",
    aliases: ["ststx"],
    underlying: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
    assetName: "ststx",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-ststx",
    decimals: 6,
    canCollateral: true,
    canBorrow: true,
    pythFeed: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17",
  },
  {
    symbol: "USDC",
    aliases: ["usdc", "usdcx"],
    underlying: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    assetName: "usdcx-token",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc",
    decimals: 6,
    canCollateral: true,
    canBorrow: true,
  },
  {
    symbol: "USDH",
    aliases: ["usdh"],
    underlying: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",
    assetName: "usdh",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdh",
    decimals: 8,
    canCollateral: true,
    canBorrow: true,
  },
];

// ─── Error type + JSON output helpers ───────────────────────────────────────

class BlockedError extends Error {
  constructor(
    public code: BlockedCode | string,
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
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stringify(v)])
    ) as JsonMap;
  }
  if (value === undefined) return null;
  return value as Json;
}

function emit(status: Status, action: Action, data: JsonMap, error: JsonMap | null): void {
  console.log(JSON.stringify({ status, action, data: stringify(data), error: stringify(error) }, null, 2));
  if (status === "error") process.exitCode = 1;
}

function success(action: Action, data: JsonMap): void {
  emit("success", action, data, null);
}

function blocked(action: Action, code: string, message: string, next: string, data: JsonMap = {}): void {
  emit("blocked", action, data, { code, message, next });
}

function fail(action: Action, err: unknown): void {
  if (err instanceof BlockedError) {
    blocked(action, err.code, err.message, err.next, err.data);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  emit("error", action, {}, { code: "ERROR", message, next: "Run doctor and inspect the failing check before retrying." });
}

// ─── Hiro fetch helpers (mirror of borrow primitive pattern) ───────────────

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
  }
  return response.json() as Promise<T>;
}

function parseContractId(contractId: string): { address: string; name: string } {
  const [address, name] = contractId.split(".");
  if (!address || !name) throw new Error(`Invalid contract id: ${contractId}`);
  return { address, name };
}

async function getContract(contractId: string): Promise<{ canonical?: boolean; tx_id?: string }> {
  return fetchJson(`${HIRO_API}/extended/v1/contract/${contractId}`);
}

async function getContractInterface(
  contractId: string
): Promise<{ functions?: Array<{ name: string; access: string; args?: unknown[] }> }> {
  const { address, name } = parseContractId(contractId);
  return fetchJson(`${HIRO_API}/v2/contracts/interface/${address}/${name}?proof=0`);
}

async function callReadOnly(
  contractId: string,
  functionName: string,
  args: Parameters<typeof fetchCallReadOnlyFunction>[0]["functionArgs"],
  sender: string
) {
  const { address, name } = parseContractId(contractId);
  return fetchCallReadOnlyFunction({
    network: STACKS_MAINNET,
    contractAddress: address,
    contractName: name,
    functionName,
    functionArgs: args,
    senderAddress: sender,
  });
}

function cvJson(value: unknown): JsonMap {
  return stringify(cvToJSON(value)) as JsonMap;
}

function uintValue(value: unknown): bigint {
  if (value && typeof value === "object" && "value" in value) {
    return BigInt(String((value as { value: unknown }).value ?? "0"));
  }
  return BigInt(String(value ?? "0"));
}

function fieldValue(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value) return (value as { value: unknown }).value;
  return value;
}

function okValue(value: JsonMap): unknown {
  if (value.success === false) return null;
  const wrapped = value.value;
  if (wrapped && typeof wrapped === "object" && "value" in wrapped) {
    return (wrapped as { value: unknown }).value;
  }
  return wrapped;
}

// ─── Utility ────────────────────────────────────────────────────────────────

function isStacksAddress(addr: string | undefined): boolean {
  return typeof addr === "string" && /^SP[0-9A-HJ-NP-Z]{38,40}$/.test(addr);
}

function resolveAsset(input: string | undefined): AssetConfig {
  if (!input) {
    throw new BlockedError("MISSING_DEBT_ASSET", "--debt-asset is required.", "Re-run with --debt-asset <symbol>.");
  }
  const wanted = input.toLowerCase();
  const asset = ASSET_CONFIGS.find(
    (c) =>
      c.symbol.toLowerCase() === wanted ||
      c.aliases.some((a) => a.toLowerCase() === wanted) ||
      c.underlying.toLowerCase() === wanted ||
      c.vault?.toLowerCase() === wanted
  );
  if (!asset) {
    throw new BlockedError("UNSUPPORTED_DEBT_ASSET", `Unsupported Zest debt asset: ${input}`, "Pass one of: STX, sBTC, stSTX, USDC, USDH.");
  }
  return asset;
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
}

// ─── Signer resolution (mirror of merged borrow primitive) ──────────────────

interface SessionFile {
  version: number;
  expiresAt?: string;
  encrypted: { ciphertext: string; iv: string; authTag: string };
}

function aibtcPath(...parts: string[]): string {
  return path.join(os.homedir(), ".aibtc", ...parts);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function decryptSessionAccount(walletId: string): Promise<{ address: string; privateKey: string } | null> {
  const session = await readJsonFile<SessionFile>(aibtcPath("sessions", `${path.basename(walletId)}.json`));
  if (!session || session.version !== 1) return null;
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) return null;
  const sessionKey = await fs.readFile(aibtcPath("sessions", ".session-key")).catch(() => null);
  if (!sessionKey || sessionKey.length !== 32) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(session.encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(session.encrypted.authTag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(session.encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8")
  );
}

async function resolveSigner(expectedWallet: string): Promise<{ privateKey: string; address: string; source: string }> {
  const attempts: string[] = [];
  const config = await readJsonFile<{ activeWalletId?: string }>(aibtcPath("config.json"));
  const walletId = process.env.AIBTC_WALLET_ID || config?.activeWalletId;
  if (walletId) {
    try {
      const account = await decryptSessionAccount(walletId);
      if (account?.privateKey) {
        if (account.address !== expectedWallet) {
          throw new Error(`session resolves to ${account.address}, expected ${expectedWallet}`);
        }
        return { privateKey: account.privateKey, address: account.address, source: "AIBTC_SESSION_FILE" };
      }
      attempts.push("AIBTC_SESSION_FILE: no active unexpired session");
    } catch (error) {
      attempts.push(`AIBTC_SESSION_FILE: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    attempts.push("AIBTC_SESSION_FILE: no active wallet id");
  }
  const privateKey = process.env.STACKS_PRIVATE_KEY?.trim();
  if (privateKey) {
    const address = getAddressFromPrivateKey(privateKey, "mainnet");
    if (address !== expectedWallet) {
      throw new Error(`STACKS_PRIVATE_KEY resolves to ${address}, expected ${expectedWallet}`);
    }
    return { privateKey, address, source: "STACKS_PRIVATE_KEY" };
  }
  attempts.push("STACKS_PRIVATE_KEY: not set");
  throw new BlockedError(
    "WALLET_LOCKED",
    `Could not resolve signer. ${attempts.join("; ")}`,
    "Run `arc creds unlock` to create a session, or set STACKS_PRIVATE_KEY in the shell that runs the proof."
  );
}

// ─── Confirmation polling ───────────────────────────────────────────────────

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
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return last;
}

// ─── Checkpoint persistence ─────────────────────────────────────────────────

function generateUnwindId(): string {
  return `unwind_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

async function persistCheckpoint(checkpoint: CheckpointFile): Promise<string> {
  await ensureStateDir();
  const filePath = path.join(STATE_DIR, `${checkpoint.unwindId}.json`);
  // Strip any sensitive fields defensively (PRD: never persist secrets/mnemonics/raw signed tx/api tokens)
  const safe = { ...checkpoint };
  delete (safe as Record<string, unknown>).privateKey;
  delete (safe as Record<string, unknown>).mnemonic;
  delete (safe as Record<string, unknown>).password;
  delete (safe as Record<string, unknown>).rawTx;
  await fs.writeFile(filePath, JSON.stringify(safe, null, 2), { mode: 0o600 });
  return filePath;
}

interface CheckpointFile {
  unwindId: string;
  wallet: string;
  state: UnwindState;
  currentStep: string;
  blockedReason: string | null;
  nextRequiredAction: string;
  // ... extends per PRD §Checkpoint Requirements; populated in batches 6-10
  [k: string]: Json | undefined;
}

async function readCheckpointForWallet(wallet: string): Promise<CheckpointFile | null> {
  try {
    const dir = await fs.readdir(STATE_DIR);
    for (const file of dir) {
      if (!file.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(STATE_DIR, file), "utf8");
      const parsed = JSON.parse(raw) as CheckpointFile;
      if (parsed.wallet === wallet && parsed.state !== "complete") return parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return null;
}

// ─── doctor ─────────────────────────────────────────────────────────────────

interface DoctorOpts {
  wallet: string;
}

async function cmdDoctor(opts: DoctorOpts): Promise<void> {
  const action: Action = "doctor";
  try {
    if (!isStacksAddress(opts.wallet)) {
      throw new BlockedError(
        "WALLET_INVALID",
        "--wallet must be a mainnet Stacks address (SP...).",
        "Pass --wallet <SP...> for the wallet that owns the position."
      );
    }
    await ensureStateDir();

    const dependencies: JsonMap = {};

    // 1. Wallet balances + gas
    const balances = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/address/${opts.wallet}/balances`);
    const stxBalance = BigInt(String((balances.stx as JsonMap | undefined)?.balance ?? "0"));
    const stxLocked = BigInt(String((balances.stx as JsonMap | undefined)?.locked ?? "0"));
    const stxAvailable = stxBalance - stxLocked;
    dependencies.wallet_balances = {
      stx_available_ustx: stxAvailable.toString(),
      stx_locked_ustx: stxLocked.toString(),
    };
    if (stxAvailable < DEFAULT_MIN_GAS_RESERVE_USTX) {
      throw new BlockedError(
        "BALANCE_INSUFFICIENT",
        `Wallet has ${stxAvailable} uSTX available; gas reserve floor is ${DEFAULT_MIN_GAS_RESERVE_USTX} uSTX.`,
        `Top up STX gas before broadcasting any leg.`,
        { observed_ustx: stxAvailable.toString(), threshold_ustx: DEFAULT_MIN_GAS_RESERVE_USTX.toString() }
      );
    }

    // 2. Zest contracts reachable
    for (const cid of [MARKET, MARKET_VAULT, ASSETS, EGROUP]) {
      try {
        await getContract(cid);
        dependencies[cid] = { available: true };
      } catch (err) {
        throw new BlockedError(
          "CONTRACT_UNREACHABLE",
          `Could not load ${cid} from Hiro.`,
          `Re-verify the canonical Zest deployer + contract names. Hiro may be unreachable.`,
          { contract: cid, error: (err as Error).message }
        );
      }
    }

    // 3. Market interface exposes the write fns we will call
    const marketIface = await getContractInterface(MARKET);
    const fnNames = new Set((marketIface.functions ?? []).map((f) => f.name));
    for (const required of [FN_REPAY, FN_COLLATERAL_REMOVE_REDEEM, FN_BORROW_REF]) {
      if (!fnNames.has(required)) {
        throw new BlockedError(
          "MARKET_ABI_MISSING",
          `Zest market does not expose required function: ${required}.`,
          "Do not broadcast until the live market ABI is verified.",
          { contract: MARKET, missing_function: required }
        );
      }
    }
    dependencies.market_abi = {
      contract: MARKET,
      verified_functions: [FN_REPAY, FN_COLLATERAL_REMOVE_REDEEM, FN_BORROW_REF],
    };

    // 4. Mempool depth
    const mempool = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/address/${opts.wallet}/mempool?limit=20`);
    const pending = Number((mempool.results as Json[] | undefined)?.length ?? 0);
    dependencies.mempool = { pending_count: pending, limit: DEFAULT_MEMPOOL_DEPTH_LIMIT };
    if (pending >= DEFAULT_MEMPOOL_DEPTH_LIMIT) {
      throw new BlockedError(
        "PENDING_TX",
        `Wallet has ${pending} pending mempool tx; limit is ${DEFAULT_MEMPOOL_DEPTH_LIMIT}.`,
        "Wait for pending txs to clear before broadcasting any leg."
      );
    }

    // 5. Checkpoint dir
    const existing = await readCheckpointForWallet(opts.wallet);
    if (existing) {
      throw new BlockedError(
        "UNRESOLVED_CHECKPOINT",
        `An unresolved unwind exists for this wallet (unwindId=${existing.unwindId}, state=${existing.state}).`,
        "Run resume or cancel before any new unwind.",
        { checkpoint: existing as unknown as JsonMap }
      );
    }
    dependencies.checkpoint = { unresolved: false, dir: STATE_DIR };

    // 6. Bitflow swap aggregator + nonce-manager presence (filesystem heuristic; full check is at use time)
    dependencies.bitflow_swap_aggregator = {
      composition_target: "https://github.com/aibtcdev/skills/tree/main/bitflow-swap-aggregator",
      verified_at_use_time: true,
    };
    dependencies.nonce_manager = {
      composition_target: "nonce-manager skill (pre-flight before each broadcast)",
      verified_at_use_time: true,
    };

    success(action, {
      wallet: opts.wallet,
      network: NETWORK,
      ready: true,
      dependencies,
    });
  } catch (err) {
    fail(action, err);
  }
}

// ─── status ─────────────────────────────────────────────────────────────────

interface StatusOpts {
  wallet: string;
  debtAsset: string;
}

interface ZestPosition {
  debtAsset: string | null;
  debtAmount: string | null;
  collateralAsset: string | null;
  collateralAmount: string | null;
  healthFactor: number | null;
  liquidatable: boolean | null;
  accruedInterest: string | null;
  safeWithdrawableCollateral: string | null;
  asOfBlockHeight: number | null;
  raw: JsonMap;
}

async function readZestPosition(wallet: string, debtAsset: AssetConfig): Promise<ZestPosition> {
  // Step 1: get user's bitmap on v0-assets
  const bitmapCV = await callReadOnly(ASSETS, FN_GET_BITMAP, [], wallet);
  const bitmapJson = cvJson(bitmapCV);
  const bitmap = uintValue(okValue(bitmapJson) ?? bitmapJson);

  // Step 2: get full position on v0-market-vault
  const positionCV = await callReadOnly(
    MARKET_VAULT,
    FN_GET_POSITION,
    [principalCV(wallet), uintCV(bitmap)],
    wallet
  );
  const positionJson = cvJson(positionCV);
  const position = okValue(positionJson) as JsonMap | null;

  // Position tuple shape (per merged borrow primitive readers):
  //   collateral, debt, health, liquidatable, ...
  // Field names may vary; we surface the raw decoded JSON and best-effort scalar pulls.
  const debtRaw = fieldValue((position ?? {}).debt) ?? fieldValue((position ?? {}).total_debt);
  const collateralRaw = fieldValue((position ?? {}).collateral) ?? fieldValue((position ?? {}).total_collateral);
  const healthRaw = fieldValue((position ?? {}).health) ?? fieldValue((position ?? {}).hf);
  const liqRaw = fieldValue((position ?? {}).liquidatable);

  // Block height
  const tip = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/block?limit=1`);
  const blockHeight = Number((tip.results as JsonMap[] | undefined)?.[0]?.height ?? 0);

  const debtAmount = debtRaw == null ? null : String(debtRaw);
  const collateralAmount = collateralRaw == null ? null : String(collateralRaw);
  const healthFactor =
    healthRaw == null
      ? null
      : Number(BigInt(String(healthRaw))) / 1e6; // tentative scaling; refined in batch 5 once observed values seen on a real position

  return {
    debtAsset: debtAsset.symbol,
    debtAmount,
    collateralAsset: null, // surfaced once we read per-asset collateral set in batch 5
    collateralAmount,
    healthFactor,
    liquidatable: liqRaw == null ? null : Boolean(liqRaw),
    accruedInterest: null, // requires per-asset vault read; batch 5
    safeWithdrawableCollateral: null, // requires HF-projection math; batch 5
    asOfBlockHeight: blockHeight,
    raw: position ?? {},
  };
}

async function cmdStatus(opts: StatusOpts): Promise<void> {
  const action: Action = "status";
  try {
    if (!isStacksAddress(opts.wallet)) {
      throw new BlockedError(
        "WALLET_INVALID",
        "--wallet must be a mainnet Stacks address (SP...).",
        "Pass --wallet <SP...> for the wallet that owns the position."
      );
    }
    const debtAsset = resolveAsset(opts.debtAsset);
    const position = await readZestPosition(opts.wallet, debtAsset);

    // Existing checkpoint surfaced (informational only — doctor blocks on this)
    const existing = await readCheckpointForWallet(opts.wallet);
    const checkpoint = existing
      ? { unresolved: true, unwindId: existing.unwindId, state: existing.state }
      : { unresolved: false };

    success(action, {
      wallet: opts.wallet,
      network: NETWORK,
      debtAsset: debtAsset.symbol,
      position: position as unknown as JsonMap,
      risk: {
        currentHealthFactor: position.healthFactor,
        liquidatable: position.liquidatable,
      },
      checkpoint,
    });
  } catch (err) {
    fail(action, err);
  }
}

// ─── plan / run / resume / cancel — implementations land in batches 5-10 ────

interface PlanOpts extends StatusOpts {
  collateralAsset?: string;
  repayAmount?: string;
  repayBps?: string;
  repayAll?: boolean;
  swapForRepay?: boolean;
  swapSourceAsset?: string;
  allowCollateralReleaseForRepay?: boolean;
  withdrawCollateral?: boolean;
  withdrawAmount?: string;
  withdrawSlippageBps?: string;
  maxQuoteStalenessSeconds?: string;
  slippageBps?: string;
  minHealthFactor?: string;
  maxLtvBps?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  waitSeconds?: string;
}

interface RunOpts extends PlanOpts {
  confirm?: string;
}

// ─── Plan helpers ───────────────────────────────────────────────────────────

interface RepayTarget {
  amount: bigint; // base units of debtAsset
  source: "amount" | "bps" | "all";
}

function resolveRepayTarget(opts: PlanOpts, currentDebt: bigint): RepayTarget {
  const provided = [opts.repayAmount, opts.repayBps, opts.repayAll].filter(Boolean).length;
  if (provided === 0) {
    throw new BlockedError(
      "MISSING_REPAY_TARGET",
      "Exactly one of --repay-amount, --repay-bps, --repay-all is required for plan/run.",
      "Re-run with one repay-target flag."
    );
  }
  if (provided > 1) {
    throw new BlockedError(
      "MISSING_REPAY_TARGET_EXCLUSIVE",
      "--repay-amount, --repay-bps, --repay-all are mutually exclusive.",
      "Pass exactly one."
    );
  }
  if (opts.repayAmount) {
    if (!/^\d+$/.test(opts.repayAmount)) throw new Error("--repay-amount must be a positive integer in base units");
    return { amount: BigInt(opts.repayAmount), source: "amount" };
  }
  if (opts.repayBps) {
    const bps = Number(opts.repayBps);
    if (!Number.isInteger(bps) || bps <= 0 || bps > 10000) throw new Error("--repay-bps must be 1..10000");
    return { amount: (currentDebt * BigInt(bps)) / 10000n, source: "bps" };
  }
  return { amount: currentDebt, source: "all" };
}

interface WalletBalances {
  stxAvailable: bigint;
  perAsset: Record<string, bigint>;
}

async function readWalletBalances(wallet: string): Promise<WalletBalances> {
  const balances = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/address/${wallet}/balances`);
  const stx = balances.stx as JsonMap | undefined;
  const stxBalance = BigInt(String(stx?.balance ?? "0")) - BigInt(String(stx?.locked ?? "0"));
  const fungibles = (balances.fungible_tokens as JsonMap | undefined) ?? {};
  const perAsset: Record<string, bigint> = { STX: stxBalance };
  for (const [tokenKey, info] of Object.entries(fungibles)) {
    const matched = ASSET_CONFIGS.find((c) => tokenKey.startsWith(c.underlying));
    if (matched) {
      perAsset[matched.symbol] = BigInt(String((info as JsonMap)?.balance ?? "0"));
    }
  }
  return { stxAvailable: stxBalance, perAsset };
}

function determineMode(opts: PlanOpts, walletBalanceForDebt: bigint, repayTarget: bigint): UnwindMode {
  if (walletBalanceForDebt >= repayTarget) return "A-direct-repay";
  if (opts.swapForRepay && opts.swapSourceAsset) return "B-swap-for-repay";
  if (opts.allowCollateralReleaseForRepay) return "C-collateral-release-assisted";
  // Caller has insufficient repay asset and did not opt into B or C → block at planner level
  throw new BlockedError(
    "INSUFFICIENT_REPAY_ASSET",
    `Wallet holds ${walletBalanceForDebt} of debt asset; repay target is ${repayTarget}.`,
    "Either top up the debt asset, or pass --swap-for-repay --swap-source-asset <symbol>, or --allow-collateral-release-for-repay (canonical safety check required).",
    { observed: walletBalanceForDebt.toString(), threshold: repayTarget.toString() }
  );
}

async function cmdPlan(opts: PlanOpts): Promise<void> {
  const action: Action = "plan";
  try {
    if (!isStacksAddress(opts.wallet)) {
      throw new BlockedError("WALLET_INVALID", "--wallet must be a mainnet Stacks address (SP...).", "Pass --wallet <SP...>.");
    }
    const debtAsset = resolveAsset(opts.debtAsset);

    // Run status read internally for canonical position
    const position = await readZestPosition(opts.wallet, debtAsset);
    if (position.debtAmount == null) {
      throw new BlockedError(
        "INSUFFICIENT_REPAY_ASSET",
        "Could not decode current debt from canonical Zest read.",
        "Run status to inspect the raw position tuple, then re-verify the contract read shape."
      );
    }
    const currentDebt = BigInt(position.debtAmount);
    if (currentDebt === 0n) {
      // Nothing to unwind
      success(action, {
        wallet: opts.wallet,
        debtAsset: debtAsset.symbol,
        position: position as unknown as JsonMap,
        repayPlan: { mode: "A-direct-repay", repayAmount: "0", reason: "No debt outstanding; nothing to unwind." },
      });
      return;
    }

    // Resolve repay target
    const repayTarget = resolveRepayTarget(opts, currentDebt);

    // Wallet balances
    const balances = await readWalletBalances(opts.wallet);
    const walletDebtAssetBalance = balances.perAsset[debtAsset.symbol] ?? 0n;

    // Determine mode (throws BlockedError on INSUFFICIENT_REPAY_ASSET if neither B nor C is opted in)
    const mode = determineMode(opts, walletDebtAssetBalance, repayTarget.amount);

    // Compose ordered legs
    const legs: JsonMap[] = [];

    // Mode B / C swap leg
    if (mode === "B-swap-for-repay") {
      const sourceAsset = resolveAsset(opts.swapSourceAsset);
      legs.push({
        leg: "swap-for-repay",
        primitive: "bitflow-swap-aggregator",
        invocation: `bun run skills/bitflow-swap-aggregator/bitflow-swap-aggregator.ts run --wallet ${opts.wallet} --token-in <resolved-by-aggregator-from-${sourceAsset.symbol}> --token-out <resolved-from-${debtAsset.symbol}> --amount-in <computed-at-run-time> --confirm=SWAP`,
        sourceAsset: sourceAsset.symbol,
        targetAsset: debtAsset.symbol,
        slippageBps: Number(opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS),
        maxQuoteStalenessSeconds: Number(opts.maxQuoteStalenessSeconds ?? DEFAULT_MAX_QUOTE_STALENESS_SECONDS),
        note: "Live quote fetched immediately before broadcast (run path); plan does not pre-fetch to avoid stale quotes.",
      });
    }
    if (mode === "C-collateral-release-assisted") {
      legs.push({
        leg: "collateral-release-pre-repay",
        primitive: "v0-4-market.collateral-remove-redeem",
        invocation: `(call ${MARKET}.${FN_COLLATERAL_REMOVE_REDEEM} ft=<collateral-asset> amount=<bounded-safe> min-underlying=<slippage-protected> receiver=${opts.wallet} price-feeds=<pyth>)`,
        note: "Bounded fallback only; canonical safety read must prove pre-repay release keeps projected HF above floor before broadcast.",
      });
    }

    // Repay leg (always present)
    legs.push({
      leg: "repay",
      primitive: "v0-4-market.repay",
      invocation: `(call ${MARKET}.${FN_REPAY} ft=${debtAsset.underlying} amount=${repayTarget.amount} on-behalf-of=${opts.wallet})`,
      contract: MARKET,
      function: FN_REPAY,
      repayAmount: repayTarget.amount.toString(),
      repayTargetSource: repayTarget.source,
      postConditionMode: "Deny",
      postConditions: debtAsset.symbol === "STX"
        ? [`${opts.wallet} sends <= ${repayTarget.amount} uSTX`]
        : [`${opts.wallet} sends <= ${repayTarget.amount} ${debtAsset.assetName}`],
    });

    // Optional withdraw leg (Mode D)
    if (opts.withdrawCollateral) {
      legs.push({
        leg: "collateral-withdraw",
        primitive: "v0-4-market.collateral-remove-redeem",
        invocation: `(call ${MARKET}.${FN_COLLATERAL_REMOVE_REDEEM} ft=<collateral-asset> amount=${opts.withdrawAmount ?? "<safe-bound-from-post-repay-read>"} min-underlying=<slippage-protected> receiver=${opts.wallet} price-feeds=<pyth>)`,
        contract: MARKET,
        function: FN_COLLATERAL_REMOVE_REDEEM,
        withdrawAmount: opts.withdrawAmount ?? null,
        postConditionMode: "Deny",
        note: "Withdraw amount bounded by canonical post-repay safe-withdrawable read; fresh read required before broadcast.",
      });
    }

    // Risk projection (rough; live scaling refined at run time once observed values seen)
    const projectedDebtAfterRepay = currentDebt - repayTarget.amount;
    const risk = {
      currentHealthFactor: position.healthFactor,
      projectedDebtAfterRepayBaseUnits: projectedDebtAfterRepay.toString(),
      projectedFullClose: projectedDebtAfterRepay === 0n,
      minHealthFactorFloor: Number(opts.minHealthFactor ?? DEFAULT_MIN_HEALTH_FACTOR),
      passesSafetyGate: position.healthFactor == null || position.healthFactor >= Number(opts.minHealthFactor ?? DEFAULT_MIN_HEALTH_FACTOR),
    };

    success(action, {
      wallet: opts.wallet,
      debtAsset: debtAsset.symbol,
      mode,
      position: position as unknown as JsonMap,
      repayPlan: {
        mode,
        repayAmount: repayTarget.amount.toString(),
        repayTargetSource: repayTarget.source,
        debtAsset: debtAsset.symbol,
        walletHasEnoughDebtAsset: mode === "A-direct-repay",
        contractCall: { contractAddress: parseContractId(MARKET).address, contractName: parseContractId(MARKET).name, functionName: FN_REPAY, postConditionMode: "Deny", postConditionsCount: 1 },
      },
      legs,
      risk,
      proofObligations: {
        requiredMainnetTxs: legs.filter((l) => l.leg !== "collateral-release-pre-repay" || l.invocation).length,
        notes: "Each non-read leg above must produce a Hiro tx_status: success at run time. Read legs (status, plan, post-repay-status) must include their JSON output in the PR proof block.",
      },
      nextAction: opts.repayAmount || opts.repayBps || opts.repayAll
        ? `Run with --confirm ${CONFIRM_RUN} to execute mode ${mode}.`
        : "Pass --repay-amount/--repay-bps/--repay-all and re-plan.",
    });
  } catch (err) {
    fail(action, err);
  }
}

// ─── Run helpers ────────────────────────────────────────────────────────────

// Shell-out to the bitflow-swap-aggregator primitive. Composition path per
// `https://github.com/BitflowFinance/bff-skills/issues/483` — never source-import.
// Override via BITFLOW_SWAP_AGGREGATOR_ENTRY env var if the primitive lives elsewhere
// in the runtime environment.
const SWAP_AGGREGATOR_ENTRY_DEFAULT = "skills/bitflow-swap-aggregator/bitflow-swap-aggregator.ts";

function getSwapAggregatorEntry(): string {
  return process.env.BITFLOW_SWAP_AGGREGATOR_ENTRY?.trim() || SWAP_AGGREGATOR_ENTRY_DEFAULT;
}

interface AggregatorJsonOutput {
  status: Status;
  action: string;
  data?: JsonMap;
  error?: JsonMap | null;
}

async function runAggregator(args: string[]): Promise<AggregatorJsonOutput> {
  const entry = getSwapAggregatorEntry();
  const proc = Bun.spawn(["bun", "run", entry, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (!stdout.trim()) {
    throw new Error(`bitflow-swap-aggregator produced no stdout. stderr: ${stderr.slice(0, 400)}`);
  }
  let parsed: AggregatorJsonOutput;
  try {
    parsed = JSON.parse(stdout) as AggregatorJsonOutput;
  } catch (err) {
    throw new Error(`bitflow-swap-aggregator stdout was not JSON: ${stdout.slice(0, 200)}`);
  }
  return parsed;
}

interface AggregatorQuote {
  quoteId: string;
  expectedAmountOut: bigint;
  amountIn: bigint;
  tokenInId: string;
  tokenOutId: string;
  raw: JsonMap;
  fetchedAt: string;
}

function bitflowTokenIdFor(asset: AssetConfig): string {
  // Bitflow aggregator uses token ids of shape `token-<symbol-lower>` for its registry.
  // STX is `token-stx`. For other assets the aggregator's own --search would resolve canonical ids;
  // we pass the lowercased symbol as a hint and rely on the aggregator to error if the id is unknown.
  if (asset.symbol === "STX") return "token-stx";
  if (asset.symbol === "sBTC") return "token-sbtc";
  if (asset.symbol === "stSTX") return "token-ststx";
  if (asset.symbol === "USDC") return "token-USDCx-auto";
  if (asset.symbol === "USDH") return "token-usdh";
  return `token-${asset.symbol.toLowerCase()}`;
}

async function fetchSwapQuote(sourceAsset: AssetConfig, targetAsset: AssetConfig, amountIn: bigint): Promise<AggregatorQuote> {
  const tokenInId = bitflowTokenIdFor(sourceAsset);
  const tokenOutId = bitflowTokenIdFor(targetAsset);
  const result = await runAggregator([
    "quote",
    "--token-in",
    tokenInId,
    "--token-out",
    tokenOutId,
    "--amount-in",
    amountIn.toString(),
  ]);
  if (result.status !== "success") {
    throw new BlockedError(
      "STALE_QUOTE",
      `bitflow-swap-aggregator quote returned status=${result.status}: ${JSON.stringify(result.error ?? result.data ?? {})}`,
      "Inspect aggregator output, verify token ids and the live route."
    );
  }
  const data = result.data ?? {};
  const expectedAmountOutRaw = (data.expectedAmountOut ?? data.amountOut ?? data.minAmountOut) as Json | undefined;
  const expectedAmountOut = expectedAmountOutRaw == null ? 0n : BigInt(String(expectedAmountOutRaw));
  return {
    quoteId: String(data.quoteId ?? data.id ?? ""),
    expectedAmountOut,
    amountIn,
    tokenInId,
    tokenOutId,
    raw: data,
    fetchedAt: new Date().toISOString(),
  };
}

async function broadcastSwapForRepay(wallet: string, sourceAsset: AssetConfig, targetAsset: AssetConfig, amountIn: bigint, slippageBps: number): Promise<{ txid: string; aggregatorOutput: JsonMap }> {
  const tokenInId = bitflowTokenIdFor(sourceAsset);
  const tokenOutId = bitflowTokenIdFor(targetAsset);
  const args = [
    "run",
    "--wallet",
    wallet,
    "--token-in",
    tokenInId,
    "--token-out",
    tokenOutId,
    "--amount-in",
    amountIn.toString(),
    "--slippage-bps",
    String(slippageBps),
    "--confirm=SWAP",
  ];
  const result = await runAggregator(args);
  if (result.status !== "success") {
    throw new BlockedError(
      "AGGREGATOR_BLOCKED",
      `bitflow-swap-aggregator run returned status=${result.status}: ${JSON.stringify(result.error ?? result.data ?? {})}`,
      "Inspect aggregator output and re-run with corrected args, or fall back to a different swap route."
    );
  }
  const data = result.data ?? {};
  const txidRaw = String(data.txid ?? data.tx_id ?? "");
  if (!txidRaw) throw new Error("bitflow-swap-aggregator success output missing txid");
  const txid = txidRaw.startsWith("0x") ? txidRaw : `0x${txidRaw}`;
  return { txid, aggregatorOutput: data };
}

// Pyth price-feeds fetch (mirror of merged borrow primitive helper).
async function fetchPythPriceFeedBytes(assets: AssetConfig[]): Promise<{ bytes: Buffer; feeds: string[] }> {
  const feeds = [...new Set(assets.map((a) => a.pythFeed).filter(Boolean) as string[])];
  if (feeds.length === 0) return { bytes: Buffer.alloc(0), feeds };
  const params = new URLSearchParams();
  params.set("encoding", "hex");
  for (const feed of feeds) params.append("ids[]", feed);
  const payload = await fetchJson<{ binary?: { encoding?: string; data?: string[] } }>(
    `${PYTH_HERMES_API}/v2/updates/price/latest?${params.toString()}`
  );
  const hex = payload.binary?.data?.[0];
  if (!hex || payload.binary?.encoding !== "hex") {
    throw new Error("Pyth Hermes did not return hex update bytes");
  }
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0 || bytes.length > 8192) {
    throw new Error(`Pyth update length ${bytes.length} is outside the V2 market limit`);
  }
  return { bytes, feeds };
}

function buildPriceFeeds(bytes: Buffer) {
  return bytes.length > 0 ? someCV(listCV([bufferCV(bytes)])) : noneCV();
}

function buildWithdrawCollateralPostConditions(wallet: string, collateralAsset: AssetConfig, amount: bigint) {
  // wallet sends <= amount vault-share FT to the market (collateral burn), and
  // wallet receives the underlying via the redeem path. We pin both directions where expressible.
  //
  // The vault-share FT uses the literal SIP-010 fungible-token name "zft" across all
  // Zest v0 vaults (verified via Hiro /v2/contracts/source on v0-vault-sbtc, v0-vault-ststx,
  // v0-vault-usdc, v0-vault-usdh — all four contain `(define-fungible-token zft)`).
  // The user-facing NAME constant differs per vault ("Zest sBTC", "Zest stSTX", etc.)
  // but the on-chain FT identifier passed to postcondition matchers is uniformly "zft".
  const conditions = [];
  if (collateralAsset.vault) {
    conditions.push(
      Pc.principal(wallet)
        .willSendLte(amount)
        .ft(collateralAsset.vault as `${string}.${string}`, "zft")
    );
  }
  // Pyth fee sweep
  conditions.push(Pc.principal(wallet).willSendLte(PYTH_MAX_FEE_USTX).ustx());
  return conditions;
}

async function broadcastCollateralRemoveRedeem(
  wallet: string,
  collateralAsset: AssetConfig,
  amount: bigint,
  minUnderlying: bigint,
  privateKey: string,
  fee: bigint
): Promise<{ txid: string; postConditionCount: number; pythFeeds: string[] }> {
  const market = parseContractId(MARKET);
  const ftToken = parseContractId(collateralAsset.underlying);
  // Pyth feeds for the collateral asset (and any related debt assets) needed for HF check on chain
  const { bytes, feeds } = await fetchPythPriceFeedBytes([collateralAsset]);
  const postConditions = buildWithdrawCollateralPostConditions(wallet, collateralAsset, amount);
  const transaction = await makeContractCall({
    contractAddress: market.address,
    contractName: market.name,
    functionName: FN_COLLATERAL_REMOVE_REDEEM,
    functionArgs: [
      contractPrincipalCV(ftToken.address, ftToken.name),
      uintCV(amount),
      uintCV(minUnderlying),
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
  const result = await broadcastTransaction({ transaction, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`collateral-remove-redeem broadcast failed: ${result.error}${"reason" in result ? ` - ${result.reason}` : ""}`);
  }
  const txid = result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
  return { txid, postConditionCount: postConditions.length, pythFeeds: feeds };
}

function buildRepayPostConditions(wallet: string, debtAsset: AssetConfig, amount: bigint) {
  if (debtAsset.symbol === "STX") {
    return [Pc.principal(wallet).willSendLte(amount).ustx()];
  }
  if (!debtAsset.vault) throw new Error(`Asset ${debtAsset.symbol} missing vault for postcondition`);
  return [
    Pc.principal(wallet)
      .willSendLte(amount)
      .ft(debtAsset.underlying as `${string}.${string}`, debtAsset.assetName),
  ];
}

async function broadcastRepay(
  wallet: string,
  debtAsset: AssetConfig,
  amount: bigint,
  privateKey: string,
  fee: bigint
): Promise<{ txid: string; postConditionCount: number }> {
  const market = parseContractId(MARKET);
  const ftToken = parseContractId(debtAsset.underlying);
  const postConditions = buildRepayPostConditions(wallet, debtAsset, amount);
  const transaction = await makeContractCall({
    contractAddress: market.address,
    contractName: market.name,
    functionName: FN_REPAY,
    functionArgs: [
      contractPrincipalCV(ftToken.address, ftToken.name),
      uintCV(amount),
      someCV(principalCV(wallet)),
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
    postConditions,
    fee,
  });
  const result = await broadcastTransaction({ transaction, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Repay broadcast failed: ${result.error}${"reason" in result ? ` - ${result.reason}` : ""}`);
  }
  const txid = result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
  return { txid, postConditionCount: postConditions.length };
}

async function cmdRun(opts: RunOpts): Promise<void> {
  const action: Action = "run";
  if (opts.confirm !== CONFIRM_RUN) {
    fail(action, new Error(`Refusing to execute: --confirm ${CONFIRM_RUN} is required. Run plan first to inspect the proposed unwind.`));
    return;
  }
  try {
    if (!isStacksAddress(opts.wallet)) {
      throw new BlockedError("WALLET_INVALID", "--wallet must be a mainnet Stacks address (SP...).", "Pass --wallet <SP...>.");
    }
    const debtAsset = resolveAsset(opts.debtAsset);
    await ensureStateDir();

    // Refuse if checkpoint dir shows unresolved unwindId for this wallet
    const existing = await readCheckpointForWallet(opts.wallet);
    if (existing) {
      throw new BlockedError(
        "UNRESOLVED_CHECKPOINT",
        `An unresolved unwind exists for this wallet (unwindId=${existing.unwindId}, state=${existing.state}).`,
        "Run resume to continue, or cancel to mark resolved (operator-acknowledged), before any new unwind.",
        { checkpoint: existing as unknown as JsonMap }
      );
    }

    // Re-read canonical position
    const positionBefore = await readZestPosition(opts.wallet, debtAsset);
    if (positionBefore.debtAmount == null) {
      throw new BlockedError(
        "INSUFFICIENT_REPAY_ASSET",
        "Could not decode current debt from canonical Zest read.",
        "Run status to inspect raw position; verify contract read shape."
      );
    }
    const currentDebt = BigInt(positionBefore.debtAmount);
    if (currentDebt === 0n) {
      success(action, { wallet: opts.wallet, state: "complete", reason: "No debt outstanding; nothing to unwind.", position: positionBefore as unknown as JsonMap });
      return;
    }

    const repayTarget = resolveRepayTarget(opts, currentDebt);
    const balances = await readWalletBalances(opts.wallet);
    const walletDebtAssetBalance = balances.perAsset[debtAsset.symbol] ?? 0n;
    const mode = determineMode(opts, walletDebtAssetBalance, repayTarget.amount);


    // Mempool depth check
    const mempool = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/address/${opts.wallet}/mempool?limit=20`);
    const pending = Number((mempool.results as Json[] | undefined)?.length ?? 0);
    if (pending >= Number(opts.mempoolDepthLimit ?? DEFAULT_MEMPOOL_DEPTH_LIMIT)) {
      throw new BlockedError(
        "PENDING_TX",
        `Wallet has ${pending} pending mempool tx; limit is ${opts.mempoolDepthLimit ?? DEFAULT_MEMPOOL_DEPTH_LIMIT}.`,
        "Wait for pending txs to clear, then re-run."
      );
    }

    const unwindId = generateUnwindId();
    const stamp0 = new Date().toISOString();
    let checkpoint: CheckpointFile = {
      unwindId,
      wallet: opts.wallet,
      state: "unwind_plan_created",
      currentStep: "unwind_plan_created",
      blockedReason: null,
      nextRequiredAction: "broadcast_repay",
      debtAsset: debtAsset.symbol,
      collateralAsset: positionBefore.collateralAsset,
      repayTarget: repayTarget.amount.toString(),
      preRunDebt: currentDebt.toString(),
      preRunCollateral: positionBefore.collateralAmount,
      pendingDepthBeforeEachWrite: { repay: pending },
      timestampPerLeg: { unwind_plan_created: stamp0 },
    };
    await persistCheckpoint(checkpoint);

    // Resolve signer (wallet must be unlocked; either via session or STACKS_PRIVATE_KEY env)
    const signer = await resolveSigner(opts.wallet);
    const transactions: JsonMap[] = [];

    // Mode C — collateral-release-assisted repay (bounded pre-repay release path).
    // Per PRD §Mode C: only if canonical Zest reads prove the specific withdrawal
    // amount is safe AND post-withdraw projected HF stays above floor. Local LTV
    // math alone is insufficient.
    if (mode === "C-collateral-release-assisted") {
      if (!opts.collateralAsset) {
        throw new BlockedError(
          "MISSING_COLLATERAL_ASSET",
          "Mode C requires --collateral-asset <symbol>.",
          "Pass --collateral-asset and --withdraw-amount bounded by safe-withdrawable from status."
        );
      }
      if (!opts.withdrawAmount) {
        throw new BlockedError(
          "UNSAFE_COLLATERAL_WITHDRAWAL",
          "Mode C requires --withdraw-amount as an explicit operator-bounded upper limit on the pre-repay release.",
          "Pass --withdraw-amount <base-units>."
        );
      }
      // Canonical safety gate: projected post-release health factor must remain
      // above min-health-factor floor.
      // Since the canonical reads from readZestPosition do not yet surface a
      // first-class projected-HF helper for the pre-release case, we refuse
      // unless the operator passes --min-health-factor explicitly AND the
      // current health factor is already comfortably above 2x that floor (a
      // conservative proxy: only allow pre-repay release when there's clear
      // headroom). This is intentionally restrictive per PRD.
      const minHF = Number(opts.minHealthFactor ?? DEFAULT_MIN_HEALTH_FACTOR);
      const currentHF = positionBefore.healthFactor;
      if (currentHF == null || !Number.isFinite(currentHF) || currentHF < 2 * minHF) {
        throw new BlockedError(
          "UNSAFE_COLLATERAL_WITHDRAWAL",
          `Mode C requires currentHealthFactor >= 2 x --min-health-factor as a conservative canonical-proxy gate. Observed currentHF=${currentHF}; min-floor=${minHF}.`,
          "Either repay first via Mode A/B, or wait until HF improves, or use Mode D after repay (post-repay withdraw is the safer default)."
        );
      }

      const collateralAsset = resolveAsset(opts.collateralAsset);
      if (!collateralAsset.canCollateral || !collateralAsset.vault) {
        throw new BlockedError(
          "UNSUPPORTED_COLLATERAL_ASSET",
          `${collateralAsset.symbol} is not configured as Zest V2 collateral.`,
          "Choose a Zest V2 collateral asset."
        );
      }
      const requestedWithdraw = (() => {
        if (!/^\d+$/.test(opts.withdrawAmount as string)) throw new Error("--withdraw-amount must be a positive integer in base units");
        return BigInt(opts.withdrawAmount as string);
      })();
      const withdrawSlippageBps = Number(opts.withdrawSlippageBps ?? "150");
      const minUnderlying = (requestedWithdraw * (10000n - BigInt(withdrawSlippageBps))) / 10000n;

      checkpoint = {
        ...checkpoint,
        state: "optional_collateral_withdraw_planned",
        currentStep: "mode_c_pre_repay_collateral_release_planned",
        collateralAsset: collateralAsset.symbol,
        withdrawAmount: requestedWithdraw.toString(),
        minUnderlying: minUnderlying.toString(),
        nextRequiredAction: "broadcast_pre_repay_collateral_release",
        timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), mode_c_planned: new Date().toISOString() },
      };
      await persistCheckpoint(checkpoint);

      const releaseFee = 70_000n;
      const releaseResult = await broadcastCollateralRemoveRedeem(
        opts.wallet,
        collateralAsset,
        requestedWithdraw,
        minUnderlying,
        signer.privateKey,
        releaseFee
      );
      checkpoint = {
        ...checkpoint,
        state: "optional_collateral_withdraw_broadcast",
        currentStep: "mode_c_pre_repay_collateral_release_broadcast",
        withdrawTxId: releaseResult.txid,
        nextRequiredAction: "wait_for_pre_repay_collateral_release",
      };
      await persistCheckpoint(checkpoint);

      const releaseStatus = await waitForTx(releaseResult.txid, Number(opts.waitSeconds ?? DEFAULT_WAIT_SECONDS));
      const releaseTxStatus = String(releaseStatus?.tx_status ?? "unknown");
      if (releaseTxStatus !== "success") {
        checkpoint = {
          ...checkpoint,
          state: "blocked_partial_unwind",
          currentStep: "mode_c_release_failed",
          blockedReason: `pre-repay release tx ${releaseResult.txid} terminal status: ${releaseTxStatus}`,
          nextRequiredAction: "operator_review_then_resume_or_cancel",
        };
        await persistCheckpoint(checkpoint);
        throw new BlockedError(
          "WITHDRAW_TX_NOT_SUCCESS",
          `Mode C pre-repay collateral release txid ${releaseResult.txid} reached terminal status ${releaseTxStatus} on Hiro.`,
          "Inspect the explorer link, then run resume or cancel.",
          { txid: releaseResult.txid, status: releaseTxStatus, explorer: `${EXPLORER}/${releaseResult.txid}?chain=mainnet` }
        );
      }

      checkpoint = {
        ...checkpoint,
        state: "optional_collateral_withdraw_confirmed",
        currentStep: "mode_c_pre_repay_collateral_release_confirmed",
        nextRequiredAction: "broadcast_repay",
      };
      await persistCheckpoint(checkpoint);
      transactions.push({
        leg: "pre-repay-collateral-release",
        txid: releaseResult.txid,
        status: "success",
        explorer: `${EXPLORER}/${releaseResult.txid}?chain=mainnet`,
        contract: MARKET,
        function: FN_COLLATERAL_REMOVE_REDEEM,
        collateralAsset: collateralAsset.symbol,
        withdrawAmount: requestedWithdraw.toString(),
        minUnderlying: minUnderlying.toString(),
        pythFeeds: releaseResult.pythFeeds,
        note: "Pre-repay collateral release for Mode C; only invoked because currentHF >= 2 x min-floor.",
      });
      // After release, wallet should now hold the underlying which can be used for repay.
      // We fall through to the standard repay leg below.
    }

    // ── Mode B: swap-for-repay leg first ───────────────────────────────────
    if (mode === "B-swap-for-repay") {
      const sourceAsset = resolveAsset(opts.swapSourceAsset);
      // Compute amount in source asset terms = repayTarget.amount sized so that
      // expected amount-out >= repayTarget.amount with slippage buffer applied.
      // Strategy: fetch quote at the repay-target amount converted naively (1:1 base-units),
      // then iterate up if the quote's expectedAmountOut falls short. Capped at 1.5x to
      // avoid runaway sizing.
      const slippageBps = Number(opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
      const maxStaleness = Number(opts.maxQuoteStalenessSeconds ?? DEFAULT_MAX_QUOTE_STALENESS_SECONDS);
      let amountIn = repayTarget.amount; // naive baseline; aggregator reports actual out
      let quote = await fetchSwapQuote(sourceAsset, debtAsset, amountIn);
      const minAcceptableOut = (repayTarget.amount * (10000n + BigInt(slippageBps))) / 10000n;
      // If expected-out is below the slippage-buffered repay target, scale amountIn upward
      // by ratio (target / out) clamped to 1.5x.
      if (quote.expectedAmountOut > 0n && quote.expectedAmountOut < minAcceptableOut) {
        const ratio = (minAcceptableOut * 10000n) / quote.expectedAmountOut;
        const scaled = (amountIn * ratio) / 10000n;
        amountIn = scaled > (repayTarget.amount * 15000n) / 10000n ? (repayTarget.amount * 15000n) / 10000n : scaled;
        quote = await fetchSwapQuote(sourceAsset, debtAsset, amountIn);
      }
      if (quote.expectedAmountOut < minAcceptableOut) {
        throw new BlockedError(
          "INSUFFICIENT_REPAY_ASSET",
          `bitflow-swap-aggregator quote at ${amountIn} ${sourceAsset.symbol} expects ${quote.expectedAmountOut} ${debtAsset.symbol} out; repay target needs ${minAcceptableOut} after slippage.`,
          "Top up the source asset, or pass --allow-collateral-release-for-repay (canonical safety check required), or pick a different debt asset."
        );
      }

      checkpoint = {
        ...checkpoint,
        state: "optional_swap_for_repay_planned",
        currentStep: "optional_swap_for_repay_planned",
        nextRequiredAction: "broadcast_swap_for_repay",
        sourceAsset: sourceAsset.symbol,
        quoteId: quote.quoteId,
        quoteTimestamp: quote.fetchedAt,
        timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), optional_swap_for_repay_planned: new Date().toISOString() },
      };
      await persistCheckpoint(checkpoint);

      // Quote freshness check immediately before broadcast (PRD §Swap Requirements).
      const quoteAgeSeconds = Math.floor((Date.now() - new Date(quote.fetchedAt).getTime()) / 1000);
      if (quoteAgeSeconds > maxStaleness) {
        // Fetch a fresh quote
        quote = await fetchSwapQuote(sourceAsset, debtAsset, amountIn);
      }

      const swapResult = await broadcastSwapForRepay(opts.wallet, sourceAsset, debtAsset, amountIn, slippageBps);
      checkpoint = {
        ...checkpoint,
        state: "optional_swap_for_repay_broadcast",
        currentStep: "optional_swap_for_repay_broadcast",
        swapTxId: swapResult.txid,
        nextRequiredAction: "wait_for_swap_confirmation",
        timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), optional_swap_for_repay_broadcast: new Date().toISOString() },
      };
      await persistCheckpoint(checkpoint);

      const swapTxStatus = await waitForTx(swapResult.txid, Number(opts.waitSeconds ?? DEFAULT_WAIT_SECONDS));
      const swapStatus = String(swapTxStatus?.tx_status ?? "unknown");
      if (swapStatus !== "success") {
        checkpoint = {
          ...checkpoint,
          state: "blocked_partial_unwind",
          currentStep: "swap_for_repay_failed",
          blockedReason: `swap tx ${swapResult.txid} terminal status: ${swapStatus}`,
          nextRequiredAction: "operator_review_then_resume_or_cancel",
          timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), blocked_partial_unwind: new Date().toISOString() },
        };
        await persistCheckpoint(checkpoint);
        throw new BlockedError(
          "SWAP_TX_NOT_SUCCESS",
          `Swap-for-repay txid ${swapResult.txid} reached terminal status ${swapStatus} on Hiro (not success).`,
          "Inspect the explorer link, then run resume (after fix) or cancel (acknowledge partial).",
          { txid: swapResult.txid, status: swapStatus, explorer: `${EXPLORER}/${swapResult.txid}?chain=mainnet` }
        );
      }

      checkpoint = {
        ...checkpoint,
        state: "optional_swap_for_repay_confirmed",
        currentStep: "optional_swap_for_repay_confirmed",
        nextRequiredAction: "broadcast_repay",
        timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), optional_swap_for_repay_confirmed: new Date().toISOString() },
      };
      await persistCheckpoint(checkpoint);
      transactions.push({
        leg: "swap-for-repay",
        txid: swapResult.txid,
        status: "success",
        explorer: `${EXPLORER}/${swapResult.txid}?chain=mainnet`,
        contract: "bitflow-swap-aggregator",
        function: "run",
        sourceAsset: sourceAsset.symbol,
        targetAsset: debtAsset.symbol,
        amountIn: amountIn.toString(),
        expectedAmountOut: quote.expectedAmountOut.toString(),
      });

      // Re-read wallet balances; verify wallet now has enough debt asset
      const balancesAfterSwap = await readWalletBalances(opts.wallet);
      const debtBalanceAfterSwap = balancesAfterSwap.perAsset[debtAsset.symbol] ?? 0n;
      if (debtBalanceAfterSwap < repayTarget.amount) {
        checkpoint = {
          ...checkpoint,
          state: "blocked_partial_unwind",
          currentStep: "post_swap_balance_short",
          blockedReason: `Post-swap wallet has ${debtBalanceAfterSwap} ${debtAsset.symbol}; repay target ${repayTarget.amount}.`,
          nextRequiredAction: "operator_review_then_resume_or_cancel",
        };
        await persistCheckpoint(checkpoint);
        throw new BlockedError(
          "INSUFFICIENT_REPAY_ASSET",
          `Post-swap wallet balance ${debtBalanceAfterSwap} ${debtAsset.symbol} below repay target ${repayTarget.amount}.`,
          "Slippage exceeded buffer. Run resume after topping up, or cancel and reconcile."
        );
      }
    }

    // ── Repay leg (Mode A and Mode B both reach here) ──────────────────────
    checkpoint = { ...checkpoint, state: "repay_planned", currentStep: "repay_planned", nextRequiredAction: "broadcast_repay", timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), repay_planned: new Date().toISOString() } };
    await persistCheckpoint(checkpoint);

    // Broadcast repay (single leg for Mode A pure path)
    const fee = 70_000n;
    const broadcastResult = await broadcastRepay(opts.wallet, debtAsset, repayTarget.amount, signer.privateKey, fee);
    checkpoint = {
      ...checkpoint,
      state: "repay_broadcast",
      currentStep: "repay_broadcast",
      repayTxId: broadcastResult.txid,
      nextRequiredAction: "wait_for_repay_confirmation",
      timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), repay_broadcast: new Date().toISOString() },
    };
    await persistCheckpoint(checkpoint);

    // Wait for confirmation
    const txStatus = await waitForTx(broadcastResult.txid, Number(opts.waitSeconds ?? DEFAULT_WAIT_SECONDS));
    const status = String(txStatus?.tx_status ?? "unknown");
    if (status !== "success") {
      checkpoint = {
        ...checkpoint,
        state: "blocked_partial_unwind",
        currentStep: "repay_failed",
        blockedReason: `repay tx ${broadcastResult.txid} terminal status: ${status}`,
        nextRequiredAction: "operator_review_then_resume_or_cancel",
        timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), blocked_partial_unwind: new Date().toISOString() },
      };
      await persistCheckpoint(checkpoint);
      throw new BlockedError(
        "REPAY_TX_NOT_SUCCESS",
        `Repay broadcast txid ${broadcastResult.txid} reached terminal status ${status} on Hiro (not success).`,
        "Inspect the explorer link, then run resume (after fix) or cancel (acknowledge partial).",
        { txid: broadcastResult.txid, status, explorer: `${EXPLORER}/${broadcastResult.txid}?chain=mainnet` }
      );
    }

    checkpoint = {
      ...checkpoint,
      state: "repay_confirmed",
      currentStep: "repay_confirmed",
      nextRequiredAction: "post_repay_position_read",
      timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), repay_confirmed: new Date().toISOString() },
    };
    await persistCheckpoint(checkpoint);

    // Post-repay canonical re-read
    const positionAfter = await readZestPosition(opts.wallet, debtAsset);
    checkpoint = {
      ...checkpoint,
      state: "post_repay_position_read",
      currentStep: "post_repay_position_read",
      postRepayDebt: positionAfter.debtAmount,
      postRepayCollateral: positionAfter.collateralAmount,
      timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), post_repay_position_read: new Date().toISOString() },
    };
    await persistCheckpoint(checkpoint);

    // Append repay leg to transactions ledger
    transactions.push({
      leg: "repay",
      txid: broadcastResult.txid,
      status: "success",
      explorer: `${EXPLORER}/${broadcastResult.txid}?chain=mainnet`,
      contract: MARKET,
      function: FN_REPAY,
    });

    // Mode A or Mode B pure (no post-repay withdraw): complete here
    if (!opts.withdrawCollateral) {
      checkpoint = {
        ...checkpoint,
        state: "complete",
        currentStep: "complete",
        nextRequiredAction: "none",
        timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), complete: new Date().toISOString() },
      };
      await persistCheckpoint(checkpoint);
      success(action, {
        unwindId,
        wallet: opts.wallet,
        state: "complete",
        mode,
        signerSource: signer.source,
        debtAsset: debtAsset.symbol,
        repayAmount: repayTarget.amount.toString(),
        positionBefore: positionBefore as unknown as JsonMap,
        positionAfter: positionAfter as unknown as JsonMap,
        transactions,
        checkpoint: { unwindId, state: "complete", filePath: path.join(STATE_DIR, `${unwindId}.json`) },
      });
      return;
    }

    // ── Mode D: post-repay collateral withdraw via collateral-remove-redeem ─
    if (!opts.collateralAsset) {
      throw new BlockedError(
        "MISSING_COLLATERAL_ASSET",
        "--withdraw-collateral requires --collateral-asset <symbol>.",
        "Pass --collateral-asset (e.g. sBTC) so the planner can pin the FT trait + postcondition."
      );
    }
    const collateralAsset = resolveAsset(opts.collateralAsset);
    if (!collateralAsset.canCollateral || !collateralAsset.vault) {
      throw new BlockedError(
        "UNSUPPORTED_COLLATERAL_ASSET",
        `${collateralAsset.symbol} is not configured as Zest V2 collateral.`,
        "Choose a Zest V2 collateral asset."
      );
    }

    // Withdraw amount: use --withdraw-amount when provided; else cap at the canonical safe upper bound.
    // Without an authoritative safe-withdrawable read, refuse — local LTV math is not authority (PRD §Canonical Zest Read Requirements).
    const requestedWithdraw = opts.withdrawAmount
      ? (() => { if (!/^\d+$/.test(opts.withdrawAmount as string)) throw new Error("--withdraw-amount must be a positive integer in base units"); return BigInt(opts.withdrawAmount as string); })()
      : null;
    if (requestedWithdraw === null) {
      throw new BlockedError(
        "UNSAFE_COLLATERAL_WITHDRAWAL",
        "--withdraw-amount is required for the post-repay withdraw leg in this batch (auto safe-withdrawable computation lands later).",
        "Pass --withdraw-amount <base-units> bounded by the post-repay safe-withdrawable amount you read from status."
      );
    }

    // min-underlying slippage buffer: 1.5% default (positions in stable assets often see <1% slippage)
    const withdrawSlippageBps = Number(opts.withdrawSlippageBps ?? "150");
    const minUnderlying = (requestedWithdraw * (10000n - BigInt(withdrawSlippageBps))) / 10000n;

    checkpoint = {
      ...checkpoint,
      state: "optional_collateral_withdraw_planned",
      currentStep: "optional_collateral_withdraw_planned",
      collateralAsset: collateralAsset.symbol,
      withdrawAmount: requestedWithdraw.toString(),
      minUnderlying: minUnderlying.toString(),
      nextRequiredAction: "broadcast_collateral_withdraw",
      timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), optional_collateral_withdraw_planned: new Date().toISOString() },
    };
    await persistCheckpoint(checkpoint);

    const withdrawResult = await broadcastCollateralRemoveRedeem(
      opts.wallet,
      collateralAsset,
      requestedWithdraw,
      minUnderlying,
      signer.privateKey,
      fee
    );
    checkpoint = {
      ...checkpoint,
      state: "optional_collateral_withdraw_broadcast",
      currentStep: "optional_collateral_withdraw_broadcast",
      withdrawTxId: withdrawResult.txid,
      nextRequiredAction: "wait_for_collateral_withdraw_confirmation",
      timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), optional_collateral_withdraw_broadcast: new Date().toISOString() },
    };
    await persistCheckpoint(checkpoint);

    const withdrawTxStatus = await waitForTx(withdrawResult.txid, Number(opts.waitSeconds ?? DEFAULT_WAIT_SECONDS));
    const withdrawStatus = String(withdrawTxStatus?.tx_status ?? "unknown");
    if (withdrawStatus !== "success") {
      checkpoint = {
        ...checkpoint,
        state: "blocked_partial_unwind",
        currentStep: "collateral_withdraw_failed",
        blockedReason: `withdraw tx ${withdrawResult.txid} terminal status: ${withdrawStatus}`,
        nextRequiredAction: "operator_review_then_resume_or_cancel",
      };
      await persistCheckpoint(checkpoint);
      throw new BlockedError(
        "WITHDRAW_TX_NOT_SUCCESS",
        `Collateral-remove-redeem txid ${withdrawResult.txid} reached terminal status ${withdrawStatus} on Hiro (not success).`,
        "Inspect the explorer link, then run resume (after fix) or cancel (acknowledge partial).",
        { txid: withdrawResult.txid, status: withdrawStatus, explorer: `${EXPLORER}/${withdrawResult.txid}?chain=mainnet` }
      );
    }

    checkpoint = {
      ...checkpoint,
      state: "optional_collateral_withdraw_confirmed",
      currentStep: "optional_collateral_withdraw_confirmed",
      nextRequiredAction: "complete",
      timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), optional_collateral_withdraw_confirmed: new Date().toISOString() },
    };
    await persistCheckpoint(checkpoint);

    transactions.push({
      leg: "collateral-withdraw",
      txid: withdrawResult.txid,
      status: "success",
      explorer: `${EXPLORER}/${withdrawResult.txid}?chain=mainnet`,
      contract: MARKET,
      function: FN_COLLATERAL_REMOVE_REDEEM,
      collateralAsset: collateralAsset.symbol,
      withdrawAmount: requestedWithdraw.toString(),
      minUnderlying: minUnderlying.toString(),
      pythFeeds: withdrawResult.pythFeeds,
    });

    // Final post-withdraw position read
    const positionFinal = await readZestPosition(opts.wallet, debtAsset);
    checkpoint = {
      ...checkpoint,
      state: "complete",
      currentStep: "complete",
      nextRequiredAction: "none",
      timestampPerLeg: { ...(checkpoint.timestampPerLeg as JsonMap), complete: new Date().toISOString() },
    };
    await persistCheckpoint(checkpoint);

    success(action, {
      unwindId,
      wallet: opts.wallet,
      state: "complete",
      mode,
      signerSource: signer.source,
      debtAsset: debtAsset.symbol,
      collateralAsset: collateralAsset.symbol,
      repayAmount: repayTarget.amount.toString(),
      withdrawAmount: requestedWithdraw.toString(),
      positionBefore: positionBefore as unknown as JsonMap,
      positionAfterRepay: positionAfter as unknown as JsonMap,
      positionFinal: positionFinal as unknown as JsonMap,
      transactions,
      checkpoint: { unwindId, state: "complete", filePath: path.join(STATE_DIR, `${unwindId}.json`) },
    });
  } catch (err) {
    fail(action, err);
  }
}

async function verifyTxStatus(txid: string): Promise<{ status: string; raw: JsonMap | null }> {
  try {
    const tx = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/tx/${txid}`);
    return { status: String(tx.tx_status ?? "unknown"), raw: tx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("HTTP 404")) return { status: "not_indexed", raw: null };
    throw err;
  }
}

async function cmdResume(opts: { wallet: string; confirm?: string }): Promise<void> {
  const action: Action = "resume";
  if (opts.confirm !== CONFIRM_RESUME) {
    fail(action, new Error(`Refusing to resume: --confirm ${CONFIRM_RESUME} is required.`));
    return;
  }
  try {
    if (!isStacksAddress(opts.wallet)) {
      throw new BlockedError("WALLET_INVALID", "--wallet must be a mainnet Stacks address (SP...).", "Pass --wallet <SP...>.");
    }
    const checkpoint = await readCheckpointForWallet(opts.wallet);
    if (!checkpoint) {
      success(action, { wallet: opts.wallet, message: "No unresolved unwind for this wallet." });
      return;
    }

    // Refuse resume on terminal failure states; operator must cancel + reconcile manually.
    if (checkpoint.state === "blocked_partial_unwind") {
      throw new BlockedError(
        "UNRESOLVED_CHECKPOINT",
        `Checkpoint is in blocked_partial_unwind: ${checkpoint.blockedReason ?? "unknown reason"}.`,
        "Inspect the saved checkpoint, reconcile any on-chain state via direct primitive calls, then run cancel to mark resolved. Resume is not safe in this state."
      );
    }

    // Refuse to resume from any "planned but not broadcast" state — that means a leg
    // was selected but never hit chain. There is no on-chain reality to advance from.
    // Operator must either re-run the unwind from a clean state or cancel.
    // Per PRD safety: resume must NEVER silently advance past an unbroadcast leg
    // (arc0btc CHANGES_REQUESTED #4240418473 second blocker).
    const PLANNED_BUT_UNBROADCAST_STATES = new Set([
      "unwind_plan_created",
      "optional_swap_for_repay_planned",
      "repay_planned",
      "optional_collateral_withdraw_planned",
      "optional_residual_swap_planned",
    ]);
    if (PLANNED_BUT_UNBROADCAST_STATES.has(String(checkpoint.state))) {
      throw new BlockedError(
        "UNRESOLVED_CHECKPOINT",
        `Checkpoint state is "${checkpoint.state}" — a leg was planned but no broadcast was recorded. Resume cannot advance past an unbroadcast leg.`,
        "Either run cancel to discard this plan and start fresh, or re-run from a fresh wallet state if the leg never actually hit chain.",
        { checkpoint: checkpoint as unknown as JsonMap }
      );
    }

    // Verify chain status of all recorded leg txids matches checkpoint.
    const txVerifications: JsonMap[] = [];
    const txFields: Array<{ field: keyof CheckpointFile; legName: string; broadcastState: string; confirmedState: string }> = [
      { field: "swapTxId" as keyof CheckpointFile, legName: "swap-for-repay", broadcastState: "optional_swap_for_repay_broadcast", confirmedState: "optional_swap_for_repay_confirmed" },
      { field: "repayTxId" as keyof CheckpointFile, legName: "repay", broadcastState: "repay_broadcast", confirmedState: "repay_confirmed" },
      { field: "withdrawTxId" as keyof CheckpointFile, legName: "collateral-withdraw", broadcastState: "optional_collateral_withdraw_broadcast", confirmedState: "optional_collateral_withdraw_confirmed" },
      { field: "residualSwapTxId" as keyof CheckpointFile, legName: "residual-swap", broadcastState: "optional_residual_swap_broadcast", confirmedState: "optional_residual_swap_confirmed" },
    ];
    for (const { field, legName, broadcastState } of txFields) {
      const txid = checkpoint[field];
      const stateClaim = String(checkpoint.state);
      // Refuse if checkpoint claims this leg's broadcast state but no txid is recorded.
      if (stateClaim === broadcastState && (typeof txid !== "string" || txid.length === 0)) {
        throw new BlockedError(
          "CHECKPOINT_CHAIN_DIVERGENCE",
          `Checkpoint state claims ${legName} was broadcast but no txid recorded. Cannot reconcile against chain.`,
          "Run cancel to mark this checkpoint resolved, then reconcile manually if any partial state exists on chain.",
          { state: stateClaim, legName, expectedField: String(field) }
        );
      }
      if (typeof txid === "string" && txid.length > 0) {
        const { status, raw } = await verifyTxStatus(txid);
        txVerifications.push({ leg: legName, txid, observedStatus: status, explorer: `${EXPLORER}/${txid}?chain=mainnet` });
        if (status !== "success") {
          // Recorded leg is not actually success on chain — checkpoint diverged from reality.
          throw new BlockedError(
            "CHECKPOINT_CHAIN_DIVERGENCE",
            `Recorded ${legName} txid ${txid} has chain status ${status} (not success). Checkpoint diverged from reality.`,
            "Cancel this checkpoint and reconcile manually via direct primitive calls — do not auto-resume.",
            { leg: legName, txid, observedStatus: status, raw: raw ?? null }
          );
        }
      }
    }

    // If state was already "complete", just acknowledge.
    if (checkpoint.state === "complete") {
      success(action, { unwindId: checkpoint.unwindId, state: "complete", message: "Checkpoint already complete; no resume needed.", txVerifications });
      return;
    }

    // Canonical on-chain reality check: re-read the wallet's current Zest position.
    // The checkpoint claims success; verify the actual debt has been reduced as planned.
    // If on-chain debt is still ≥ pre-run debt minus repayTarget (allowing for accrued
    // interest), the unwind did NOT actually achieve its objective even if all recorded
    // txids show success — refuse to mark complete.
    let canonicalReadFailed = false;
    let postPosition: ZestPosition | null = null;
    try {
      const debtAssetSymbol = String(checkpoint.debtAsset);
      const debtAsset = resolveAsset(debtAssetSymbol);
      postPosition = await readZestPosition(opts.wallet, debtAsset);
    } catch {
      canonicalReadFailed = true;
    }
    if (!postPosition || postPosition.debtAmount == null) {
      canonicalReadFailed = true;
    }
    if (canonicalReadFailed) {
      throw new BlockedError(
        "CONTRACT_UNREACHABLE",
        "Cannot read canonical Zest position to verify on-chain debt state. Resume refuses to mark complete without canonical confirmation.",
        "Retry when the canonical Zest read endpoint is reachable.",
        { txVerifications }
      );
    }

    const observedDebt = BigInt((postPosition as ZestPosition).debtAmount as string);
    const preRunDebtRecorded = checkpoint.preRunDebt != null ? BigInt(String(checkpoint.preRunDebt)) : null;
    const repayTargetRecorded = checkpoint.repayTarget != null ? BigInt(String(checkpoint.repayTarget)) : null;
    if (preRunDebtRecorded != null && repayTargetRecorded != null) {
      const expectedMaxDebt = preRunDebtRecorded > repayTargetRecorded ? preRunDebtRecorded - repayTargetRecorded : 0n;
      // Allow a small accrued-interest buffer (1% of the original debt or 1000 base units, whichever larger).
      const interestBuffer = preRunDebtRecorded / 100n > 1000n ? preRunDebtRecorded / 100n : 1000n;
      if (observedDebt > expectedMaxDebt + interestBuffer) {
        throw new BlockedError(
          "CHECKPOINT_CHAIN_DIVERGENCE",
          `Recorded legs show success but canonical Zest read still shows debt ${observedDebt.toString()} (expected max ≤ ${(expectedMaxDebt + interestBuffer).toString()} after repaying ${repayTargetRecorded.toString()} of pre-run ${preRunDebtRecorded.toString()}). Unwind did not achieve repay target.`,
          "Inspect the leg txids against explorer; if any leg silently failed, run cancel and reconcile manually. Do not auto-mark complete.",
          { observedDebt: observedDebt.toString(), preRunDebt: preRunDebtRecorded.toString(), repayTarget: repayTargetRecorded.toString(), interestBuffer: interestBuffer.toString(), txVerifications }
        );
      }
    }

    // All checks passed: legs broadcast and confirmed, canonical debt reduced as planned.
    const advanced: CheckpointFile = {
      ...checkpoint,
      state: "complete",
      currentStep: "complete",
      nextRequiredAction: "none",
      observedPostDebt: observedDebt.toString(),
      timestampPerLeg: { ...((checkpoint.timestampPerLeg as JsonMap) ?? {}), resume_complete: new Date().toISOString() },
    };
    await persistCheckpoint(advanced);

    success(action, {
      unwindId: checkpoint.unwindId,
      wallet: opts.wallet,
      previousState: checkpoint.state,
      newState: "complete",
      message: "All recorded legs verified success on chain AND canonical debt state confirms target achieved. Checkpoint advanced to complete.",
      observedPostDebt: observedDebt.toString(),
      txVerifications,
    });
  } catch (err) {
    fail(action, err);
  }
}

async function cmdCancel(opts: { wallet: string; confirm?: string }): Promise<void> {
  const action: Action = "cancel";
  if (opts.confirm !== CONFIRM_CANCEL) {
    fail(action, new Error(`Refusing to cancel: --confirm ${CONFIRM_CANCEL} is required.`));
    return;
  }
  try {
    if (!isStacksAddress(opts.wallet)) {
      throw new BlockedError("WALLET_INVALID", "--wallet must be a mainnet Stacks address (SP...).", "Pass --wallet <SP...>.");
    }
    const checkpoint = await readCheckpointForWallet(opts.wallet);
    if (!checkpoint) {
      success(action, { wallet: opts.wallet, message: "No unresolved unwind for this wallet." });
      return;
    }

    // Operator-acknowledged resolution. No on-chain action. Mark checkpoint as cancelled.
    const cancelled: CheckpointFile = {
      ...checkpoint,
      state: "complete",
      currentStep: "cancelled",
      blockedReason: checkpoint.blockedReason ?? null,
      nextRequiredAction: "none",
      cancelled: true,
      cancelledAt: new Date().toISOString(),
    };
    await persistCheckpoint(cancelled);

    success(action, {
      unwindId: checkpoint.unwindId,
      wallet: opts.wallet,
      previousState: checkpoint.state,
      newState: "complete-cancelled",
      message: "Checkpoint marked cancelled. No on-chain action taken. Reconcile any partial on-chain state manually via direct primitive calls.",
    });
  } catch (err) {
    fail(action, err);
  }
}

// ─── Commander setup ────────────────────────────────────────────────────────

const program = new Command();

program
  .name("sbtc-leverage-unwind-planner")
  .description(
    "Composed write skill that safely reduces or closes a leveraged sBTC position. PRD: https://github.com/BitflowFinance/bff-skills/issues/562"
  );

const walletOpt = (cmd: Command) =>
  cmd.requiredOption("--wallet <stacks-address>", "Wallet that owns the position and signs writes");

const debtAssetOpt = (cmd: Command) =>
  cmd.requiredOption("--debt-asset <symbol>", "Debt asset to repay (e.g., STX)");

const planFlags = (cmd: Command) =>
  cmd
    .option("--repay-amount <base-units>", "Exact repay amount (mutually exclusive with --repay-bps / --repay-all)")
    .option("--repay-bps <bps>", "Percentage of current debt to repay (basis points)")
    .option("--repay-all", "Close the debt when feasible")
    .option("--swap-for-repay", "Permit swap of free wallet assets to acquire repayment asset")
    .option("--swap-source-asset <symbol>", "Asset to swap into repayment asset (required with --swap-for-repay)")
    .option("--allow-collateral-release-for-repay", "Permit bounded pre-repay collateral release only if canonical reads prove it safe")
    .option("--collateral-asset <symbol>", "Collateral asset to withdraw (required with --withdraw-collateral)")
    .option("--withdraw-collateral", "Withdraw safe collateral after repay")
    .option("--withdraw-amount <base-units>", "Requested collateral withdrawal amount")
    .option("--withdraw-slippage-bps <bps>", "Slippage tolerance for collateral redeem (basis points)", "150")
    .option("--max-quote-staleness-seconds <seconds>", "Maximum quote age before swap broadcast", String(DEFAULT_MAX_QUOTE_STALENESS_SECONDS))
    .option("--slippage-bps <bps>", "Minimum-output tolerance for swap leg", String(DEFAULT_SLIPPAGE_BPS))
    .option("--min-health-factor <value>", "Minimum projected health factor after each leg", String(DEFAULT_MIN_HEALTH_FACTOR))
    .option("--max-ltv-bps <bps>", "Maximum allowed LTV after every leg")
    .option("--min-gas-reserve-ustx <uSTX>", "Required gas reserve before each write", String(DEFAULT_MIN_GAS_RESERVE_USTX))
    .option("--mempool-depth-limit <count>", "Pending sender transaction limit before each write", String(DEFAULT_MEMPOOL_DEPTH_LIMIT))
    .option("--wait-seconds <seconds>", "Confirmation wait window", String(DEFAULT_WAIT_SECONDS));

walletOpt(program.command("doctor").description("Read-only environment + dependency check")).action(cmdDoctor);

debtAssetOpt(walletOpt(program.command("status").description("Read-only canonical Zest position read"))).action(cmdStatus);

planFlags(debtAssetOpt(walletOpt(program.command("plan").description("Propose unwind plan without broadcasting")))).action(cmdPlan);

planFlags(debtAssetOpt(walletOpt(program.command("run").description(`Execute unwind after --confirm ${CONFIRM_RUN}`))))
  .option("--confirm <token>", `Required: pass ${CONFIRM_RUN} to confirm execution`)
  .action(cmdRun);

walletOpt(program.command("resume").description("Resume an unresolved unwind from checkpoint"))
  .option("--confirm <token>", `Required: pass ${CONFIRM_RESUME} to confirm`)
  .action(cmdResume);

walletOpt(program.command("cancel").description("Cancel an unresolved unwind (operator-acknowledged)"))
  .option("--confirm <token>", `Required: pass ${CONFIRM_CANCEL} to confirm`)
  .action(cmdCancel);

program.parseAsync().catch((err) => fail("doctor", err));
