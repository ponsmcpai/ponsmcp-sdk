// Spending-policy engine for autonomous agent payments.
// Env:
//   PONSMCP_MAX_PER_TX     (USDG micro-units, default 100 USDG = 100_000_000)
//   PONSMCP_DAILY_LIMIT    (USDG micro-units, default 1000 USDG = 1_000_000_000)
//   PONSMCP_POLICY_STATE   (optional path to a JSON file for cross-restart persistence)

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  spentTodayMicro: bigint;
  remainingTodayMicro: bigint;
}

interface StateFile {
  day: string;
  microSpent: string; // bigint as decimal string
}

export class PolicyEngine {
  readonly maxPerTx: bigint;
  readonly dailyLimit: bigint;
  private spent: { day: string; micro: bigint } = { day: this.today(), micro: 0n };
  private readonly statePath: string | null;

  constructor(opts?: { maxPerTx?: bigint; dailyLimit?: bigint }) {
    this.maxPerTx = opts?.maxPerTx ?? BigInt(process.env.PONSMCP_MAX_PER_TX ?? 100_000_000);
    this.dailyLimit = opts?.dailyLimit ?? BigInt(process.env.PONSMCP_DAILY_LIMIT ?? 1_000_000_000);
    if (this.maxPerTx <= 0n || this.dailyLimit <= 0n) throw new Error('policy limits must be > 0');
    if (this.maxPerTx > this.dailyLimit) throw new Error('maxPerTx cannot exceed dailyLimit');

    // File-based persistence: read state on startup if configured.
    this.statePath = process.env.PONSMCP_POLICY_STATE?.trim() || null;
    if (this.statePath) {
      this.spent = this.loadState();
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Load state from disk. Returns today's spent or zero-reset if file missing/stale/corrupt. */
  private loadState(): { day: string; micro: bigint } {
    const today = this.today();
    try {
      if (!existsSync(this.statePath!)) return { day: today, micro: 0n };
      const raw = readFileSync(this.statePath!, 'utf8');
      const parsed: StateFile = JSON.parse(raw);
      if (parsed.day === today) {
        return { day: today, micro: BigInt(parsed.microSpent) };
      }
      // Different day — reset (the file is stale)
      return { day: today, micro: 0n };
    } catch {
      // Corrupt or unreadable — start fresh
      return { day: today, micro: 0n };
    }
  }

  /** Atomically persist state to disk. Never throws — silently falls back to in-process. */
  private saveState(): void {
    if (!this.statePath) return;
    try {
      const data: StateFile = { day: this.spent.day, microSpent: this.spent.micro.toString() };
      const tmp = this.statePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, this.statePath);
    } catch {
      // Persistence failure is non-fatal; in-process state remains correct.
    }
  }

  check(amountMicro: bigint): PolicyDecision {
    const day = this.today();
    if (this.spent.day !== day) {
      this.spent = { day, micro: 0n };
      this.saveState();
    }
    const remaining = this.dailyLimit - this.spent.micro;
    if (amountMicro > this.maxPerTx) {
      return { allowed: false, reason: `amount exceeds max_per_transaction (${this.maxPerTx} micro)`, spentTodayMicro: this.spent.micro, remainingTodayMicro: remaining };
    }
    if (amountMicro > remaining) {
      return { allowed: false, reason: `amount exceeds remaining daily budget (${remaining} micro)`, spentTodayMicro: this.spent.micro, remainingTodayMicro: remaining };
    }
    return { allowed: true, reason: 'ok', spentTodayMicro: this.spent.micro, remainingTodayMicro: remaining };
  }

  record(amountMicro: bigint): void {
    const day = this.today();
    if (this.spent.day !== day) this.spent = { day, micro: 0n };
    this.spent.micro += amountMicro;
    this.saveState();
  }
}
