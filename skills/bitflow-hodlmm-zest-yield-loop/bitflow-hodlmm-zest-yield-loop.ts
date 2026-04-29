#!/usr/bin/env bun

import { spawn } from "child_process";
import { Command } from "commander";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";
type SourceVenue = "auto" | "hodlmm" | "zest" | "idle";
type TargetVenue = "auto" | "hodlmm" | "zest";
type Route =
  | "hold"
  | "hodlmm-rebalance"
  | "hodlmm-to-zest"
  | "zest-to-hodlmm"
  | "idle-to-hodlmm";
type Step =
  | "idle"
  | "hodlmm_withdraw_confirmed"
  | "zest_withdraw_confirmed"
  | "hodlmm_deposit_confirmed"
  | "rebalance_confirmed"
  | "complete"
  | "blocked_partial_route"
  | "operator_cancelled";

interface Primitive {
  name: string;
  entry: string | null;
  requiredFor: string;
  source: string;
  sourceUrl: string;
}

interface PrimitiveResult {
  status?: string;
  action?: string;
  data?: JsonMap;
  error?: JsonMap | string | null;
}

interface Checkpoint {
  version: number;
  routeId: string;
  wallet: string;
  route: Route;
  step: Step;
  source: SourceVenue;
  target: TargetVenue;
  amountSummary: JsonMap;
  createdAt: string;
  updatedAt: string;
  txids: string[];
  nextRequiredAction?: string;
  abortReason?: string;
}

interface SharedOptions {
  wallet?: string;
  source?: SourceVenue;
  target?: TargetVenue;
  poolId?: string;
  binId?: string;
  binIds?: string;
  offsets?: string;
  range?: string;
  amountSats?: string;
  amountX?: string;
  amountY?: string;
  sbtcSide?: "auto" | "x" | "y";
  withdrawBps?: string;
  minApyEdgeBps?: string;
  maxDataAgeSeconds?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  slippageBps?: string;
  waitSeconds?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
}

interface RoutePlan {
  route: Route;
  reason: string;
  executable: boolean;
  blockers: JsonMap[];
  steps: JsonMap[];
}

const SKILL_NAME = "bitflow-hodlmm-zest-yield-loop";
const CONFIRM_TOKEN = "ROUTE";
const HIRO_API = "https://api.mainnet.hiro.so";
const BITFLOW_APP_POOLS_API = "https://bff.bitflowapis.finance/api/app/v1/pools";
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const DEFAULT_WITHDRAW_BPS = "10000";
const DEFAULT_MIN_APY_EDGE_BPS = "25";
const DEFAULT_MAX_DATA_AGE_SECONDS = "120";
const DEFAULT_MIN_GAS_RESERVE_USTX = "500000";
const DEFAULT_MEMPOOL_DEPTH_LIMIT = "0";
const DEFAULT_SLIPPAGE_BPS = "100";
const DEFAULT_WAIT_SECONDS = "240";
const PRIMITIVES: Array<Omit<Primitive, "entry">> = [
  {
    name: "bitflow-hodlmm-withdraw",
    requiredFor: "HODLMM selected-bin exit leg",
    source: "Accepted BFF primitive from #551, required by #559 PRD",
    sourceUrl: "https://github.com/BitflowFinance/bff-skills/pull/551",
  },
  {
    name: "bitflow-hodlmm-deposit",
    requiredFor: "HODLMM selected-bin entry leg",
    source: "Accepted BFF primitive from #556, required by #559 PRD",
    sourceUrl: "https://github.com/BitflowFinance/bff-skills/pull/556",
  },
  {
    name: "hodlmm-move-liquidity",
    requiredFor: "HODLMM in-protocol rebalance leg",
    source: "Existing AIBTC-listed skill named in #559 PRD",
    sourceUrl: "https://aibtc.com/skills",
  },
  {
    name: "zest-yield-manager",
    requiredFor: "Zest position status and legacy supply/withdraw handoff",
    source: "Existing AIBTC-listed Zest skill surface named in #559 PRD",
    sourceUrl: "https://aibtc.com/skills",
  },
];

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
  output("error", action, {}, { code: "ERROR", message, next: "Run doctor and inspect the failing dependency before retrying." });
  process.exitCode = 1;
}

