---
title: sBTC Leverage Position Unwind
description: Safely reduce or close a leveraged sBTC position on Zest V2 with repay-first ordering, optional swap-for-repay, and post-confirmation collateral withdrawal.
skills: [wallet, signing, settings, bitflow-swap-aggregator, sbtc-leverage-unwind-planner]
estimated-steps: 6
order: 24
---

# sBTC Leverage Position Unwind

This guide is the safety-backstop for the leveraged sBTC round-trip. It safely reduces or closes an existing leveraged sBTC position on Zest V2 by repaying debt first, re-reading canonical Zest state, and optionally withdrawing collateral after the repay confirms.

The controller never withdraws collateral before repaying — that ordering is enforced. If your wallet does not hold enough debt asset to repay, you can opt in to a single Bitflow swap-for-repay leg via `--swap-for-repay`. A bounded fallback that releases a small amount of collateral pre-repay is available behind `--allow-collateral-release-for-repay`, but only when canonical reads prove the projected post-action health factor stays above the configured floor.

All operations are mainnet-only. Write operations require an unlocked wallet. Every write leg passes through `--confirm UNWIND` and the underlying primitive's own confirm gate.

## Prerequisites

- [ ] Wallet unlocked on mainnet (`NETWORK=mainnet`)
- [ ] Existing leveraged sBTC position on Zest V2 (collateral supplied + debt borrowed)
- [ ] STX gas reserve above 200,000 uSTX (allow ~70,000 uSTX per write leg × up to 3 legs)
- [ ] Health-factor floor known (default min HF: 1.5)
- [ ] No pending STX transactions from the sender in the mempool
- [ ] No unresolved unwind checkpoint on this wallet (`status` returns `state: idle` or `state: complete`)

## Steps

### 1. Preflight — Doctor

Run the unwind controller's `doctor`. It verifies wallet readiness, swap-aggregator availability, gas, nonce health, mempool depth, and checkpoint state.

```bash
NETWORK=mainnet bun run sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts doctor \
  --wallet <your-stacks-address>
```

Expected output: `"status": "success"` with each readiness dimension green. If any dimension is blocked (e.g. `checkpoint.unresolved: true`), resolve it before continuing — the controller refuses to start a new unwind while a prior one is unresolved.

### 2. Read State — Canonical Zest Position

Read your current leveraged position via the controller (proxies `v0-assets.get-bitmap` + `v0-market-vault.get-position`).

```bash
NETWORK=mainnet bun run sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts status \
  --wallet <your-stacks-address> \
  --debt-asset STX
```

Expected output: pre-unwind `position.collateralSbtc`, `position.debt` (with accrued interest), `position.healthFactor`, plus `walletBalance.debtAssetUstx` showing how much of the debt asset is sitting in your wallet.

### 3. Plan the Unwind

Generate the read-only execution plan. Pick one of four modes via flags; the controller selects the safest applicable path.

```bash
# Mode A — Direct Repay (default; wallet has enough debt asset)
NETWORK=mainnet bun run sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts plan \
  --wallet <your-stacks-address> \
  --debt-asset STX \
  --repay-bps 10000

# Mode B — Swap-for-Repay (wallet lacks debt asset; swap a free wallet asset)
NETWORK=mainnet bun run sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts plan \
  --wallet <your-stacks-address> \
  --debt-asset STX \
  --repay-all \
  --swap-for-repay --swap-source-asset sBTC

# Mode D — Post-Repay Collateral Withdrawal (after repay; release some/all collateral)
NETWORK=mainnet bun run sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts plan \
  --wallet <your-stacks-address> \
  --debt-asset STX \
  --repay-all \
  --withdraw-collateral
```

Expected output: `unwindId`, `state: unwind_plan_created`, `steps[]` (1-3 ordered legs depending on mode), `economics.projectedHealthFactor`, `economics.estimatedGasUstx`. For Mode B, `steps[0]` is the swap leg with a fresh `quote` block.

> Note: Quote freshness applies in Mode B exactly as in the cycle controller — re-run `plan` if more than 60 seconds elapse before `run`.

