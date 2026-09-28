/**
 * x-read — read-only X/Twitter CLI for NanoClaw agents. See ../SKILL.md.
 *
 * Swapping providers: replace the `./provider-twitterapi.ts` import with another
 * module exporting the same functions + PRICING. Nothing else here is provider-specific.
 */
import { parseArgs } from 'node:util';

import {
  collect,
  dedupe,
  parseMax,
  parseTime,
  profileMarkdown,
  sortTweets,
  tweetId,
  tweetsMarkdown,
  UsageError,
  type SortMode,
} from './core.ts';
import * as provider from './provider-twitterapi.ts';
import { ApiError, type Tweet } from './types.ts';
import { BudgetError, checkBudget, Meter, usageReport } from './usage.ts';

const HELP = `x-read — read-only X/Twitter lookups (twitterapi.io via the credential gateway)

  x-read search "<query>" [--top] [--since 7d|YYYY-MM-DD] [--until ...] [--max 40] [--json]
  x-read user <handle> [--replies] [--since 7d] [--until ...] [--max 40] [--json]
  x-read list <listId> [--replies] [--since 7d] [--until ...] [--max 40] [--json]
  x-read tweet <id|url>[,<id|url>...] [--json]
  x-read thread <id|url> [--max 40] [--json]
  x-read profile <handle> [--json]
  x-read usage [--month]        local spend estimate vs monthly budget
  x-read credits                remaining provider credits (live)

--max is a hard cap on tweets fetched (default 40, ceiling 200). --force overrides the budget guard.
Exit codes: 1 API/HTTP error, 2 bad usage, 3 budget refused.`;

const warn = (msg: string) => console.error(msg);

async function main(argv: string[]): Promise<void> {
  const { values: f, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      top: { type: 'boolean' },
      since: { type: 'string' },
      until: { type: 'string' },
      max: { type: 'string' },
      json: { type: 'boolean' },
      replies: { type: 'boolean' },
      month: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || f.help || command === 'help') {
    console.log(HELP);
    return;
  }

  if (command === 'usage') {
    console.log(usageReport(Boolean(f.month)));
    return;
  }
  if (command === 'credits') {
    const c = await provider.credits();
    console.log(`Remaining twitterapi.io credits: ${c.recharge + c.bonus} (${c.recharge} purchased + ${c.bonus} bonus)`);
    return;
  }

  const arg = rest.join(' ').trim();
  if (!arg) throw new UsageError(`${command}: missing argument. Run x-read --help.`);
  const max = parseMax(f.max);
  const sinceMs = f.since ? parseTime(f.since) : undefined;
  const untilMs = f.until ? parseTime(f.until) : undefined;
  const handle = arg.replace(/^@/, '');

  checkBudget(provider.PRICING, Boolean(f.force), warn);
  const meter = new Meter(command, provider.PRICING);
  const onPage = (n: number) => meter.tweets(n);

  try {
    let tweets: Tweet[];
    let title: string;
    let sort: SortMode = 'newest';
    switch (command) {
      case 'search':
        tweets = await collect((c) => provider.search(arg, { top: Boolean(f.top), sinceMs, untilMs }, c), {
          max,
          sinceMs,
          untilMs,
          onPage,
        });
        title = `X search: ${arg}${f.top ? ' (top)' : ''}`;
        if (f.top) sort = 'engagement';
        break;
      case 'user':
        tweets = await collect((c) => provider.userTweets(handle, { replies: Boolean(f.replies) }, c), {
          max,
          sinceMs,
          untilMs,
          stopWhenPageOld: true,
          onPage,
        });
        title = `@${handle} recent tweets`;
        break;
      case 'list':
        tweets = await collect(
          (c) => provider.listTweets(arg, { replies: Boolean(f.replies), sinceMs, untilMs }, c),
          { max, sinceMs, untilMs, onPage },
        );
        title = `X list ${arg}`;
        break;
      case 'tweet': {
        const ids = [...new Set(arg.split(/[\s,]+/).filter(Boolean).map(tweetId))].slice(0, max);
        const page = await provider.tweetsByIds(ids);
        onPage(page.tweets.length);
        tweets = page.tweets;
        title = `Tweets ${ids.join(', ')}`;
        break;
      }
      case 'thread':
        tweets = await collect((c) => provider.threadContext(tweetId(arg), c), { max, onPage });
        title = `Thread around ${tweetId(arg)}`;
        sort = 'oldest';
        break;
      case 'profile': {
        const p = await provider.profile(handle);
        meter.profiles(1);
        console.log(f.json ? JSON.stringify(p, null, 2) : profileMarkdown(p));
        return;
      }
      default:
        throw new UsageError(`unknown command "${command}". Run x-read --help.`);
    }
    tweets = sortTweets(dedupe(tweets), sort);
    console.log(f.json ? JSON.stringify(tweets, null, 2) : tweetsMarkdown(title, tweets));
  } finally {
    meter.flush();
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof ApiError) {
    console.error(`x-read: ${err.message}`);
    // Always show the body: gateway refusals (401/403) carry the connect/secret URL the operator needs.
    console.error(err.body.slice(0, 4000));
    process.exit(1);
  }
  if (err instanceof BudgetError) {
    console.error(err.message);
    process.exit(3);
  }
  if (err instanceof UsageError || err?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    console.error(`x-read: ${err.message}`);
    process.exit(2);
  }
  console.error(`x-read: ${err?.message ?? err}`);
  process.exit(1);
});
