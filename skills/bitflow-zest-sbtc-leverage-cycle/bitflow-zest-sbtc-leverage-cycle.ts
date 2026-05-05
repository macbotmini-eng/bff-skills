#!/usr/bin/env bun

import { spawn } from "child_process";
import { Command } from "commander";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";
type Step = "idle" | "borrow_confirmed" | "swap_confirmed" | "complete" | "blocked_partial_cycle" | "operator_cancelled";

interface Primitive {
  name: string;
  entry: string | null;
  requiredFor: string;
}

interface PrimitiveResult {
  status?: string;
  action?: string;
  data?: JsonMap;
  error?: JsonMap | null;
  raw?: JsonMap;
}

interface Checkpoint {
  version: number;
  cycleId: string;
  wallet: string;
  step: Step;
  requestedBorrowAmountUstx: string;
  createdAt: string;
  updatedAt: string;
  borrowTxid?: string;
  swapTxid?: string;
  depositTxid?: string;
  observedSbtcReceived?: string;
  abortReason?: string;
  nextRequiredAction?: string;
}

interface SharedOptions {
  wallet?: string;
  borrowAmountUstx?: string;
  slippageBps?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  waitSeconds?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
}

const CONFIRM_TOKEN = "CYCLE";
const DEFAULT_SLIPPAGE_BPS = "150";
const DEFAULT_MIN_GAS_RESERVE_USTX = "500000";
const DEFAULT_MEMPOOL_DEPTH_LIMIT = "0";
const DEFAULT_WAIT_SECONDS = "240";

