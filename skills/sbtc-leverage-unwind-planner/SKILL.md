---
name: sbtc-leverage-unwind-planner
description: "Composed write skill that safely reduces or closes a leveraged sBTC position on Stacks by repaying Zest debt first, re-reading canonical state, and only then withdrawing collateral or swapping residuals — with per-leg execution proof, durable checkpoint/resume, and refusal of unsafe withdraw-first orderings."
metadata:
  author: "macbotmini-eng"
  author-agent: "<TBD — operator-supplied>"
  user-invocable: "false"
  arguments: "doctor | status | plan | run | resume | cancel"
  entry: "sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts"
  requires: "wallet, signing, settings, bitflow-swap-aggregator, nonce-manager"
  tags: "defi, write, mainnet-only, requires-funds, infrastructure, l2"
---

# sBTC Leverage Unwind Planner

## What it does

`sbtc-leverage-unwind-planner` safely reduces or closes a leveraged sBTC position created by the forward leverage cycle controller (`https://github.com/aibtcdev/skills/tree/main/bitflow-zest-sbtc-leverage-cycle`). It is a composed write skill that sequences the reverse risk path:

1. read canonical Zest debt, collateral, health factor, and liquidation state,
2. determine the repayment target,
3. use wallet-held repayment asset when available,
4. optionally acquire repayment asset from free wallet assets with a fresh Bitflow quote,
5. repay Zest debt,
6. wait for confirmation,
7. re-read canonical Zest position,
8. withdraw only the collateral that is safe and explicitly requested,
9. optionally swap withdrawn collateral or residual assets when explicitly requested,
10. persist checkpoint state after every confirmed leg.

The skill is callable independently. Operators can reduce risk without initiating a new leverage cycle. It is the safety-backstop PRD for the `https://github.com/BitflowFinance/bff-skills/issues/473` round-trip — repay, redeem/withdraw collateral, and optional swap-back.

## Why agents need it

`https://github.com/BitflowFinance/bff-skills/issues/473` cannot be complete if it can open or increase a leveraged position but cannot safely reduce it. Unwind is not the loop in reverse — it has different hazards: repay amount drifts as interest accrues; the wallet may not hold enough STX to repay; withdrawing collateral before repayment can worsen health factor; Zest collateral withdrawal can be blocked by liquidity or health constraints; Bitflow quotes can stale between plan and broadcast; partial execution may reduce debt but leave collateral supplied; a stuck pending tx between legs can leave the wallet in a state that must be resumed, not overwritten. The unwind path needs its own state machine, proof package, and refusal rules.

## Composition model — primitive-only, never inline

This controller composes accepted primitive surfaces. It does not duplicate Zest, Bitflow, or HODLMM mechanics. Per `https://github.com/BitflowFinance/bff-skills/issues/483`: composition is via `metadata.requires` + `AGENT.md` decision order; never via source imports between skill directories.

| Leg | Surface |
|---|---|
| Zest repay (debt reduction) | Direct call to `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market::repay` (mirror pattern from `https://github.com/aibtcdev/skills/tree/main/zest-borrow-asset-primitive`) |
| Zest collateral withdraw | Direct call to `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market::collateral-remove-redeem` (mirror pattern from `https://github.com/aibtcdev/skills/tree/main/zest-asset-deposit-primitive`; `collateral-remove-redeem(ft, amount, min-underlying, receiver, price-feeds)` returns underlying to wallet through the vault redeem path) |
| Optional swap-for-repay / residual swap | Shell out to `https://github.com/aibtcdev/skills/tree/main/bitflow-swap-aggregator` (`quote / plan / run --confirm=SWAP`) |
| Canonical Zest reads | Hiro `/v2/contracts/call-read/...` against `v0-assets::get-bitmap` (user position bitmap), `v0-market-vault::get-position(user, bitmap)` (full position tuple — debt, collateral, HF, liquidatable), `v0-assets::get-asset-status(asset)` (per-asset state). Not local LTV math. |
| Multi-leg nonce serialization | `nonce-manager` skill + Hiro mempool depth |