### 4. Execute the Unwind

Run the planned unwind with explicit confirmation. Each leg waits for confirmation before the next is broadcast.

```bash
# Mode A example
NETWORK=mainnet bun run sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts run \
  --wallet <your-stacks-address> \
  --debt-asset STX \
  --repay-bps 10000 \
  --confirm UNWIND
```

Expected output: a per-leg `transactions[]` array, a final `state: complete`, and a checkpoint at `~/.aibtc/sbtc-leverage-unwind-planner/<unwindId>.json`.

> Note: Repay-first ordering is enforced. The controller refuses any plan that withdraws collateral before debt is repaid unless `--allow-collateral-release-for-repay` is set AND canonical reads prove the projected post-release HF stays above the floor.

### 5. Resume on Failure (Conditional)

If the run was interrupted before `state: complete`, resume from the checkpoint:

```bash
NETWORK=mainnet bun run sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts resume \
  --wallet <your-stacks-address> \
  --confirm RESUME
```

Expected output: the controller re-reads on-chain status for already-broadcast txids, validates against the checkpoint, and advances state. Will not re-broadcast a leg that already has a `success` txid.

### 6. Verify Final Position

Re-read the canonical Zest position post-unwind:

```bash
NETWORK=mainnet bun run sbtc-leverage-unwind-planner/sbtc-leverage-unwind-planner.ts status \
  --wallet <your-stacks-address> \
  --debt-asset STX
```

Expected output: `position.debt` reduced by the repay amount; if `--withdraw-collateral` was used, `position.collateralSbtc` reduced and your wallet's sBTC balance increased; `position.healthFactor` reflects the new state.

## Verification

At the end of this workflow, verify:

- [ ] `doctor` (Step 1) returned `success` with no checkpoint conflict
- [ ] Pre-unwind position read (Step 2) showed expected debt and HF
- [ ] Plan (Step 3) selected the correct mode and projected post-unwind HF stayed above the floor
- [ ] All planned legs in Step 4 returned `tx_status: success`
- [ ] Post-unwind position (Step 6) shows debt reduced by the repaid amount and (if applicable) collateral reduced
- [ ] Checkpoint file at `~/.aibtc/sbtc-leverage-unwind-planner/<unwindId>.json` shows `state: complete`

## Safety Contract

| Guard | Rule |
|-------|------|
| Confirm gate | Top-level `--confirm UNWIND`; each primitive's own confirm gate also passed (`--confirm SWAP` for Mode B) |
| Repay-first ordering | Withdraw never broadcasts before repay; refused unless explicit `--allow-collateral-release-for-repay` AND canonical safety proof |
| Full-repay accuracy | Mode A `--repay-all` accounts for accrued interest at read time |
| Quote freshness | Mode B swap quote re-fetched immediately before broadcast; 60s staleness threshold |
| Mempool depth | Pre-flight check before every write leg |
| Nonce serialization | Each leg waits for the prior's confirmation; no concurrent broadcasts |
| HF floor | Plan-projected HF must stay above configured min after every leg; `run` blocks if projection fails |
| PostConditionMode | `Deny` on every write leg with explicit token-flow postconditions |
| Checkpoint blocking | Any unresolved unwind checkpoint blocks new unwind, cycle, or borrow writes |
| No blind retries | Failed/pending/unknown/not-indexed leg statuses do not auto-retry; require explicit `resume` |

## Related Skills

| Skill | Used For |
|-------|---------|
| `wallet` | Wallet unlock for transaction signing |
| `signing` | Transaction signing primitive |
| `settings` | Read network config and gas defaults |
| `bitflow-swap-aggregator` | Mode B swap-for-repay leg (and optional residual swap) |
| `sbtc-leverage-unwind-planner` | Top-level unwind controller — direct Zest V2 Market repay + collateral-remove-redeem calls |

## See Also

- [Bitflow + Zest sBTC Leverage Cycle](./bitflow-zest-sbtc-leverage-cycle.md)
- [HODLMM Yield Router](./hodlmm-yield-router.md)
- [Swap Tokens](./swap-tokens.md)
