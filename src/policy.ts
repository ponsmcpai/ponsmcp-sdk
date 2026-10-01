// Spending-policy engine for autonomous agent payments.
// Env:
//   PONSMCP_MAX_PER_TX   (USDG micro-units, default 100 USDG = 100_000_000)
//   PONSMCP_DAILY_LIMIT  (USDG micro-units, default 1000 USDG = 1_000_000_000)

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  spentTodayMicro: bigint;
  remainingTodayMicro: bigint;
}

export class PolicyEngine {
  readonly maxPerTx: bigint;
  readonly dailyLimit: bigint;
  private spent: { day: string; micro: bigint } = { day: this.today(), micro: 0n };

  constructor(opts?: { maxPerTx?: bigint; dailyLimit?: bigint }) {
    this.maxPerTx = opts?.maxPerTx ?? BigInt(process.env.PONSMCP_MAX_PER_TX ?? 100_000_000);
    this.dailyLimit = opts?.dailyLimit ?? BigInt(process.env.PONSMCP_DAILY_LIMIT ?? 1_000_000_000);
    if (this.maxPerTx <= 0n || this.dailyLimit <= 0n) throw new Error('policy limits must be > 0');
    if (this.maxPerTx > this.dailyLimit) throw new Error('maxPerTx cannot exceed dailyLimit');
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  check(amountMicro: bigint): PolicyDecision {
    const day = this.today();
    if (this.spent.day !== day) this.spent = { day, micro: 0n };
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
  }
}