No upstream `zest-repay-asset-primitive` or `zest-collateral-withdraw-primitive` exists; this skill calls `v0-4-market` directly using the same write-skill pattern proven in our merged primitives `https://github.com/aibtcdev/skills/tree/main/zest-borrow-asset-primitive` and `https://github.com/aibtcdev/skills/tree/main/zest-asset-deposit-primitive`. `https://github.com/aibtcdev/skills/tree/main/zest-auto-repay` is an autonomous LTV guardian with its own monitor/emergency modes — not a primitive.

## Safety notes

This skill writes to mainnet. It moves wallet-owned funds and reduces on-chain debt. Mainnet only.

- Every write requires explicit `--confirm UNWIND`.
- Every write leg checks mempool depth before broadcast.
- Every write leg waits for `tx_status: success` on Hiro before the next leg starts.
- `PostConditionMode.Deny` on every write leg with explicit token-flow postconditions where expressible.
- The skill blocks on stale quotes, insufficient repay asset, unsafe collateral withdrawal projections, pending transactions, and unresolved checkpoints.
- The signer address must equal `--wallet`. No hardcoded wallets.
- `doctor`, `status`, and `plan` are read-only.
- The default path is **repay-first**. Withdraw-before-repay is blocked unless `--allow-collateral-release-for-repay` is set AND canonical Zest reads prove it is safe AND post-projected health factor stays above the configured floor.
- An existing unresolved checkpoint blocks any new unwind, cycle, or borrow write. The operator must `resume` (re-read confirms saved state matches chain) or `cancel` (operator-acknowledged partial completion; no on-chain action).
- The skill never silently sells wallet assets, blindly withdraws collateral before repayment, re-supplies collateral, manages HODLMM LP bins, runs autonomous multi-cycle strategies, hides partial-state risk, or retries failed writes blindly.
- HODLMM integration is **conditional**: claimed only if an executed swap leg routes through a HODLMM contract path AND the PR body verifies that route with transaction evidence; otherwise omitted.

## Commands

### `doctor`
Read-only environment + dependency check. Verifies wallet unlocked and signer-matched, sBTC and STX balances, gas reserve, Hiro reachable, Zest V2 Market contract (`v0-4-market`) interface readable, Bitflow swap aggregator reachable, `nonce-manager` available, no unresolved checkpoint blocking new writes.

```bash
NETWORK=mainnet bun run skills/sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts doctor --wallet SP...
```

### `status`
Read-only canonical Zest read. Returns current debt, collateral amount, health factor, liquidation state, accrued interest / current repay amount, safe withdrawable collateral, idle wallet balances, and active checkpoint state if any. Does not propose execution.

```bash
NETWORK=mainnet bun run skills/sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts status --wallet SP... --debt-asset STX
```

### `plan`
Produces the proposed unwind plan and ordered legs without broadcasting. Reports selected mode (A / B / C / D), repay target, swap plan if applicable, withdraw plan if applicable, projected post-leg health factor, gas estimates, dependency status. Surfaces the EV check on whether gas + slippage make optional swap or withdrawal economically pointless.

```bash
NETWORK=mainnet bun run skills/sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts plan --wallet SP... --debt-asset STX --repay-bps 5000
```

### `run`
Executes the unwind. Requires `--confirm UNWIND`. For each leg in strict order:
1. Acquire nonce via `nonce-manager`.
2. Check sender mempool depth.
3. Broadcast exactly one leg (swap-for-repay → repay → withdraw-collateral → residual-swap, depending on mode).
4. Wait for `tx_status: success` on Hiro before the next leg.
5. Persist checkpoint (unwindId, step, completed txid, observed pre/post position, timestamp).
6. Release nonce.

Refuses if a prior unwind is unresolved (use `resume` or `cancel` first).

```bash
NETWORK=mainnet bun run skills/sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts run --wallet SP... --debt-asset STX --repay-amount 1000000 --confirm UNWIND
```

### `resume`
Resumes an unresolved unwind from checkpoint state. On-chain reads must match the saved checkpoint before continuation.

