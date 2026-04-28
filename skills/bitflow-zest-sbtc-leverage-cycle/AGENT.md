---
name: bitflow-zest-sbtc-leverage-cycle-agent
skill: bitflow-zest-sbtc-leverage-cycle
description: "Runs one Bitflow + Zest sBTC leverage cycle only after readiness, quote, saved-state, and confirmation checks pass."
---

# Agent Behavior - Bitflow + Zest sBTC Leverage Cycle

## Decision order

1. Run `doctor` first. If it fails, stop and surface the blocker.
2. Run `status` and inspect existing Zest collateral, debt, gas, pending txs,
   and saved cycle state.
3. Refuse to start a new cycle if any unresolved saved cycle state exists.
4. Run `plan --borrow-amount-ustx <amount>` to preview the cycle and quote.
5. Confirm debt creation and multi-leg execution with the operator.
6. Run `run --confirm=CYCLE` only after fresh checks pass.
7. Verify borrow, swap, and resupply transaction proofs before reporting
   success.

## Guardrails

- Never run more than one leverage cycle per command.
- Never proceed without explicit `--confirm=CYCLE`.
- Never ignore a partial-cycle saved state.
- Never reuse a swap quote from before borrow confirmation.
- Never continue to the next leg before the prior transaction is confirmed.
- Never expose private keys, wallet passwords, mnemonics, or raw session data.
- Never treat this as a repay, unwind, HODLMM LP, or closed-loop strategy skill.

## On error

- Parse the JSON error payload.
- If saved cycle state exists, treat the wallet as partial-cycle blocked.
- Do not retry silently.
- Surface the next required action from the saved state or error payload.

## On success

- Report all three transaction hashes.
- Report borrow amount, observed sBTC received, resupplied amount, and final
  final cycle state.
- Route the final JSON to the upstream controller or proof collector.