function repoRoot(): string {
  return process.env.AIBTC_SKILLS_ROOT || process.cwd();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePrimitive(name: string, requiredFor: string, source: string, sourceUrl: string): Promise<Primitive> {
  const root = repoRoot();
  const candidates = [
    path.join("skills", name, `${name}.ts`),
    path.join(name, `${name}.ts`),
  ];
  for (const candidate of candidates) {
    if (await exists(path.join(root, candidate))) return { name, entry: candidate, requiredFor, source, sourceUrl };
  }
  return { name, entry: null, requiredFor, source, sourceUrl };
}

async function dependencyReport(): Promise<Primitive[]> {
  return Promise.all(PRIMITIVES.map((primitive) => resolvePrimitive(primitive.name, primitive.requiredFor, primitive.source, primitive.sourceUrl)));
}

function primitiveByName(dependencies: Primitive[], name: string): Primitive {
  const primitive = dependencies.find((dependency) => dependency.name === name);
  if (!primitive?.entry) throw new BlockedError("MISSING_PRIMITIVE", `${name} is not installed.`, "Merge or install the missing primitive skill.", { primitive: name });
  return primitive;
}

function missingDependencies(dependencies: Primitive[]): Primitive[] {
  return dependencies.filter((dependency) => !dependency.entry);
}

function ensureWallet(wallet?: string): string {
  if (!wallet) throw new Error("--wallet is required");
  return wallet;
}

function ensurePool(poolId?: string): string {
  if (!poolId) throw new BlockedError("POOL_ID_REQUIRED", "--pool-id is required for HODLMM route legs.", "Re-run with --pool-id <pool-id>.");
  return poolId;
}

function ensurePositiveInteger(value: string | undefined, flag: string): string {
  if (!value || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new BlockedError("AMOUNT_REQUIRED", `${flag} is required and must be a positive integer.`, `Re-run with ${flag} <amount>.`);
  }
  return value;
}

function checkpointDir(): string {
  return path.join(os.homedir(), ".aibtc", "state", SKILL_NAME);
}

function checkpointPath(wallet: string): string {
  const safeWallet = wallet.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(checkpointDir(), `${safeWallet}.json`);
}

function checkpointDisplayPath(wallet: string): string {
  const safeWallet = wallet.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `~/.aibtc/state/${SKILL_NAME}/${safeWallet}.json`;
}

async function readCheckpoint(wallet: string): Promise<Checkpoint | null> {
  try {
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath(wallet), "utf8")) as Partial<Checkpoint>;
    if (checkpoint.version !== 1 || checkpoint.wallet !== wallet || typeof checkpoint.step !== "string") {
      return null;
    }
    return checkpoint as Checkpoint;
  } catch {
    return null;
  }
}