```bash
NETWORK=mainnet bun run skills/sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts resume --wallet SP... --confirm RESUME
```

### `cancel`
Marks an unresolved unwind as cancelled. No on-chain action — partial state is the operator's responsibility to reconcile (typically by direct primitive calls). Permitted only when no unsafe partial state remains.

```bash
NETWORK=mainnet bun run skills/sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts cancel --wallet SP... --confirm CANCEL
```

## Required CLI options

| Option | Required | Purpose |
|---|---|---|
| `--wallet <stacks-address>` | Yes | Wallet that owns the position and signs writes |
| `--debt-asset <symbol>` | Yes | Debt asset to repay; first required target is `STX` |
| `--repay-amount <base-units>` | Conditional | Exact repay amount |
| `--repay-bps <bps>` | Conditional | Percentage of current debt to repay |
| `--repay-all` | Conditional | Close the debt when feasible |
| `--swap-for-repay` | No | Permit swap of free wallet assets to acquire repayment asset |
| `--swap-source-asset <symbol>` | Conditional | Asset to swap into repayment asset |
| `--allow-collateral-release-for-repay` | No | Permit bounded pre-repay collateral release only if canonical reads prove it safe |
| `--withdraw-collateral` | No | Withdraw safe collateral after repay |
| `--withdraw-amount <base-units>` | Conditional | Requested collateral withdrawal amount |
| `--max-quote-staleness-seconds <seconds>` | No | Maximum quote age before swap broadcast |
| `--slippage-bps <bps>` | No | Minimum-output tolerance for swap leg |
| `--min-health-factor <value>` | No | Minimum projected health factor after each leg |
| `--max-ltv-bps <bps>` | No | Maximum allowed LTV after every leg |
| `--min-gas-reserve-ustx <uSTX>` | No | Required gas reserve before each write |
| `--mempool-depth-limit <count>` | No | Pending sender transaction limit before each write |
| `--wait-seconds <seconds>` | No | Confirmation wait window |
| `--confirm UNWIND` | Required for `run` | Explicit write confirmation |

Exactly one of `--repay-amount`, `--repay-bps`, or `--repay-all` must be provided for `run`.

## Modes

### Mode A — Direct Repay
Default when the wallet already holds enough STX to repay. Sequence: read position → repay STX debt → wait → re-read position → optional collateral withdrawal. Preferred path because it reduces debt before touching collateral.

### Mode B — Swap Free Wallet Assets For Repay
Used when the wallet lacks enough STX but has free wallet assets that are not Zest collateral. Opt-in via `--swap-for-repay`. Sequence: read → fresh Bitflow quote → swap free asset to STX → wait → repay → wait → re-read.

### Mode C — Collateral-Release Assisted Repay
Tightly bounded fallback. Withdrawing collateral before repayment can increase liquidation risk. Requires `--allow-collateral-release-for-repay` AND canonical Zest reads must prove the specific withdrawal amount is safe before repayment AND post-withdraw projected health factor must remain above the configured floor. If the implementation cannot prove pre-repay collateral release is safe from canonical protocol reads, it blocks. Local LTV math alone is insufficient.

### Mode D — Post-Repay Collateral Withdrawal
Used after a successful repay and a fresh canonical post-repay re-read. Requires `--withdraw-collateral`. Sequence: repay confirmed → re-read Zest → calculate safe withdrawable collateral → withdraw requested safe amount.

## State machine

```text
idle
  → unwind_plan_created
  → optional_swap_for_repay_planned
  → optional_swap_for_repay_broadcast
  → optional_swap_for_repay_confirmed
  → repay_planned
  → repay_broadcast
  → repay_confirmed
  → post_repay_position_read
  → optional_collateral_withdraw_planned
  → optional_collateral_withdraw_broadcast
  → optional_collateral_withdraw_confirmed
  → optional_residual_swap_planned
  → optional_residual_swap_broadcast
  → optional_residual_swap_confirmed
  → complete
```

If execution cannot continue, state becomes `blocked_partial_unwind`. The next invocation must refuse new unwind, cycle, or borrow actions until `resume` or `cancel`.

