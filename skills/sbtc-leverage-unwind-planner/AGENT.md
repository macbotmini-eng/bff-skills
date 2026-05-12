---
name: sBTC Leverage Unwind Planner
skill: sbtc-leverage-unwind-planner
description: "Composed write skill that safely reduces or closes a leveraged sBTC position. Repays Zest debt first, re-reads canonical state, then optionally withdraws collateral or swaps residuals. Refuses unsafe withdraw-first orderings, persists checkpoint state, and resumes from partial states without overwriting them."
---

# Agent Behavior — sBTC Leverage Unwind Planner

## Decision order

1. Run `wallet status` to confirm the wallet is unlocked. If locked, surface and stop. Do not attempt to unlock — that is operator-driven.
2. Run `sbtc-leverage-unwind-planner doctor --wallet $W` to verify the wallet is signer-matched, Zest V2 Market interface is readable, Bitflow swap aggregator is reachable, gas reserve and mempool depth are within thresholds, and no unresolved checkpoint blocks new writes. If `status: blocked`, surface the blocker and stop.
3. Run `sbtc-leverage-unwind-planner status --wallet $W --debt-asset STX` to read the canonical Zest position. Use the read for any subsequent decision logic; do not infer from cached state.
4. Run `sbtc-leverage-unwind-planner plan --wallet $W --debt-asset STX --repay-bps <bps>` (or `--repay-amount` / `--repay-all`) to generate the unwind plan. Do not skip `plan` — it surfaces the mode selection (A/B/C/D), the projected post-leg health factor, the gas/slippage EV check, and the per-leg primitive invocations the controller will issue.
5. If `data.repayPlan.mode == "blocked"`: stop. Surface the blocker code (`STALE_QUOTE | INSUFFICIENT_REPAY_ASSET | UNSAFE_COLLATERAL_WITHDRAWAL | PENDING_TX | UNRESOLVED_CHECKPOINT`) and the suggested next action. Do not attempt `run`.
6. Confirm operator intent before proceeding to `run`. The skill requires `--confirm UNWIND`; do not auto-confirm. If swap-for-repay is needed, the operator must explicitly pass `--swap-for-repay`. If pre-repay collateral release is part of the plan, the operator must explicitly pass `--allow-collateral-release-for-repay`.
7. Run `sbtc-leverage-unwind-planner run --wallet $W --debt-asset STX --repay-amount <amount> --confirm UNWIND` (with mode-appropriate flags). Watch the JSON output stream — each completed leg increments `data.checkpoint.currentStep` and appends to `data.transactions`.
8. On success: confirm the on-chain final state via Hiro lookup of every `data.transactions[*].txid`. Each must return `tx_status: success`. Surface a summary including all txids, debt reduction, collateral released (if any), final health factor, and total gas spent.
9. On error or partial completion: do not retry silently. Read `data.checkpoint.nextRequiredAction`. Surface to operator with the saved checkpoint file path and the recommended next subcommand (`resume` or `cancel`). Note: `complete` state guarantees canonical Zest debt reduction but does not guarantee collateral recovery. If `--withdraw-collateral` was passed and the withdraw leg was never broadcast, the controller can still reach `complete` after the canonical-debt check — operators relying on collateral recovery must verify against `status` after `complete`, not the state flag alone, and the remediation path is to re-run `unwind --withdraw-collateral` against the now-debt-reduced position.

## Guardrails

- **Repay-first is the safe default.** Never propose `withdraw collateral → swap → repay`. The PRD explicitly rejects that ordering. The only way to release collateral before repay is `--allow-collateral-release-for-repay`, and that path requires canonical-read proof of safety; do not approximate from local LTV math.
- **Never proceed past an error without explicit operator confirmation.** A single failed leg means the unwind is partially executed; on-chain state may be unsafe. Read `data.checkpoint.blockedReason` and surface it.
- **Never expose wallet password or mnemonic in args, logs, or JSON output.** Wallet AES-256-GCM encryption is not bypassed. The checkpoint file must never contain secrets, mnemonics, raw signed transactions, or API tokens.
- **Always run `plan` before `run`.** The plan output is auditable evidence of what the controller will do; running without a plan skips the canonical-read safety checks operators rely on.
- **Default to `block` when intent is ambiguous, data is stale, or any dependency reports `blocked`.** Movement requires the canonical Zest reads to confirm safety AND every dependency to report `success`.
- **Refuse new writes when a prior unwind is unresolved.** A checkpoint file with an `active unwindId` and incomplete `currentStep` is a partial unwind. Operator must `resume` (re-read confirms saved state matches chain) or `cancel` (operator-acknowledged) before another `run`.
- **Quote freshness is enforced before broadcast, not just at plan time.** The `run` path re-fetches the Bitflow quote immediately before the swap leg and blocks on staleness even if `plan` was recent.
- **Confirmation wait is per leg, not per run.** Wait for `tx_status: success` on Hiro between every leg. Do not chain broadcasts on optimistic mempool acceptance.
- **No blind retries.** A failed/pending/unknown/not-indexed status moves the state to `blocked_partial_unwind` with the tx id and next safe command. Do not re-broadcast the same leg without operator instruction.

## On error

