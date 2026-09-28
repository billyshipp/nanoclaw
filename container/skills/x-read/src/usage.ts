/**
 * Local spend log + soft monthly budget. Estimates only — the provider's own
 * dashboard (or `x-read credits`) is the source of truth for what was charged.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_BUDGET_USD = 5;

export interface UsageEntry {
  ts: string;
  command: string;
  calls: number;
  tweets_fetched: number;
  est_cost_usd: number;
}

export interface Pricing {
  tweet: number;
  profile: number;
  minPerCall: number;
}

export class BudgetError extends Error {}

const usd = (n: number) => (n >= 1 ? n.toFixed(2) : n.toFixed(4));

const stateDir = () => process.env.X_READ_STATE_DIR || '/workspace/agent/state';
export const logPath = () => join(stateDir(), 'x-read-usage.jsonl');
const configPath = () => join(stateDir(), 'x-read-config.json');

/** Env `X_READ_MONTHLY_BUDGET_USD` wins, then `state/x-read-config.json` `{ "monthlyBudgetUsd": N }`, then $5. */
export function budgetUsd(): number {
  const env = process.env.X_READ_MONTHLY_BUDGET_USD;
  if (env !== undefined && env !== '' && Number.isFinite(Number(env))) return Number(env);
  try {
    const n = Number(JSON.parse(readFileSync(configPath(), 'utf8')).monthlyBudgetUsd);
    if (Number.isFinite(n)) return n;
  } catch {
    // no config file — default
  }
  return DEFAULT_BUDGET_USD;
}

export function readLog(): UsageEntry[] {
  if (!existsSync(logPath())) return [];
  return readFileSync(logPath(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as UsageEntry];
      } catch {
        return [];
      }
    });
}

/** Local-time calendar month, matching how Billy thinks about "this month". */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthSpend(now = new Date(), entries = readLog()): number {
  const key = monthKey(now);
  return entries.filter((e) => monthKey(new Date(e.ts)) === key).reduce((s, e) => s + e.est_cost_usd, 0);
}

/**
 * Refuse when this month's spend plus one minimum-priced call would exceed the
 * budget (so a budget below one call's cost refuses immediately); warn past 80%.
 */
export function checkBudget(pricing: Pricing, force: boolean, warn: (msg: string) => void): void {
  const budget = budgetUsd();
  const spent = monthSpend();
  if (spent + pricing.minPerCall > budget) {
    const msg = `x-read: monthly budget reached (est $${spent.toFixed(4)} of $${usd(budget)}).`;
    if (!force) throw new BudgetError(`${msg} Ask Billy before continuing; rerun with --force only with his OK.`);
    warn(`${msg} Continuing because of --force.`);
  } else if (spent >= 0.8 * budget) {
    warn(`x-read: warning — est $${spent.toFixed(4)} of $${usd(budget)} monthly budget used (${Math.round((spent / budget) * 100)}%).`);
  }
}

/** Accumulates per-call cost for one command run; `flush` appends one log line. */
export class Meter {
  calls = 0;
  fetched = 0;
  cost = 0;
  constructor(
    readonly command: string,
    private readonly pricing: Pricing,
  ) {}

  tweets(n: number): void {
    this.add(n, n * this.pricing.tweet);
  }

  profiles(n: number): void {
    this.add(0, n * this.pricing.profile);
  }

  private add(fetched: number, cost: number): void {
    this.calls++;
    this.fetched += fetched;
    this.cost += Math.max(this.pricing.minPerCall, cost);
  }

  flush(): void {
    if (this.calls === 0) return;
    const entry: UsageEntry = {
      ts: new Date().toISOString(),
      command: this.command,
      calls: this.calls,
      tweets_fetched: this.fetched,
      est_cost_usd: Number(this.cost.toFixed(6)),
    };
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(logPath(), JSON.stringify(entry) + '\n');
  }
}

export function usageReport(monthOnly: boolean, now = new Date()): string {
  const entries = readLog();
  const budget = budgetUsd();
  const month = monthSpend(now, entries);
  const key = monthKey(now);
  const scoped = monthOnly ? entries.filter((e) => monthKey(new Date(e.ts)) === key) : entries;
  const byCommand = new Map<string, { runs: number; calls: number; tweets: number; cost: number }>();
  for (const e of scoped) {
    const c = byCommand.get(e.command) ?? { runs: 0, calls: 0, tweets: 0, cost: 0 };
    c.runs++;
    c.calls += e.calls;
    c.tweets += e.tweets_fetched;
    c.cost += e.est_cost_usd;
    byCommand.set(e.command, c);
  }
  const lines = [
    `**x-read usage${monthOnly ? ` (${key})` : ' (all time)'}** — log: ${logPath()}`,
    `- This month (${key}): est $${month.toFixed(4)} of $${usd(budget)} budget (${budget > 0 ? Math.round((month / budget) * 100) : 100}%)`,
  ];
  for (const [cmd, c] of [...byCommand].sort()) {
    lines.push(`- ${cmd}: ${c.runs} runs, ${c.calls} calls, ${c.tweets} tweets, est $${c.cost.toFixed(4)}`);
  }
  if (byCommand.size === 0) lines.push('- no calls logged');
  return lines.join('\n');
}