## Output contract

Every command prints exactly one JSON object to stdout.

Success:

```json
{
  "status": "success",
  "action": "doctor | status | plan | run | resume | cancel",
  "data": {
    "unwindId": "...",
    "state": "...",
    "wallet": "SP...",
    "position": {},
    "risk": {},
    "repayPlan": {},
    "swapPlan": {},
    "withdrawPlan": {},
    "checkpoint": {},
    "transactions": [],
    "nextAction": "..."
  },
  "error": null
}
```

Blocked:

```json
{
  "status": "blocked",
  "action": "...",
  "data": {
    "code": "STALE_QUOTE | INSUFFICIENT_REPAY_ASSET | UNSAFE_COLLATERAL_WITHDRAWAL | PENDING_TX | UNRESOLVED_CHECKPOINT",
    "message": "...",
    "observed": {},
    "threshold": {},
    "next": "..."
  },
  "error": null
}
```

Error: `{"status":"error","action":"...","data":{},"error":"descriptive message"}` with non-zero exit code.

## Checkpoint requirements

JSON file at `~/.aibtc/sbtc-leverage-unwind-planner/<unwindId>.json`. Schema:

- `unwindId`, `wallet`, `debtAsset`, `collateralAsset`, `repayTarget`, `currentStep`
- `swapTxId`, `repayTxId`, `withdrawTxId`, `residualSwapTxId`
- `preRunDebt`, `preRunCollateral`, `postRepayDebt`, `postRepayCollateral`
- `healthFactorAfterEachLeg`, `pendingDepthBeforeEachWrite`, `timestampPerLeg`
- `nextRequiredAction`, `blockedReason`

Never contains secrets, private keys, mnemonics, wallet passwords, raw signed transactions, or API tokens.

## Acceptance criteria

- One skill directory only: `skills/sbtc-leverage-unwind-planner/`.
- Directory contains only `SKILL.md`, `AGENT.md`, and `sbtc-leverage-unwind-planner.ts`.
- `metadata.requires` lists primitive dependencies.
- No bundled primitive directories.
- No source imports from other skill directories.
- Commander.js CLI.
- `doctor`, `status`, `plan`, `run`, `resume`, and `cancel` exist.
- `run` refuses without `--confirm UNWIND`.
- Repay can run independently of the leverage cycle controller.
- Default path is repay-first.
- Withdraw-first behavior is blocked unless explicitly allowed and canonically proven safe.
- Checkpoint/resume behavior is documented and testable.
- Mempool and nonce checks occur before every write leg.
- Every write leg waits for confirmation before the next leg.

## On-chain proof

Mainnet proof block populated at submission time per the PR body, containing the 8 proof items required by the PRD: `doctor`, `status`, `plan`, Zest repay tx, post-repay status check, optional Zest collateral withdrawal tx (if claimed), optional Bitflow swap tx (if claimed), and resume/checkpoint demonstration. Each item: command used, explorer link for write txs, sender address, contract, function, `tx_status: success`, postcondition mode, postconditions or documented protocol limitation, command output or verification JSON.

## Differentiation from existing work

`https://github.com/BitflowFinance/bff-skills/pull/348` (`sbtc-leverage-looper`) is the only adjacent staging attempt. It is disqualified by the PRD on four counts: outputs ordered contract-call instructions instead of executing per-leg; sequences `withdraw collateral → swap → repay` (not the safe-default repay-first); does not prove an executed unwind on mainnet; does not provide durable checkpoint/resume.

No upstream `aibtcdev/skills` registry skill covers leveraged-position unwind. `zest-auto-repay` is single-leg; `zest-yield-manager.withdraw` operates on yield-side supplied sBTC, not collateral.

## Out of scope

The skill must not: open a leverage position, borrow, run a new leverage cycle, silently sell wallet assets, blindly withdraw collateral before repayment, re-supply collateral, manage HODLMM LP bins, run autonomous multi-cycle strategies, hide partial-state risk, retry failed writes blindly, or hardcode wallets.