- Log the error payload exactly as returned by the failing leg.
- Do not retry silently — partial multi-leg unwinds can leave the wallet in an unsafe state (debt reduced but collateral still supplied, or worse, collateral released without debt reduction).
- Surface to operator with:
  - The failed leg name + the contract function it was calling (`v0-4-market.repay`, `v0-4-market.withdraw-collateral`, `bitflow-swap-aggregator run`)
  - The error payload
  - The saved checkpoint file path
  - The recommended next action (`resume` after fixing the cause, or `cancel` to acknowledge partial completion and reconcile manually via direct primitive calls)

## On success

- Confirm the on-chain result by reading each `data.transactions[i].txid` via Hiro:
  ```
  curl -s https://api.hiro.so/extended/v1/tx/0x<txid> | jq '.tx_status'
  ```
  Each must return `success`. If any returns `abort_by_post_condition` or `abort_by_response`, treat the unwind as failed regardless of what the local checkpoint says.
- Update local checkpoint to `complete`.
- Report:
  - Debt reduction (in base units AND human-readable)
  - Collateral released (if any)
  - Final health factor (canonical read after the last confirmed leg)
  - List of txids with explorer links
  - Total fee cost (sum of `fee_rate * fees` from each receipt)

## Primitive composition rules

The controller composes primitive surfaces. Per `https://github.com/BitflowFinance/bff-skills/issues/483`, composition is via `metadata.requires` + this AGENT.md decision order; never via source imports between skill directories.

| Leg | Composition pattern |
|---|---|
| Zest repay | Direct contract call to `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market::repay` using the same `@stacks/transactions` write pattern as `https://github.com/aibtcdev/skills/tree/main/zest-borrow-asset-primitive`. `PostConditionMode.Deny` with explicit STX outflow postcondition. |
| Zest collateral withdraw | Direct contract call to `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market::collateral-remove-redeem` (`(ft, amount, min-underlying, receiver, price-feeds)` — vault-redeems collateral back to underlying for the receiver). Same write pattern as `https://github.com/aibtcdev/skills/tree/main/zest-asset-deposit-primitive`. `PostConditionMode.Deny` with explicit collateral-out + underlying-in postconditions. |
| Optional swap-for-repay / residual swap | Shell out to `https://github.com/aibtcdev/skills/tree/main/bitflow-swap-aggregator` with `quote --token-in --token-out --amount-in` then `run --confirm=SWAP`. Parse JSON. If `status != "success"`, stop and surface. |
| Canonical Zest reads | Hiro `/v2/contracts/call-read/...` — `v0-assets::get-bitmap()` (user's asset bitmap) → `v0-market-vault::get-position(user, bitmap)` (full position tuple: debt, collateral, HF, liquidatable). `v0-assets::get-asset-status(asset)` for per-asset state. Local LTV math only as secondary estimate. |
| Nonce + mempool discipline | `nonce-manager acquire` before each broadcast; Hiro `/extended/v1/address/<sender>/mempool` depth check; `nonce-manager release` after `tx_status: success`. |

For each shelled-out primitive call, the controller parses the JSON output. If `status: "blocked"` or `error != null`, the controller stops and surfaces the result. The controller never broadcasts on its own without going through the canonical contract function names listed above.

## Resume discipline

- `resume` is permitted only when the saved checkpoint and current on-chain state agree. Before continuing, the controller must re-read the Zest position canonically and confirm:
  - The recorded `repayTxId` (if present) reached `tx_status: success`.
  - The recorded `swapTxId` (if present) reached `tx_status: success`.
  - The recorded `withdrawTxId` (if present) reached `tx_status: success`.
  - Observed debt, collateral, and health factor are within the expected post-leg envelope.
- If any check fails, `resume` is refused. Operator must `cancel` and reconcile manually.
- `cancel` makes no on-chain action. It marks the checkpoint as resolved so new writes are no longer blocked. Permitted only when no unsafe partial state remains.

## Differentiation from existing work

This skill exists alongside but does not duplicate:
- `https://github.com/aibtcdev/skills/tree/main/bitflow-zest-sbtc-leverage-cycle` (forward leverage cycle controller, our team's, merged upstream) — opens or increases positions; this skill reduces or closes them. Both share the same primitive surface and may be invoked in sequence on the same wallet, but their checkpoint state files are separate.
- `https://github.com/aibtcdev/skills/tree/main/zest-auto-repay` (autonomous LTV guardian, single-leg) — monitors LTV and repays opportunistically; this skill is operator-initiated and composes repay + withdraw + optional swap.
- `https://github.com/BitflowFinance/bff-skills/pull/348` (`sbtc-leverage-looper`) — the only adjacent staging attempt; PRD-rejected on four counts (instructions-not-execution, withdraw-first ordering, no mainnet unwind proof, no checkpoint). This skill is the corrected design.

The agent should not invoke this skill in parallel with the forward leverage cycle controller on the same wallet within the same window — they could compete on Zest position state. If both are configured, the operator's task prompt specifies which runs.

## Out of scope for this skill

- This skill does not borrow.
- This skill does not open a leverage position.
- This skill does not run a new leverage cycle.
- This skill does not silently sell wallet assets.
- This skill does not blindly withdraw collateral before repayment.
- This skill does not re-supply collateral.
- This skill does not manage HODLMM LP bins.
- This skill does not run autonomous multi-cycle strategies.
- This skill does not hide partial-state risk.
- This skill does not retry failed writes blindly.
- This skill does not hardcode wallets.