async function writeCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
  await fs.mkdir(checkpointDir(), { recursive: true });
  const updated = { ...checkpoint, updatedAt: new Date().toISOString() };
  await fs.writeFile(checkpointPath(checkpoint.wallet), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

function newCheckpoint(wallet: string, plan: RoutePlan, opts: SharedOptions): Checkpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    routeId: `route-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    wallet,
    route: plan.route,
    step: "idle",
    source: opts.source || "auto",
    target: opts.target || "auto",
    amountSummary: {
      amountSats: opts.amountSats || null,
      amountX: opts.amountX || null,
      amountY: opts.amountY || null,
      withdrawBps: opts.withdrawBps || DEFAULT_WITHDRAW_BPS,
      poolId: opts.poolId || null,
      binId: opts.binId || null,
      binIds: opts.binIds || null,
      offsets: opts.offsets || null,
      range: opts.range || null,
    },
    createdAt: now,
    updatedAt: now,
    txids: [],
  };
}

function unresolved(checkpoint: Checkpoint | null): boolean {
  return !!checkpoint && !["complete", "operator_cancelled"].includes(checkpoint.step);
}

async function fetchJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/bitflow-hodlmm-zest-yield-loop" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getStxBalance(wallet: string): Promise<string> {
  const data = await fetchJson<{ balance?: string; locked?: string }>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  const balance = BigInt(data.balance || "0");
  const locked = BigInt(data.locked || "0");
  return (balance > locked ? balance - locked : 0n).toString();
}

async function getMempoolDepth(wallet: string): Promise<number> {
  const data = await fetchJson<{ total?: number; results?: unknown[] }>(`${HIRO_API}/extended/v1/tx/mempool?sender_address=${encodeURIComponent(wallet)}&limit=50`);
  if (typeof data.total === "number") return data.total;
  return Array.isArray(data.results) ? data.results.length : 0;
}

function primitiveEnv(wallet: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NETWORK: process.env.NETWORK || "mainnet",
    STACKS_ADDRESS: wallet,
    STX_ADDRESS: wallet,
  };
}

function runPrimitive(entry: string, subcommand: string, args: string[], wallet: string, timeoutMs = 180_000): Promise<PrimitiveResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", entry, subcommand, ...args], {
      cwd: repoRoot(),
      env: primitiveEnv(wallet),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BlockedError("PRIMITIVE_TIMEOUT", `Primitive ${path.basename(entry)} timed out.`, "Inspect the dependency primitive and retry after it can return JSON promptly.", { subcommand, timeoutMs }));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new BlockedError("NO_PRIMITIVE_OUTPUT", `Primitive ${path.basename(entry)} did not print JSON.`, "Fix the dependency primitive before composing it.", { code: code ?? -1, stderr: stderr.slice(0, 1000) }));
        return;
      }
      let parsed: PrimitiveResult;
      try {
        parsed = JSON.parse(trimmed) as PrimitiveResult;
      } catch {
        reject(new BlockedError("INVALID_PRIMITIVE_OUTPUT", `Primitive ${path.basename(entry)} did not return one JSON object.`, "Fix the dependency primitive before composing it.", { code: code ?? -1, stdout: trimmed.slice(0, 1000), stderr: stderr.slice(0, 1000) }));
        return;
      }
      if (!parsed.status && parsed.error) {
        parsed = { ...parsed, status: "error" };
      }
      if (code !== 0 && parsed.status !== "blocked" && parsed.status !== "error") {
        parsed = { ...parsed, status: "error", error: { code: "PRIMITIVE_EXIT_NONZERO", message: `Primitive exited with code ${code}.`, stderr: stderr.slice(0, 1000) } };
      }
      resolve(parsed);
    });
  });
}

function requirePrimitiveSuccess(name: string, result: PrimitiveResult): void {
  if (result.status !== "success") {
    throw new BlockedError(
      "PRIMITIVE_BLOCKED",
      `${name} did not return success.`,
      "Resolve the primitive blocker before continuing the route.",
      { primitive: name, result: result as JsonMap }
    );
  }
}

function extractTxid(result: PrimitiveResult): string | null {
  const data = result.data || {};
  const proof = data.proof as JsonMap | undefined;
  const direct = data.txid || proof?.txid;
  if (typeof direct === "string") return direct;
  const broadcast = data.broadcast as JsonMap | undefined;
  return typeof broadcast?.txid === "string" ? broadcast.txid : null;
}

function selectorArgs(opts: SharedOptions): string[] {
  const args: string[] = [];
  if (opts.binId) args.push("--bin-id", opts.binId);
  if (opts.binIds) args.push("--bin-ids", opts.binIds);
  if (opts.offsets) args.push("--offsets", opts.offsets);
  if (opts.range) args.push("--range", opts.range);
  return args;
}

function sharedHodlmmArgs(wallet: string, opts: SharedOptions): string[] {
  return [
    "--wallet", wallet,
    "--pool-id", ensurePool(opts.poolId),
    ...selectorArgs(opts),
    "--slippage-bps", opts.slippageBps || DEFAULT_SLIPPAGE_BPS,
    "--min-gas-reserve-ustx", opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX,
  ];
}

function withdrawArgs(wallet: string, opts: SharedOptions): string[] {
  const args = [
    "--wallet", wallet,
    "--pool-id", ensurePool(opts.poolId),
    "--withdraw-bps", opts.withdrawBps || DEFAULT_WITHDRAW_BPS,
    "--slippage-bps", opts.slippageBps || DEFAULT_SLIPPAGE_BPS,
    "--min-gas-reserve-ustx", opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX,
  ];
  if (opts.binId) args.push("--bin-id", opts.binId);
  if (opts.binIds) args.push("--bin-ids", opts.binIds);
  if (!opts.binId && !opts.binIds) args.push("--all-bins");
  return args;
}

async function detectSbtcSide(poolId: string): Promise<"x" | "y"> {
  const data = await fetchJson<{ data?: Array<{ poolId?: string; tokens?: { tokenX?: { contract?: string }; tokenY?: { contract?: string } } }> }>(BITFLOW_APP_POOLS_API);
  const pool = (data.data || []).find((entry) => entry.poolId === poolId);
  if (!pool) throw new BlockedError("POOL_METADATA_NOT_FOUND", `Pool ${poolId} was not found in Bitflow metadata.`, "Verify --pool-id and retry.");
  if (pool.tokens?.tokenX?.contract === SBTC_CONTRACT) return "x";
  if (pool.tokens?.tokenY?.contract === SBTC_CONTRACT) return "y";
  throw new BlockedError("POOL_NOT_SBTC", `Pool ${poolId} does not expose sBTC as token X or token Y.`, "Choose an sBTC HODLMM pool for this router.");
}

async function depositArgs(wallet: string, opts: SharedOptions): Promise<string[]> {
  const poolId = ensurePool(opts.poolId);
  let amountX = opts.amountX || "0";
  let amountY = opts.amountY || "0";
  if (!opts.amountX && !opts.amountY) {
    const amountSats = ensurePositiveInteger(opts.amountSats, "--amount-sats");
    const side = opts.sbtcSide && opts.sbtcSide !== "auto" ? opts.sbtcSide : await detectSbtcSide(poolId);
    if (side === "x") amountX = amountSats;
    if (side === "y") amountY = amountSats;
  }
  if (BigInt(amountX) <= 0n && BigInt(amountY) <= 0n) {
    throw new BlockedError("DEPOSIT_AMOUNT_REQUIRED", "A HODLMM deposit route needs a positive amount.", "Pass --amount-sats, --amount-x, or --amount-y.");
  }
  return [
    ...sharedHodlmmArgs(wallet, opts),
    "--amount-x", amountX,
    "--amount-y", amountY,
  ];
}

function moveArgs(wallet: string, opts: SharedOptions, confirmed: boolean): string[] {
  const args = ["--wallet", wallet, "--pool", ensurePool(opts.poolId)];
  if (opts.range) args.push("--spread", opts.range.replace(":", ""));
  if (confirmed) args.push("--confirm");
  return args;
}

function zestStatusArgs(): string[] {
  return ["--action=status"];
}

function chooseRoute(opts: SharedOptions): RoutePlan {
  const source = opts.source || "auto";
  const target = opts.target || "auto";
  const blockers: JsonMap[] = [];
  if (source === "auto" || target === "auto") {
    return {
      route: "hold",
      reason: "Automatic venue selection is intentionally conservative in this version; pass explicit --source and --target.",
      executable: false,
      blockers: [{ code: "EXPLICIT_ROUTE_REQUIRED", source, target }],
      steps: [],
    };
  }
  if (source === "idle" && target === "hodlmm") {
    return {
      route: "idle-to-hodlmm",
      reason: "Deploy idle sBTC-side wallet balance into selected HODLMM bins.",
      executable: true,
      blockers,
      steps: [{ step: "hodlmm-deposit", primitive: "bitflow-hodlmm-deposit", confirmation: "DEPOSIT" }],
    };
  }
  if (source === "hodlmm" && target === "zest") {
    return {
      route: "hodlmm-to-zest",
      reason: "Exit selected HODLMM bins, then supply resulting sBTC to Zest.",
      executable: false,
      blockers: [{ code: "ZEST_CONFIRMED_WRITE_NOT_VERIFIED", message: "The PRD names Zest supply/withdraw as required route legs. The installed Zest surface must produce a confirmed tx result before this controller can execute that leg." }],
      steps: [
        { step: "hodlmm-withdraw", primitive: "bitflow-hodlmm-withdraw", confirmation: "EXIT" },
        { step: "zest-supply", primitive: "zest-yield-manager", status: "blocked-before-write" },
      ],
    };
  }
  if (source === "zest" && target === "hodlmm") {
    return {
      route: "zest-to-hodlmm",
      reason: "Withdraw supplied sBTC from Zest, then deposit into selected HODLMM bins.",
      executable: false,
      blockers: [{ code: "ZEST_CONFIRMED_WRITE_NOT_VERIFIED", message: "The PRD names Zest supply/withdraw as required route legs. The installed Zest surface must produce a confirmed tx result before this controller can execute that leg." }],
      steps: [
        { step: "zest-withdraw", primitive: "zest-yield-manager", status: "blocked-before-write" },
        { step: "hodlmm-deposit", primitive: "bitflow-hodlmm-deposit", confirmation: "DEPOSIT" },
      ],
    };
  }
  if (source === "hodlmm" && target === "hodlmm") {
    return {
      route: "hodlmm-rebalance",
      reason: "Recenter existing HODLMM liquidity with the existing move-liquidity primitive.",
      executable: false,
      blockers: [{ code: "REBALANCE_CONFIRMATION_SHAPE_UNRESOLVED", message: "The PRD names hodlmm-move-liquidity as the existing rebalance primitive. The controller must resolve its confirmation/signer shape before executing it." }],
      steps: [{ step: "hodlmm-move-liquidity", primitive: "hodlmm-move-liquidity", status: "dry-run-only-in-controller-v1" }],
    };
  }
  return {
    route: "hold",
    reason: `Unsupported route source=${source} target=${target}.`,
    executable: false,
    blockers: [{ code: "UNSUPPORTED_ROUTE", source, target }],
    steps: [],
  };
}

function routeUsesHodlmm(route: Route): boolean {
  return ["hodlmm-rebalance", "hodlmm-to-zest", "zest-to-hodlmm", "idle-to-hodlmm"].includes(route);
}

async function dependencyReadiness(dependencies: Primitive[], wallet: string, opts: SharedOptions): Promise<JsonMap> {
  const readiness: JsonMap = {};
  for (const dependency of dependencies) {
    if (!dependency.entry) {
      readiness[dependency.name] = { status: "missing", requiredFor: dependency.requiredFor };
      continue;
    }
    try {
      if (dependency.name === "zest-yield-manager") {
        readiness[dependency.name] = (await runPrimitive(dependency.entry, "doctor", [], wallet, 90_000)) as JsonMap;
      } else if (dependency.name === "hodlmm-move-liquidity") {
        readiness[dependency.name] = (await runPrimitive(dependency.entry, "doctor", ["--wallet", wallet], wallet, 90_000)) as JsonMap;
      } else if (opts.poolId) {
        readiness[dependency.name] = (await runPrimitive(dependency.entry, "doctor", ["--wallet", wallet, "--pool-id", opts.poolId], wallet, 90_000)) as JsonMap;
      } else {
        readiness[dependency.name] = { status: "skipped", reason: "--pool-id not provided" };
      }
    } catch (error) {
      readiness[dependency.name] = {
        status: "blocked",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return readiness;
}

async function routePreview(route: Route, dependencies: Primitive[], wallet: string, opts: SharedOptions): Promise<JsonMap> {
  const preview: JsonMap = {};
  if (route === "idle-to-hodlmm" || route === "zest-to-hodlmm") {
    const deposit = primitiveByName(dependencies, "bitflow-hodlmm-deposit");
    preview.hodlmmDeposit = (await runPrimitive(deposit.entry!, "status", await depositArgs(wallet, opts), wallet)) as JsonMap;
  }
  if (route === "hodlmm-to-zest") {
    const withdraw = primitiveByName(dependencies, "bitflow-hodlmm-withdraw");
    preview.hodlmmWithdraw = (await runPrimitive(withdraw.entry!, "status", withdrawArgs(wallet, opts), wallet)) as JsonMap;
  }
  if (route === "hodlmm-rebalance") {
    const move = primitiveByName(dependencies, "hodlmm-move-liquidity");
    preview.hodlmmMove = (await runPrimitive(move.entry!, "run", moveArgs(wallet, opts, false), wallet)) as JsonMap;
  }
  if (route === "hodlmm-to-zest" || route === "zest-to-hodlmm") {
    const zest = primitiveByName(dependencies, "zest-yield-manager");
    preview.zestStatus = (await runPrimitive(zest.entry!, "run", zestStatusArgs(), wallet, 90_000)) as JsonMap;
  }
  return preview;
}

async function routeContext(opts: SharedOptions): Promise<JsonMap> {
  const wallet = ensureWallet(opts.wallet);
  const [stxBalanceUstx, mempoolDepth] = await Promise.all([
    getStxBalance(wallet).catch((error) => `error:${error instanceof Error ? error.message : String(error)}`),
    getMempoolDepth(wallet).catch(() => -1),
  ]);
  const mempoolLimit = Number(opts.mempoolDepthLimit || DEFAULT_MEMPOOL_DEPTH_LIMIT);
  const gasOk = /^\d+$/.test(stxBalanceUstx) ? BigInt(stxBalanceUstx) >= BigInt(opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX) : false;
  return {
    wallet,
    stxBalanceUstx,
    minGasReserveUstx: opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX,
    gasOk,
    mempoolDepth,
    mempoolDepthLimit: mempoolLimit,
    mempoolOk: mempoolDepth >= 0 && mempoolDepth <= mempoolLimit,
    stateFile: checkpointDisplayPath(wallet),
    routeConfig: {
      source: opts.source || "auto",
      target: opts.target || "auto",
      poolId: opts.poolId || null,
      amountSats: opts.amountSats || null,
      minApyEdgeBps: opts.minApyEdgeBps || DEFAULT_MIN_APY_EDGE_BPS,
      maxDataAgeSeconds: opts.maxDataAgeSeconds || DEFAULT_MAX_DATA_AGE_SECONDS,
    },
  };
}

function collectPreviewBlockers(preview: JsonMap): JsonMap[] {
  const blockers: JsonMap[] = [];
  for (const [name, value] of Object.entries(preview)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const result = value as PrimitiveResult;
    if (result.status && result.status !== "success") {
      blockers.push({
        code: "PRIMITIVE_PREVIEW_BLOCKED",
        primitive: name,
        status: result.status,
        error: stringify(result.error || null),
      });
    }
  }
  return blockers;
}

function collectReadinessBlockers(readiness: JsonMap): JsonMap[] {
  const blockers: JsonMap[] = [];
  for (const [name, value] of Object.entries(readiness)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const result = value as PrimitiveResult;
    if (result.status === "blocked" || result.status === "error") {
      blockers.push({
        code: "PRIMITIVE_READINESS_BLOCKED",
        primitive: name,
        status: result.status,
        error: stringify(result.error || null),
      });
    }
  }
  return blockers;
}

async function buildPlan(opts: SharedOptions, includePreview: boolean): Promise<{ wallet: string; dependencies: Primitive[]; checkpoint: Checkpoint | null; plan: RoutePlan; preview: JsonMap; context: JsonMap }> {
  const wallet = ensureWallet(opts.wallet);
  const dependencies = await dependencyReport();
  const checkpoint = await readCheckpoint(wallet);
  const plan = chooseRoute(opts);
  const context = await routeContext(opts);
  let canPreview = includePreview && plan.route !== "hold";
  const missing = missingDependencies(dependencies);
  if (missing.length > 0) {
    plan.executable = false;
    plan.blockers.push({ code: "MISSING_PRIMITIVE_DEPENDENCIES", missing: missing as unknown as Json });
    canPreview = false;
  }
  if (context.gasOk === false) {
    plan.executable = false;
    plan.blockers.push({ code: "INSUFFICIENT_GAS_RESERVE", stxBalanceUstx: context.stxBalanceUstx, minGasReserveUstx: context.minGasReserveUstx });
  }
  if (context.mempoolOk === false) {
    plan.executable = false;
    plan.blockers.push({ code: "PENDING_TRANSACTION_DEPTH", mempoolDepth: context.mempoolDepth, mempoolDepthLimit: context.mempoolDepthLimit });
  }
  if (routeUsesHodlmm(plan.route)) {
    try {
      const poolId = ensurePool(opts.poolId);
      const sbtcSide = await detectSbtcSide(poolId);
      context.hodlmmPoolCheck = { poolId, sbtcSide, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      plan.executable = false;
      canPreview = false;
      plan.blockers.push({
        code: error instanceof BlockedError ? error.code : "HODLMM_POOL_CHECK_FAILED",
        message,
      });
      context.hodlmmPoolCheck = { ok: false, message };
    }
  }
  const preview = canPreview ? await routePreview(plan.route, dependencies, wallet, opts) : {};
  const previewBlockers = collectPreviewBlockers(preview);
  if (previewBlockers.length > 0) {
    plan.executable = false;
    plan.blockers.push(...previewBlockers);
  }
  return { wallet, dependencies, checkpoint, plan, preview, context };
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const dependencies = await dependencyReport();
    const checkpoint = await readCheckpoint(wallet);
    const [context, readiness] = await Promise.all([
      routeContext(opts),
      dependencyReadiness(dependencies, wallet, opts),
    ]);
    const missing = missingDependencies(dependencies);
    if (missing.length > 0) {
      blocked("doctor", "MISSING_PRIMITIVE_DEPENDENCIES", "Required primitive skills are not installed.", "Install or merge the missing primitive skills, then rerun doctor.", { dependencies, missing, checkpoint, context, readiness });
      return;
    }
    const readinessBlockers = collectReadinessBlockers(readiness);
    if (readinessBlockers.length > 0) {
      blocked("doctor", "PRIMITIVE_READINESS_BLOCKED", "One or more dependency primitive readiness checks failed.", "Resolve the primitive blocker or adjust the route inputs, then rerun doctor.", { dependencies, missing, checkpoint, context, readiness, readinessBlockers });
      return;
    }
    success("doctor", { dependencies, missing, checkpoint, context, readiness });
  } catch (error) {
    fail("doctor", error);
  }
}

async function runStatus(opts: SharedOptions): Promise<void> {
  try {
    const built = await buildPlan(opts, false);
    success("status", built as unknown as JsonMap);
  } catch (error) {
    fail("status", error);
  }
}

async function runPlan(opts: SharedOptions): Promise<void> {
  try {
    const built = await buildPlan(opts, true);
    success("plan", built as unknown as JsonMap);
  } catch (error) {
    fail("plan", error);
  }
}

async function runRoute(opts: RunOptions): Promise<void> {
  try {
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "This composed write skill requires explicit confirmation.", "Re-run with --confirm=ROUTE.");
    }
    const built = await buildPlan(opts, true);
    if (unresolved(built.checkpoint)) {
      throw new BlockedError("UNRESOLVED_ROUTE_STATE", "A previous route checkpoint is unresolved.", "Run resume or cancel before starting a new route.", { checkpoint: built.checkpoint });
    }
    if (!built.plan.executable) {
      throw new BlockedError("ROUTE_BLOCKED", built.plan.reason, "Resolve the blockers or choose a supported route before running.", { plan: built.plan });
    }
    let checkpoint = await writeCheckpoint(newCheckpoint(built.wallet, built.plan, opts));
    if (built.plan.route === "idle-to-hodlmm") {
      const deposit = primitiveByName(built.dependencies, "bitflow-hodlmm-deposit");
      const result = await runPrimitive(deposit.entry!, "run", [...await depositArgs(built.wallet, opts), "--wait-seconds", opts.waitSeconds || DEFAULT_WAIT_SECONDS, "--confirm", "DEPOSIT"], built.wallet);
      requirePrimitiveSuccess(deposit.name, result);
      const txid = extractTxid(result);
      checkpoint = await writeCheckpoint({ ...checkpoint, step: "hodlmm_deposit_confirmed", txids: txid ? [txid] : checkpoint.txids });
      checkpoint = await writeCheckpoint({ ...checkpoint, step: "complete", nextRequiredAction: "Route complete. Run status before considering another route." });
      success("run", { checkpoint, dependencies: built.dependencies, primitiveResults: { hodlmmDeposit: result as JsonMap } });
      return;
    }
    throw new BlockedError("UNSUPPORTED_EXECUTION_ROUTE", `Route ${built.plan.route} is not executable in this controller version.`, "Use plan/status output to inspect blockers and install the missing proof-grade primitive surface.", { plan: built.plan });
  } catch (error) {
    fail("run", error);
  }
}

async function runResume(opts: RunOptions): Promise<void> {
  try {
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "Resume can continue writes and requires explicit confirmation.", "Re-run with --confirm=ROUTE.");
    }
    const wallet = ensureWallet(opts.wallet);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint || !unresolved(checkpoint)) {
      throw new BlockedError("NO_RESUMABLE_STATE", "No unresolved route state exists for this wallet.", "Run plan/run for a new route if appropriate.", { checkpoint });
    }
    throw new BlockedError("MANUAL_REVIEW_REQUIRED", `Checkpoint step ${checkpoint.step} requires manual review before resume.`, "Inspect wallet/protocol state and cancel or repair the route checkpoint.", { checkpoint });
  } catch (error) {
    fail("resume", error);
  }
}

async function runCancel(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint || !unresolved(checkpoint)) {
      throw new BlockedError("NO_ACTIVE_ROUTE", "No unresolved route state exists for this wallet.", "No cancel action is needed.", { checkpoint });
    }
    const cancelled = await writeCheckpoint({ ...checkpoint, step: "operator_cancelled", abortReason: "operator_cancelled", nextRequiredAction: "Review wallet/protocol state before starting another route." });
    success("cancel", { checkpoint: cancelled });
  } catch (error) {
    fail("cancel", error);
  }
}

function addSharedOptions(command: Command): Command {
  return command
    .option("--wallet <stacks-address>", "wallet that owns funds and signs writes")
    .option("--source <venue>", "source venue: auto | hodlmm | zest | idle", "auto")
    .option("--target <venue>", "target venue: auto | hodlmm | zest", "auto")
    .option("--pool-id <pool-id>", "Bitflow HODLMM pool id")
    .option("--bin-id <id>", "single HODLMM bin id")
    .option("--bin-ids <ids>", "comma-separated HODLMM bin ids")
    .option("--offsets <offsets>", "comma-separated active-bin-relative offsets")
    .option("--range <start:end>", "active-bin-relative range or rebalance spread hint")
    .option("--amount-sats <amount>", "sBTC amount in base units for route sizing")
    .option("--amount-x <amount>", "HODLMM token X amount in base units")
    .option("--amount-y <amount>", "HODLMM token Y amount in base units")
    .option("--sbtc-side <side>", "sBTC side in selected pool: auto | x | y", "auto")
    .option("--withdraw-bps <bps>", "HODLMM withdrawal percentage in basis points", DEFAULT_WITHDRAW_BPS)
    .option("--min-apy-edge-bps <bps>", "minimum yield edge required before movement", DEFAULT_MIN_APY_EDGE_BPS)
    .option("--max-data-age-seconds <seconds>", "freshness window for route-critical reads", DEFAULT_MAX_DATA_AGE_SECONDS)
    .option("--min-gas-reserve-ustx <uSTX>", "minimum STX gas reserve", DEFAULT_MIN_GAS_RESERVE_USTX)
    .option("--mempool-depth-limit <count>", "maximum allowed pending tx depth", DEFAULT_MEMPOOL_DEPTH_LIMIT)
    .option("--slippage-bps <bps>", "primitive slippage tolerance", DEFAULT_SLIPPAGE_BPS)
    .option("--wait-seconds <seconds>", "wait window passed to primitive write skills", DEFAULT_WAIT_SECONDS);
}

function normalizeOptions(opts: Record<string, string | undefined>): SharedOptions {
  return {
    ...opts,
    source: (opts.source || "auto") as SourceVenue,
    target: (opts.target || "auto") as TargetVenue,
    sbtcSide: (opts.sbtcSide || opts["sbtc-side"] || "auto") as "auto" | "x" | "y",
  };
}

const program = new Command();

program
  .name(SKILL_NAME)
  .description("Compose HODLMM and Zest yield-routing primitives with route checkpoints");

addSharedOptions(program.command("doctor").description("Check dependency, wallet, and route readiness")).action((opts) => runDoctor(normalizeOptions(opts)));
addSharedOptions(program.command("status").description("Read current route posture")).action((opts) => runStatus(normalizeOptions(opts)));
addSharedOptions(program.command("plan").description("Plan an ordered route without broadcasting")).action((opts) => runPlan(normalizeOptions(opts)));
addSharedOptions(program.command("run").description("Run a confirmed route"))
  .option("--confirm <ROUTE>", "required confirmation token")
  .action((opts) => runRoute({ ...normalizeOptions(opts), confirm: opts.confirm }));
addSharedOptions(program.command("resume").description("Resume a supported interrupted route"))
  .option("--confirm <ROUTE>", "required confirmation token")
  .action((opts) => runResume({ ...normalizeOptions(opts), confirm: opts.confirm }));
addSharedOptions(program.command("cancel").description("Cancel unresolved saved route state")).action((opts) => runCancel(normalizeOptions(opts)));

program.parse(process.argv);
