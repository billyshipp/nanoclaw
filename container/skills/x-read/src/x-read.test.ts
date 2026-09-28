// Run inside an agent container: `bun test /app/skills/x-read/src`
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collect, parseMax, parseTime, sortTweets, tweetId, tweetLine } from './core.ts';
import { normalizeTweet, PRICING } from './provider-twitterapi.ts';
import type { Page, Tweet } from './types.ts';
import { BudgetError, checkBudget, Meter, monthSpend, readLog } from './usage.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-27T12:00:00Z');

function tw(id: string, daysAgo: number, extra: Partial<Tweet> = {}): Tweet {
  return {
    id,
    url: `https://x.com/a/status/${id}`,
    author: 'a',
    name: 'A',
    createdAt: new Date(NOW - daysAgo * DAY).toISOString(),
    text: `tweet ${id}`,
    likes: 0,
    retweets: 0,
    replies: 0,
    views: 0,
    isReply: false,
    isRetweet: false,
    quotedUrl: null,
    ...extra,
  };
}

function pager(pages: Tweet[][]) {
  const calls: string[] = [];
  const fetchPage = async (cursor: string): Promise<Page> => {
    calls.push(cursor);
    const i = cursor ? Number(cursor) : 0;
    return { tweets: pages[i] ?? [], nextCursor: i + 1 < pages.length ? String(i + 1) : null };
  };
  return { fetchPage, calls };
}

describe('parsing', () => {
  test('relative and absolute times', () => {
    expect(parseTime('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(parseTime('12h', NOW)).toBe(NOW - 12 * 3_600_000);
    expect(parseTime('1790000000')).toBe(1_790_000_000_000);
    expect(new Date(parseTime('2026-09-20')).getHours()).toBe(0); // local midnight
    expect(() => parseTime('last week')).toThrow();
  });

  test('--max default, ceiling, validation', () => {
    expect(parseMax(undefined)).toBe(40);
    expect(parseMax('500')).toBe(200);
    expect(() => parseMax('0')).toThrow();
  });

  test('tweet ids from urls', () => {
    expect(tweetId('https://x.com/SpaceX/status/1846987139428634858?s=20')).toBe('1846987139428634858');
    expect(tweetId('https://twitter.com/i/statuses/123')).toBe('123');
    expect(tweetId('987')).toBe('987');
    expect(() => tweetId('SpaceX')).toThrow();
  });
});

describe('collect', () => {
  test('stops at --max fetched', async () => {
    const pages = [0, 1, 2].map((p) => Array.from({ length: 20 }, (_, i) => tw(`${p}-${i}`, p)));
    const { fetchPage, calls } = pager(pages);
    const out = await collect(fetchPage, { max: 30, onPage: () => {} });
    expect(calls.length).toBe(2);
    expect(out.length).toBe(30);
  });

  test('old pinned tweet does not end a timeline early', async () => {
    const pages = [
      [tw('pinned', 400), tw('1', 1), tw('2', 2)],
      [tw('3', 3), tw('4', 9)],
      [tw('5', 10), tw('6', 11)],
    ];
    const { fetchPage, calls } = pager(pages);
    const out = await collect(fetchPage, { max: 40, sinceMs: NOW - 7 * DAY, stopWhenPageOld: true, onPage: () => {} });
    expect(out.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(calls.length).toBe(3); // page 2 had a fresh tweet, page 3 was all old → stop
  });

  test('reports every page to the meter', async () => {
    const seen: number[] = [];
    const { fetchPage } = pager([[tw('1', 0), tw('2', 0)], []]);
    await collect(fetchPage, { max: 40, onPage: (n) => seen.push(n) });
    expect(seen).toEqual([2, 0]);
  });
});

describe('format', () => {
  test('normalizes twitterapi.io tweets', () => {
    const t = normalizeTweet({
      id: '5',
      url: 'https://twitter.com/bob/status/5',
      text: 'RT @al: trunc…',
      createdAt: 'Tue Dec 10 07:00:30 +0000 2024',
      likeCount: 3,
      author: { userName: 'bob', name: 'Bob' },
      retweeted_tweet: { id: '4', text: 'full original text', author: { userName: 'al' } },
      quoted_tweet: { id: '3', author: { userName: 'cy' } },
    });
    expect(t.url).toBe('https://x.com/bob/status/5');
    expect(t.createdAt).toBe('2024-12-10T07:00:30.000Z');
    expect(t.text).toBe('RT @al: full original text');
    expect(t.isRetweet).toBe(true);
    expect(t.quotedUrl).toBe('https://x.com/cy/status/3');
  });

  test('one line per tweet, collapsed and truncated', () => {
    const line = tweetLine(tw('9', 0, { text: 'a\n\nb ' + 'x'.repeat(400), likes: 12_345, views: 1_200_000 }));
    expect(line).not.toContain('\n');
    expect(line).toContain('♥12k');
    expect(line).toContain('👁 1.2M');
    expect(line).toContain('https://x.com/a/status/9');
    expect(line.length).toBeLessThan(420);
  });

  test('engagement sort', () => {
    const out = sortTweets([tw('lo', 0, { likes: 1 }), tw('hi', 1, { likes: 100 })], 'engagement');
    expect(out[0].id).toBe('hi');
  });
});

describe('usage + budget', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'x-read-'));
    process.env.X_READ_STATE_DIR = dir;
    delete process.env.X_READ_MONTHLY_BUDGET_USD;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.X_READ_STATE_DIR;
    delete process.env.X_READ_MONTHLY_BUDGET_USD;
  });

  test('meter applies per-call minimum and logs one line', () => {
    const m = new Meter('search', PRICING);
    m.tweets(20);
    m.tweets(0);
    m.flush();
    const [e] = readLog();
    expect(e.calls).toBe(2);
    expect(e.tweets_fetched).toBe(20);
    expect(e.est_cost_usd).toBeCloseTo(0.003 + 0.00015, 6);
    expect(monthSpend()).toBeCloseTo(0.00315, 6);
  });

  test('tiny budget refuses before the first call; --force overrides', () => {
    process.env.X_READ_MONTHLY_BUDGET_USD = '0.0001';
    expect(() => checkBudget(PRICING, false, () => {})).toThrow(BudgetError);
    const warnings: string[] = [];
    checkBudget(PRICING, true, (w) => warnings.push(w));
    expect(warnings.length).toBe(1);
  });

  test('warns past 80%', () => {
    process.env.X_READ_MONTHLY_BUDGET_USD = '0.0035';
    const m = new Meter('user', PRICING);
    m.tweets(20);
    m.flush();
    const warnings: string[] = [];
    checkBudget(PRICING, false, (w) => warnings.push(w));
    expect(warnings[0]).toContain('warning');
  });
});