const DEPENDENCIES = [
  { name: "zest-borrow-asset-primitive", requiredFor: "borrow STX against existing Zest sBTC collateral" },
  { name: "bitflow-swap-aggregator", requiredFor: "swap borrowed STX to sBTC through Bitflow" },
  { name: "zest-asset-deposit-primitive", requiredFor: "deposit received sBTC back into Zest collateral" },
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function repoRoot(): string {
  return process.env.AIBTC_SKILLS_ROOT || process.cwd();
}

async function resolvePrimitive(name: string, requiredFor: string): Promise<Primitive> {
  const root = repoRoot();
  const candidates = [
    path.join(root, "skills", name, `${name}.ts`),
    path.join(root, name, `${name}.ts`),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return { name, entry: candidate, requiredFor };
  }
  return { name, entry: null, requiredFor };
}

async function dependencyReport(): Promise<Primitive[]> {
  return Promise.all(DEPENDENCIES.map((dependency) => resolvePrimitive(dependency.name, dependency.requiredFor)));
}

function missingDependencies(dependencies: Primitive[]): Primitive[] {
  return dependencies.filter((dependency) => !dependency.entry);
}

function ensureWallet(wallet?: string): string {
  if (!wallet) throw new Error("--wallet is required");
  return wallet;
}

function ensureBorrowAmount(amount?: string): string {
  if (!amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new Error("--borrow-amount-ustx is required and must be a positive integer");
  }
  return amount;
}

function ensureDependencies(dependencies: Primitive[]): void {
  const missing = missingDependencies(dependencies);
  if (missing.length > 0) {
    throw new BlockedError(
      "MISSING_PRIMITIVE_DEPENDENCIES",
      "This composed controller cannot run until all primitive skill dependencies are installed.",
      "Merge or install the primitive skill PRs, then rerun doctor.",
      { missing }
    );
  }
}

function checkpointDir(): string {
  return path.join(os.homedir(), ".aibtc", "state", "bitflow-zest-sbtc-leverage-cycle");
}

function checkpointPath(wallet: string): string {
  const safeWallet = wallet.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(checkpointDir(), `${safeWallet}.json`);
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

function newCheckpoint(wallet: string, requestedBorrowAmountUstx: string): Checkpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    cycleId: `cycle-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    wallet,
    step: "idle",
    requestedBorrowAmountUstx,
    createdAt: now,
    updatedAt: now,
  };
}

function unresolved(checkpoint: Checkpoint | null): boolean {
  return !!checkpoint && !["complete", "operator_cancelled"].includes(checkpoint.step);
}

function primitiveByName(dependencies: Primitive[], name: string): Primitive {
  const primitive = dependencies.find((dependency) => dependency.name === name);
  if (!primitive?.entry) throw new Error(`Primitive ${name} is not installed`);
  return primitive;
}

function runPrimitive(entry: string, subcommand: string, args: string[]): Promise<PrimitiveResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", entry, subcommand, ...args], {
      cwd: repoRoot(),
      env: { ...process.env, NETWORK: process.env.NETWORK || "mainnet" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const trimmed = stdout.trim();
      let parsed: PrimitiveResult;
      try {
        parsed = JSON.parse(trimmed) as PrimitiveResult;
      } catch {
        reject(new BlockedError("INVALID_PRIMITIVE_OUTPUT", `Primitive ${path.basename(entry)} did not return one JSON object.`, "Inspect the primitive output and fix it before composing.", { code: code ?? -1, stdout: trimmed.slice(0, 1000), stderr: stderr.slice(0, 1000) }));
        return;
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
      "Resolve the primitive blocker before continuing the composed cycle.",
      { primitive: name, result: result as JsonMap }
    );
  }
}

function sharedArgs(opts: SharedOptions): string[] {
  const args = [
    "--slippage-bps", opts.slippageBps || DEFAULT_SLIPPAGE_BPS,
    "--min-gas-reserve-ustx", opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX,
    "--mempool-depth-limit", opts.mempoolDepthLimit || DEFAULT_MEMPOOL_DEPTH_LIMIT,
    "--wait-seconds", opts.waitSeconds || DEFAULT_WAIT_SECONDS,
  ];
  return args;
}

function primitiveGasArgs(opts: SharedOptions): string[] {
  // Includes mempool-depth-limit so every write-leg primitive (borrow, deposit) carries
  // the same depth gate the swap leg gets via sharedArgs(). Per PRD safety req #5:
  // "Mempool depth checked before every write leg." Diego review #4230128713 blocking item 2.
  return [
    "--min-gas-reserve-ustx", opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX,
    "--mempool-depth-limit", opts.mempoolDepthLimit || DEFAULT_MEMPOOL_DEPTH_LIMIT,
  ];
}

function primitiveWaitArgs(opts: SharedOptions): string[] {
  return ["--wait-seconds", opts.waitSeconds || DEFAULT_WAIT_SECONDS];
}

function borrowArgs(wallet: string, amount?: string): string[] {
  const args = ["--wallet", wallet, "--collateral-asset", "sBTC", "--borrow-asset", "STX"];
  if (amount) args.push("--amount", amount);
  return args;
}

function depositArgs(wallet: string, amount?: string): string[] {
  const args = ["--wallet", wallet, "--deposit-asset", "sBTC"];
  if (amount) args.push("--amount", amount);
  return args;
}

function ustxToStxDecimal(amountUstx: string): string {
  const value = BigInt(amountUstx);
  const whole = value / 1_000_000n;
  const fractional = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function swapArgs(wallet: string, amountUstx: string, opts: SharedOptions): string[] {
  return [
    "--wallet", wallet,
    "--token-in", "STX",
    "--token-out", "sBTC",
    "--amount-in", ustxToStxDecimal(amountUstx),
    ...sharedArgs(opts),
  ];
}

function extractTxid(result: PrimitiveResult): string | null {
  const data = result.data || {};
  const proof = data.proof as JsonMap | undefined;
  const direct = data.txid || proof?.txid;
  return typeof direct === "string" ? direct : null;
}

function asBigInt(value: Json | undefined): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return null;
}

function extractObservedSbtc(result: PrimitiveResult): string | null {
  // Fail-closed: returns the actual observed delta only. PRD scope requires "re-supply
  // the actual received sBTC amount" — never the quoted/expected. If the swap primitive's
  // balancesAfter payload is missing or unparseable, returns null so the caller throws
  // SWAP_OUTPUT_UNKNOWN instead of silently depositing the quoted amount under
  // adversarial slippage. Diego review #4230128713 blocking item 1.
  const data = result.data || {};
  const before = data.balances as JsonMap | undefined;
  const after = data.balancesAfter as JsonMap | undefined;
  const beforeOutput = asBigInt(before?.outputBalance);
  const afterOutput = asBigInt(after?.outputBalance);
  if (beforeOutput !== null && afterOutput !== null && afterOutput >= beforeOutput) {
    return (afterOutput - beforeOutput).toString();
  }
  return null;
}

async function primitiveReadiness(dependencies: Primitive[], wallet: string): Promise<JsonMap> {
  const results: JsonMap = {};
  for (const dependency of dependencies) {
    if (!dependency.entry) {
      results[dependency.name] = { status: "missing", requiredFor: dependency.requiredFor };
      continue;
    }
    const args = dependency.name === "zest-asset-deposit-primitive" ? ["--wallet", wallet, "--deposit-asset", "sBTC"] : ["--wallet", wallet];
    results[dependency.name] = (await runPrimitive(dependency.entry, "doctor", args)) as JsonMap;
  }
  return results;
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const dependencies = await dependencyReport();
    const checkpoint = await readCheckpoint(wallet);
    const readiness = await primitiveReadiness(dependencies, wallet);
    const missing = missingDependencies(dependencies);
    const data = { dependencies, missing, checkpoint, primitiveReadiness: readiness };
    if (missing.length > 0) {
      blocked("doctor", "MISSING_PRIMITIVE_DEPENDENCIES", "Required primitive skills are not installed.", "Merge or install the primitive skill PRs before building this controller.", data);
      return;
    }
    success("doctor", data);
  } catch (error) {
    fail("doctor", error);
  }
}

async function runStatus(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const dependencies = await dependencyReport();
    const checkpoint = await readCheckpoint(wallet);
    const data: JsonMap = { dependencies, missing: missingDependencies(dependencies), checkpoint };
    if (missingDependencies(dependencies).length === 0) {
      const borrow = primitiveByName(dependencies, "zest-borrow-asset-primitive");
      const deposit = primitiveByName(dependencies, "zest-asset-deposit-primitive");
      data.primitiveStatus = {
        borrow: await runPrimitive(borrow.entry!, "status", borrowArgs(wallet)),
        deposit: await runPrimitive(deposit.entry!, "status", depositArgs(wallet, "1")),
      } as JsonMap;
    }
    success("status", data);
  } catch (error) {
    fail("status", error);
  }
}

async function runPlan(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const amount = ensureBorrowAmount(opts.borrowAmountUstx);
    const dependencies = await dependencyReport();
    ensureDependencies(dependencies);
    const checkpoint = await readCheckpoint(wallet);
    if (unresolved(checkpoint)) {
      throw new BlockedError("UNRESOLVED_CYCLE_STATE", "A previous cycle checkpoint is unresolved.", "Run resume or cancel before planning a new cycle.", { checkpoint });
    }
    const borrow = primitiveByName(dependencies, "zest-borrow-asset-primitive");
    const swap = primitiveByName(dependencies, "bitflow-swap-aggregator");
    const borrowPlan = await runPrimitive(borrow.entry!, "plan", [...borrowArgs(wallet, amount), ...primitiveGasArgs(opts)]);
    const swapPlan = await runPrimitive(swap.entry!, "plan", swapArgs(wallet, amount, opts));
    success("plan", {
      route: "borrow-stx-swap-to-sbtc-resupply-sbtc",
      dependencies,
      steps: [
        { step: "borrow", primitive: borrow.name, result: borrowPlan },
        { step: "swap", primitive: swap.name, result: swapPlan },
        { step: "deposit", primitive: "zest-asset-deposit-primitive", result: "planned after swap confirms and observed sBTC amount is known" },
      ],
    });
  } catch (error) {
    fail("plan", error);
  }
}

async function continueFrom(checkpoint: Checkpoint, opts: RunOptions, dependencies: Primitive[]): Promise<Checkpoint> {
  const wallet = checkpoint.wallet;
  const amount = checkpoint.requestedBorrowAmountUstx;
  const swap = primitiveByName(dependencies, "bitflow-swap-aggregator");
  const deposit = primitiveByName(dependencies, "zest-asset-deposit-primitive");
  let current = checkpoint;

  if (current.step === "borrow_confirmed") {
    const swapResult = await runPrimitive(swap.entry!, "run", [...swapArgs(wallet, amount, opts), "--confirm", "SWAP"]);
    requirePrimitiveSuccess(swap.name, swapResult);
    const observedSbtc = extractObservedSbtc(swapResult);
    if (!observedSbtc || BigInt(observedSbtc) <= 0n) {
      throw new BlockedError("SWAP_OUTPUT_UNKNOWN", "The swap primitive did not expose a positive observed sBTC amount.", "Inspect the swap result and resume only with a primitive output that reports the received sBTC.", { swapResult: swapResult as JsonMap });
    }
    current = await writeCheckpoint({ ...current, step: "swap_confirmed", swapTxid: extractTxid(swapResult) || undefined, observedSbtcReceived: observedSbtc });
  }

  if (current.step === "swap_confirmed") {
    const amountSbtc = current.observedSbtcReceived;
    if (!amountSbtc || BigInt(amountSbtc) <= 0n) {
      throw new BlockedError("MISSING_DEPOSIT_AMOUNT", "Saved checkpoint does not include a positive observed sBTC amount.", "Cancel or repair the checkpoint before resuming.", { checkpoint: current });
    }
    const depositResult = await runPrimitive(deposit.entry!, "run", [...depositArgs(wallet, amountSbtc), ...primitiveGasArgs(opts), ...primitiveWaitArgs(opts), "--confirm", "DEPOSIT"]);
    requirePrimitiveSuccess(deposit.name, depositResult);
    current = await writeCheckpoint({ ...current, step: "complete", depositTxid: extractTxid(depositResult) || undefined });
  }

  return current;
}

async function runCycle(opts: RunOptions): Promise<void> {
  try {
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "This composed write skill requires explicit confirmation.", "Re-run with --confirm=CYCLE.");
    }
    const wallet = ensureWallet(opts.wallet);
    const amount = ensureBorrowAmount(opts.borrowAmountUstx);
    const dependencies = await dependencyReport();
    ensureDependencies(dependencies);
    const existing = await readCheckpoint(wallet);
    if (unresolved(existing)) {
      throw new BlockedError("UNRESOLVED_CYCLE_STATE", "A previous cycle checkpoint is unresolved.", "Run resume or cancel before starting a new cycle.", { checkpoint: existing });
    }
    const borrow = primitiveByName(dependencies, "zest-borrow-asset-primitive");
    let checkpoint = await writeCheckpoint(newCheckpoint(wallet, amount));
    const borrowResult = await runPrimitive(borrow.entry!, "run", [...borrowArgs(wallet, amount), ...primitiveGasArgs(opts), ...primitiveWaitArgs(opts), "--confirm", "BORROW"]);
    requirePrimitiveSuccess(borrow.name, borrowResult);
    checkpoint = await writeCheckpoint({ ...checkpoint, step: "borrow_confirmed", borrowTxid: extractTxid(borrowResult) || undefined });
    checkpoint = await continueFrom(checkpoint, opts, dependencies);
    success("run", { checkpoint, dependencies });
  } catch (error) {
    fail("run", error);
  }
}

async function runResume(opts: RunOptions): Promise<void> {
  try {
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "Resume can continue writes and requires explicit confirmation.", "Re-run with --confirm=CYCLE.");
    }
    const wallet = ensureWallet(opts.wallet);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint || !unresolved(checkpoint)) {
      throw new BlockedError("NO_RESUMABLE_STATE", "No unresolved cycle state exists for this wallet.", "Run plan/run for a new cycle if appropriate.", { checkpoint });
    }
    if (!["borrow_confirmed", "swap_confirmed"].includes(checkpoint.step)) {
      throw new BlockedError("UNSUPPORTED_RESUME_STEP", `Cannot resume automatically from ${checkpoint.step}.`, "Inspect the checkpoint and cancel or repair manually.", { checkpoint });
    }
    const dependencies = await dependencyReport();
    ensureDependencies(dependencies);
    const completed = await continueFrom(checkpoint, opts, dependencies);
    success("resume", { checkpoint: completed, dependencies });
  } catch (error) {
    fail("resume", error);
  }
}

async function runCancel(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint || !unresolved(checkpoint)) {
      throw new BlockedError("NO_ACTIVE_CYCLE", "No unresolved cycle state exists for this wallet.", "No cancel action is needed.", { checkpoint });
    }
    const cancelled = await writeCheckpoint({ ...checkpoint, step: "operator_cancelled", abortReason: "operator_cancelled", nextRequiredAction: "Review wallet/Zest state before starting another cycle." });
    success("cancel", { checkpoint: cancelled });
  } catch (error) {
    fail("cancel", error);
  }
}

function addSharedOptions(command: Command): Command {
  return command
    .option("--wallet <stacks-address>", "wallet that owns collateral and signs writes")
    .option("--borrow-amount-ustx <uSTX>", "STX borrow amount in micro-STX")
    .option("--slippage-bps <bps>", "swap slippage tolerance in basis points", DEFAULT_SLIPPAGE_BPS)
    .option("--min-gas-reserve-ustx <uSTX>", "minimum STX gas reserve", DEFAULT_MIN_GAS_RESERVE_USTX)
    .option("--mempool-depth-limit <count>", "maximum allowed pending tx depth", DEFAULT_MEMPOOL_DEPTH_LIMIT)
    .option("--wait-seconds <seconds>", "wait window passed to primitive write skills", DEFAULT_WAIT_SECONDS);
}

const program = new Command();

program
  .name("bitflow-zest-sbtc-leverage-cycle")
  .description("Compose Zest borrow, Bitflow swap, and Zest deposit primitives into one sBTC leverage cycle");

addSharedOptions(program.command("doctor").description("Check dependency and state readiness")).action(runDoctor);
addSharedOptions(program.command("status").description("Read current composed-cycle status")).action(runStatus);
addSharedOptions(program.command("plan").description("Plan one composed cycle without broadcasting")).action(runPlan);
addSharedOptions(program.command("run").description("Run one composed cycle"))
  .option("--confirm <CYCLE>", "required confirmation token")
  .action(runCycle);
addSharedOptions(program.command("resume").description("Resume an interrupted cycle"))
  .option("--confirm <CYCLE>", "required confirmation token")
  .action(runResume);
addSharedOptions(program.command("cancel").description("Cancel unresolved saved cycle state")).action(runCancel);

program.parse(process.argv);
