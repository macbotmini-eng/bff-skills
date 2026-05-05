#!/usr/bin/env bun

import { Command } from "commander";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";
type CheckpointStep = "planned" | "broadcast" | "complete" | "cancelled";

interface SharedOptions {
  wallet?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  targetOut?: string;
  maxSlippageBps?: string;
  slippageBps?: string;
  feeUstx?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  waitSeconds?: string;
  mode?: string;
  handoffLabel?: string;
  txid?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
}

interface Checkpoint {
  version: number;
  routeId: string;
  wallet: string;
  mode: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string | null;
  targetOut: string | null;
  expectedAmountOut: Json | null;
  txid: string | null;
  step: CheckpointStep;
  hiroStatus: string | null;
  handoffLabel: string;
  createdAt: string;
  updatedAt: string;
  nextRequiredAction: string;
}

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

const NETWORK = process.env.NETWORK || "mainnet";
const HIRO_API = process.env.STACKS_API_HOST || "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const CONFIRM_TOKEN = "FUND";
const DEFAULT_WAIT_SECONDS = 300;
const DEFAULT_MEMPOOL_DEPTH_LIMIT = 0;
const DEFAULT_HANDOFF_LABEL = "bitflow-hodlmm-zest-yield-loop";
const STATE_ROOT = path.join(os.homedir(), ".aibtc", "state", "bitflow-funding-coordinator");
const SWAP_SKILL = path.join("skills", "bitflow-swap-aggregator", "bitflow-swap-aggregator.ts");

function stringify(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, stringify(val)])) as JsonMap;
  }
  if (value === undefined) return null;
  return value as Json;
}

function emit(status: Status, action: string, data: JsonMap, error: JsonMap | null): void {
  process.stdout.write(`${JSON.stringify({ status, action, data: stringify(data), error: stringify(error) }, null, 2)}\n`);
}

function success(action: string, data: JsonMap): void {
  emit("success", action, data, null);
}

function blocked(action: string, code: string, message: string, next: string, data: JsonMap = {}): void {
  emit("blocked", action, data, { code, message, next });
}

function fail(action: string, error: unknown): void {
  if (error instanceof BlockedError) {
    blocked(action, error.code, error.message, error.next, error.data);
    process.exit(0);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  emit("error", action, {}, { code: "ERROR", message, next: "Run doctor/status and inspect the failing check before retrying." });
  process.exitCode = 1;
}

function parseInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function requireWallet(opts: SharedOptions): string {
  if (!opts.wallet) throw new Error("--wallet is required");
  return opts.wallet;
}

function requireFundingArgs(opts: SharedOptions): { wallet: string; tokenIn: string; tokenOut: string; amountIn: string } {
  const wallet = requireWallet(opts);
  if (!opts.tokenIn) throw new Error("--token-in is required");
  if (!opts.tokenOut) throw new Error("--token-out is required");
  if (!opts.amountIn) throw new Error("--amount-in is required for v1 funding");
  return { wallet, tokenIn: opts.tokenIn, tokenOut: opts.tokenOut, amountIn: opts.amountIn };
}

function checkpointPath(wallet: string): string {
  return path.join(STATE_ROOT, `${wallet}.json`);
}

async function readCheckpoint(wallet: string): Promise<Checkpoint | null> {
  try {
    return JSON.parse(await fs.readFile(checkpointPath(wallet), "utf8")) as Checkpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
  await fs.mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  const next = { ...checkpoint, updatedAt: new Date().toISOString() };
  const finalPath = checkpointPath(checkpoint.wallet);
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, finalPath);
  return next;
}

function newCheckpoint(opts: SharedOptions, plan: JsonMap): Checkpoint {
  const { wallet, tokenIn, tokenOut, amountIn } = requireFundingArgs(opts);
  const createdAt = new Date().toISOString();
  return {
    version: 1,
    routeId: crypto.createHash("sha256").update(`${wallet}:${tokenIn}:${tokenOut}:${amountIn}:${createdAt}`).digest("hex").slice(0, 16),
    wallet,
    mode: opts.mode ?? "one-shot",
    tokenIn,
    tokenOut,
    amountIn,
    targetOut: opts.targetOut ?? null,
    expectedAmountOut: extractExpectedOutput(plan),
    txid: null,
    step: "planned",
    hiroStatus: null,
    handoffLabel: opts.handoffLabel ?? DEFAULT_HANDOFF_LABEL,
    createdAt,
    updatedAt: createdAt,
    nextRequiredAction: "Run funding swap with --confirm=FUND",
  };
}

function isUnresolved(checkpoint: Checkpoint | null): boolean {
  return !!checkpoint && checkpoint.step !== "complete" && checkpoint.step !== "cancelled";
}

function fundingRoute(opts: SharedOptions): string {
  return `${opts.tokenIn ?? "unknown"}-to-${opts.tokenOut ?? "unknown"}`;
}

function baseHandoff(opts: SharedOptions, readyAmount: Json | null, routeReady: boolean): JsonMap {
  return {
    label: opts.handoffLabel ?? DEFAULT_HANDOFF_LABEL,
    readyToken: opts.tokenOut ?? null,
    readyAmount: routeReady ? readyAmount : null,
    routeReady,
  };
}

function fundingEnvelope(opts: SharedOptions, primitive: JsonMap, extra: JsonMap = {}): JsonMap {
  const readyAmount = extractOutputBalance(primitive);
  return {
    fundingRoute: fundingRoute(opts),
    mode: opts.mode ?? "one-shot",
    wallet: opts.wallet ?? null,
    tokenIn: opts.tokenIn ?? null,
    tokenOut: opts.tokenOut ?? null,
    amountIn: opts.amountIn ?? null,
    expectedAmountOut: extractExpectedOutput(primitive),
    routeReady: extra.routeReady ?? false,
    handoff: baseHandoff(opts, readyAmount, Boolean(extra.routeReady)),
    primitive,
    boundaries: {
      downstreamWritesPerformed: false,
      hodlmmWritePerformed: false,
      zestWritePerformed: false,
      borrowOrLeveragePerformed: false,
    },
    ...extra,
  };
}

function toCliArgs(opts: SharedOptions, command: "doctor" | "plan" | "run"): string[] {
  const args = [command];
  const push = (flag: string, value: string | undefined) => {
    if (value !== undefined) args.push(flag, value);
  };
  push("--wallet", opts.wallet);
  if (command !== "doctor") {
    push("--token-in", opts.tokenIn);
    push("--token-out", opts.tokenOut);
    push("--amount-in", opts.amountIn);
    push("--slippage-bps", opts.maxSlippageBps ?? opts.slippageBps);
    push("--fee-ustx", opts.feeUstx);
  }
  push("--min-gas-reserve-ustx", opts.minGasReserveUstx);
  push("--mempool-depth-limit", opts.mempoolDepthLimit ?? String(DEFAULT_MEMPOOL_DEPTH_LIMIT));
  push("--wait-seconds", opts.waitSeconds);
  if (command === "run") args.push("--confirm", "SWAP");
  return args;
}

async function runPrimitive(args: string[]): Promise<JsonMap> {
  const fullArgs = ["run", SWAP_SKILL, ...args];
  const child = spawn("bun", fullArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const out = Buffer.concat(stdout).toString("utf8").trim();
  const err = Buffer.concat(stderr).toString("utf8").trim();
  let parsed: JsonMap | null = null;
  if (out) {
    try {
      parsed = JSON.parse(out) as JsonMap;
    } catch {
      throw new Error(`bitflow-swap-aggregator returned non-JSON output: ${out.slice(0, 240)}`);
    }
  }
  if (code !== 0 && !parsed) {
    throw new Error(`bitflow-swap-aggregator failed with exit ${code}${err ? `: ${err.slice(0, 240)}` : ""}`);
  }
  if (!parsed) throw new Error("bitflow-swap-aggregator returned empty output");
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

function walk(value: unknown, predicate: (key: string, value: unknown) => string | null): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const found = predicate(key, child);
    if (found) return found;
    const nested = walk(child, predicate);
    if (nested) return nested;
  }
  return null;
}

function extractTxid(value: unknown): string | null {
  return walk(value, (key, child) => {
    if ((key === "txid" || key === "tx_id" || key === "txId") && typeof child === "string" && /^0x[0-9a-fA-F]{64}$/.test(child)) {
      return child;
    }
    return null;
  });
}

function extractExpectedOutput(value: unknown): Json | null {
  const quote = walk(value, (key, child) => {
    if ((key === "quote" || key === "expectedAmountOut") && (typeof child === "string" || typeof child === "number")) return String(child);
    return null;
  });
  return quote;
}

function extractOutputBalance(value: unknown): Json | null {
  const outputBalance = walk(value, (key, child) => {
    if (key === "outputBalance" && (typeof child === "string" || typeof child === "number")) return String(child);
    return null;
  });
  return outputBalance;
}

function txProof(txid: string, tx: JsonMap | null): JsonMap {
  return {
    txid,
    explorer: `${EXPLORER}/${txid}?chain=mainnet`,
    status: tx?.tx_status ?? "unknown",
    sender: tx?.sender_address ?? null,
    contract: (tx?.contract_call as JsonMap | undefined)?.contract_id ?? null,
    function: (tx?.contract_call as JsonMap | undefined)?.function_name ?? null,
    result: (tx?.tx_result as JsonMap | undefined)?.repr ?? null,
    postConditionMode: tx?.post_condition_mode ?? null,
    postConditionCount: Array.isArray(tx?.post_conditions) ? (tx?.post_conditions as Json[]).length : null,
  };
}

async function checkHiro(): Promise<JsonMap> {
  try {
    const info = await fetchJson<JsonMap>(`${HIRO_API}/v2/info`);
    return { ok: true, chainId: info.network_id ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function dependencySignals(): Promise<JsonMap> {
  return {
    bitflowSwapAggregator: await fileExists(SWAP_SKILL),
    nonceManagerLocal: await fileExists(path.join("skills", "nonce-manager", "nonce-manager.ts")),
    nonceManagerDeclared: true,
    noncePolicy: "serialize funding writes with nonce-manager when available; never run overlapping local checkpoints",
  };
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  try {
    if (NETWORK !== "mainnet") throw new BlockedError("MAINNET_ONLY", "bitflow-funding-coordinator is mainnet-only.", "Set NETWORK=mainnet.");
    const wallet = opts.wallet;
    const [hiro, dependencies, checkpoint] = await Promise.all([
      checkHiro(),
      dependencySignals(),
      wallet ? readCheckpoint(wallet) : Promise.resolve(null),
    ]);
    let primitive: JsonMap | null = null;
    if (wallet && dependencies.bitflowSwapAggregator) {
      primitive = await runPrimitive(toCliArgs(opts, "doctor"));
    }
    success("doctor", {
      network: NETWORK,
      wallet: wallet ?? null,
      hiro,
      dependencies,
      checkpoint: checkpoint ?? null,
      unresolvedCheckpoint: isUnresolved(checkpoint),
      primitive,
    });
  } catch (error) {
    fail("doctor", error);
  }
}

async function runStatus(opts: SharedOptions): Promise<void> {
  try {
    const wallet = requireWallet(opts);
    const [checkpoint, dependencies, primitive] = await Promise.all([
      readCheckpoint(wallet),
      dependencySignals(),
      runPrimitive(toCliArgs(opts, "doctor")),
    ]);
    success("status", {
      wallet,
      checkpoint: checkpoint ?? null,
      unresolvedCheckpoint: isUnresolved(checkpoint),
      dependencies,
      primitive,
    });
  } catch (error) {
    fail("status", error);
  }
}

async function runPlan(opts: SharedOptions): Promise<void> {
  try {
    requireFundingArgs(opts);
    const primitive = await runPrimitive(toCliArgs(opts, "plan"));
    success("plan", fundingEnvelope(opts, primitive, { routeReady: false }));
  } catch (error) {
    fail("plan", error);
  }
}

async function runFunding(opts: RunOptions): Promise<void> {
  try {
    const { wallet } = requireFundingArgs(opts);
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "This write skill requires --confirm=FUND.", "Review plan output and rerun with --confirm=FUND.");
    }
    const existing = await readCheckpoint(wallet);
    if (isUnresolved(existing)) {
      throw new BlockedError("UNRESOLVED_CHECKPOINT", "A previous funding checkpoint is unresolved.", "Use resume --txid if a transaction was broadcast, or cancel if the operator has verified no write should continue.", { checkpoint: existing as unknown as JsonMap });
    }
    const plan = await runPrimitive(toCliArgs(opts, "plan"));
    let checkpoint = await writeCheckpoint(newCheckpoint(opts, plan));

    const runOpts = { ...opts, waitSeconds: "0" };
    const primitive = await runPrimitive(toCliArgs(runOpts, "run"));
    const txid = extractTxid(primitive);
    if (!txid) {
      throw new BlockedError("PRIMITIVE_TXID_MISSING", "bitflow-swap-aggregator did not return a txid.", "Inspect primitive output and do not retry until broadcast state is understood.", { primitive });
    }
    checkpoint = await writeCheckpoint({
      ...checkpoint,
      txid,
      step: "broadcast",
      hiroStatus: "pending",
      nextRequiredAction: "Await Hiro tx_status=success",
    });

    const immediateStatus = String((primitive.data as JsonMap | undefined)?.proof && ((primitive.data as JsonMap).proof as JsonMap).status || "");
    const waitSeconds = parseInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds");
    const mined = immediateStatus === "success" ? null : await waitForTx(txid, waitSeconds);
    const proof = immediateStatus === "success" ? ((primitive.data as JsonMap).proof as JsonMap) : txProof(txid, mined);
    const status = String(proof.status ?? "unknown");

    if (status !== "success") {
      checkpoint = await writeCheckpoint({
        ...checkpoint,
        hiroStatus: status,
        nextRequiredAction: "Run resume --txid after Hiro reports tx_status=success",
      });
      throw new BlockedError("TX_NOT_CONFIRMED", "Funding txid is recorded but Hiro has not confirmed success.", "Use resume --txid after the transaction confirms; do not rebroadcast blindly.", { checkpoint: checkpoint as unknown as JsonMap, proof });
    }

    checkpoint = await writeCheckpoint({
      ...checkpoint,
      step: "complete",
      hiroStatus: "success",
      nextRequiredAction: "Funding complete; downstream strategy can consume handoff.",
    });
    success("run", fundingEnvelope(opts, primitive, { routeReady: true, checkpoint: checkpoint as unknown as JsonMap, proof }));
  } catch (error) {
    fail("run", error);
  }
}

async function runResume(opts: SharedOptions): Promise<void> {
  try {
    const wallet = requireWallet(opts);
    const checkpoint = await readCheckpoint(wallet);
    const txid = opts.txid ?? checkpoint?.txid;
    if (!txid) throw new Error("--txid is required when no checkpoint txid exists");
    const mined = await waitForTx(txid, parseInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds"));
    const proof = txProof(txid, mined);
    const status = String(proof.status ?? "unknown");
    if (status !== "success") {
      throw new BlockedError("TX_NOT_CONFIRMED", "Hiro has not confirmed this funding txid as success.", "Wait for confirmation and rerun resume --txid; do not rebroadcast.", { checkpoint: checkpoint as unknown as JsonMap | null, proof });
    }
    const completed = await writeCheckpoint({
      ...(checkpoint ?? {
        version: 1,
        routeId: crypto.createHash("sha256").update(`${wallet}:${txid}`).digest("hex").slice(0, 16),
        wallet,
        mode: opts.mode ?? "one-shot",
        tokenIn: opts.tokenIn ?? "unknown",
        tokenOut: opts.tokenOut ?? "unknown",
        amountIn: opts.amountIn ?? null,
        targetOut: opts.targetOut ?? null,
        expectedAmountOut: null,
        createdAt: new Date().toISOString(),
        handoffLabel: opts.handoffLabel ?? DEFAULT_HANDOFF_LABEL,
      }),
      txid,
      step: "complete",
      hiroStatus: "success",
      nextRequiredAction: "Funding complete; downstream strategy can consume handoff.",
    });
    success("resume", {
      fundingRoute: fundingRoute({ ...opts, tokenIn: completed.tokenIn, tokenOut: completed.tokenOut }),
      wallet,
      txid,
      routeReady: true,
      checkpoint: completed as unknown as JsonMap,
      proof,
      handoff: {
        label: completed.handoffLabel,
        readyToken: completed.tokenOut,
        readyAmount: null,
        routeReady: true,
      },
    });
  } catch (error) {
    fail("resume", error);
  }
}

async function runCancel(opts: SharedOptions): Promise<void> {
  try {
    const wallet = requireWallet(opts);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint) {
      success("cancel", { wallet, cancelled: false, reason: "No checkpoint exists." });
      return;
    }
    const cancelled = await writeCheckpoint({
      ...checkpoint,
      step: "cancelled",
      nextRequiredAction: "Operator cancelled local funding checkpoint after external verification.",
    });
    success("cancel", { wallet, cancelled: true, checkpoint: cancelled as unknown as JsonMap });
  } catch (error) {
    fail("cancel", error);
  }
}

function addSharedOptions(command: Command): Command {
  return command
    .option("--wallet <stacks-address>", "wallet that owns the funding source token")
    .option("--token-in <token>", "source token symbol, token ID, or contract ID")
    .option("--token-out <token>", "target token symbol, token ID, or contract ID")
    .option("--amount-in <decimal>", "human-readable source token amount")
    .option("--target-out <decimal>", "minimum desired target token output, recorded for handoff")
    .option("--max-slippage-bps <bps>", "maximum slippage tolerance in basis points")
    .option("--slippage-bps <bps>", "alias for --max-slippage-bps")
    .option("--fee-ustx <uSTX>", "delegated swap transaction fee in micro-STX")
    .option("--min-gas-reserve-ustx <uSTX>", "minimum residual STX after write")
    .option("--mempool-depth-limit <number>", "maximum pending sender transactions; default is 0", String(DEFAULT_MEMPOOL_DEPTH_LIMIT))
    .option("--wait-seconds <seconds>", "Hiro confirmation wait window", String(DEFAULT_WAIT_SECONDS))
    .option("--mode <one-shot|dca-chunk>", "funding mode", "one-shot")
    .option("--handoff-label <label>", "downstream strategy label", DEFAULT_HANDOFF_LABEL);
}

const program = new Command();

program
  .name("bitflow-funding-coordinator")
  .description("Coordinate Bitflow funding swaps into route-ready target tokens")
  .version("0.1.0");

addSharedOptions(program.command("doctor").description("Check environment and dependency readiness")).action(runDoctor);
addSharedOptions(program.command("status").description("Read funding checkpoint and dependency status")).action(runStatus);
addSharedOptions(program.command("plan").description("Plan a funding swap without broadcasting")).action(runPlan);
addSharedOptions(program.command("run").description("Execute a funding swap"))
  .option("--confirm <FUND>", "required funding confirmation token")
  .action(runFunding);
addSharedOptions(program.command("resume").description("Confirm an existing funding txid"))
  .option("--txid <txid>", "funding transaction id")
  .action(runResume);
addSharedOptions(program.command("cancel").description("Cancel the local funding checkpoint")).action(runCancel);

program.parse(process.argv);
