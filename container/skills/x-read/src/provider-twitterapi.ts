/**
 * twitterapi.io provider — the only file that knows this API's URLs and shapes.
 *
 * Read-only by construction: every call is a GET to an allowlisted path.
 * Credentials are injected by the gateway; the key header carries only the
 * `gateway-managed` placeholder and this module never reads a real key.
 */
import { ApiError, type Page, type Profile, type Tweet } from './types.ts';

const BASE = 'https://api.twitterapi.io';
const TIMEOUT_MS = 30_000;

/** Estimated USD per item, from twitterapi.io pricing. Minimum charge applies per call. */
export const PRICING = { tweet: 0.00015, profile: 0.00018, minPerCall: 0.00015 };

const READ_PATHS = new Set([
  '/twitter/tweet/advanced_search',
  '/twitter/user/last_tweets',
  '/twitter/list/tweets',
  '/twitter/tweets',
  '/twitter/tweet/thread_context',
  '/twitter/user/info',
  '/oapi/my/info',
]);

type Params = Record<string, string | undefined>;

async function get(path: string, params: Params): Promise<any> {
  if (!READ_PATHS.has(path)) throw new Error(`x-read: refusing non-allowlisted path ${path}`);
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'x-api-key': 'gateway-managed', accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    // Free tier allows one request per 5s, so 429s get a few 6s retries; 5xx gets one.
    if ((res.status === 429 && attempt < 3) || (res.status >= 500 && attempt === 0)) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const fallback = res.status === 429 ? 6000 : 2000;
      await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : fallback);
      continue;
    }
    if (!res.ok) throw new ApiError(`HTTP ${res.status} from ${path}`, res.status, body);

    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ApiError(`non-JSON response from ${path}`, res.status, body);
    }
    // API-level errors arrive as 200 with { status: "error", message } or { error, message }.
    if (json?.status === 'error' || (typeof json?.error === 'number' && json.error !== 0)) {
      throw new ApiError(`API error from ${path}: ${json.message ?? json.msg ?? 'unknown'}`, res.status, body);
    }
    return json;
  }
}

function toXUrl(raw: any, author: string, id: string): string {
  const u = typeof raw?.url === 'string' && raw.url ? raw.url : `https://x.com/${author}/status/${id}`;
  return u.replace(/^https?:\/\/(www\.|mobile\.)?twitter\.com\//, 'https://x.com/');
}

function iso(createdAt: unknown): string {
  const d = new Date(String(createdAt ?? ''));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function normalizeTweet(raw: any): Tweet {
  const id = String(raw.id ?? '');
  const author = String(raw.author?.userName ?? '');
  const rt = raw.retweeted_tweet;
  const quoted = raw.quoted_tweet;
  let text = String(raw.text ?? '');
  // Retweet wrappers truncate the original; use the original's full text.
  if (rt?.text) text = `RT @${rt.author?.userName ?? '?'}: ${rt.text}`;
  return {
    id,
    url: toXUrl(raw, author, id),
    author,
    name: String(raw.author?.name ?? ''),
    createdAt: iso(raw.createdAt),
    text,
    likes: Number(raw.likeCount ?? 0),
    retweets: Number(raw.retweetCount ?? 0),
    replies: Number(raw.replyCount ?? 0),
    views: Number(raw.viewCount ?? 0),
    isReply: Boolean(raw.isReply),
    isRetweet: Boolean(rt),
    quotedUrl: quoted?.id ? toXUrl(quoted, String(quoted.author?.userName ?? ''), String(quoted.id)) : null,
  };
}

function page(json: any, key = 'tweets'): Page {
  // last_tweets has shipped both `{ tweets }` and `{ data: { tweets } }`; accept either.
  const list: any[] = json?.[key] ?? json?.data?.[key] ?? [];
  const more = Boolean(json?.has_next_page ?? json?.data?.has_next_page);
  const cursor = json?.next_cursor ?? json?.data?.next_cursor;
  return { tweets: list.map(normalizeTweet), nextCursor: more && cursor ? String(cursor) : null };
}

const unix = (ms: number | undefined) => (ms === undefined ? undefined : String(Math.floor(ms / 1000)));

export async function search(
  query: string,
  opts: { top: boolean; sinceMs?: number; untilMs?: number },
  cursor: string,
): Promise<Page> {
  const q = [query, opts.sinceMs && `since_time:${unix(opts.sinceMs)}`, opts.untilMs && `until_time:${unix(opts.untilMs)}`]
    .filter(Boolean)
    .join(' ');
  return page(await get('/twitter/tweet/advanced_search', { query: q, queryType: opts.top ? 'Top' : 'Latest', cursor }));
}

export async function userTweets(handle: string, opts: { replies: boolean }, cursor: string): Promise<Page> {
  return page(
    await get('/twitter/user/last_tweets', { userName: handle, includeReplies: String(opts.replies), cursor }),
  );
}

export async function listTweets(
  listId: string,
  opts: { replies: boolean; sinceMs?: number; untilMs?: number },
  cursor: string,
): Promise<Page> {
  return page(
    await get('/twitter/list/tweets', {
      listId,
      sinceTime: unix(opts.sinceMs),
      untilTime: unix(opts.untilMs),
      includeReplies: String(opts.replies),
      cursor,
    }),
  );
}

export async function tweetsByIds(ids: string[]): Promise<Page> {
  return page(await get('/twitter/tweets', { tweet_ids: ids.join(',') }));
}

export async function threadContext(id: string, cursor: string): Promise<Page> {
  return page(await get('/twitter/tweet/thread_context', { tweetId: id, cursor }), 'replies');
}

export async function profile(handle: string): Promise<Profile> {
  const d = (await get('/twitter/user/info', { userName: handle }))?.data ?? {};
  return {
    id: String(d.id ?? ''),
    userName: String(d.userName ?? handle),
    name: String(d.name ?? ''),
    // `d.url` is the account's website link (often t.co), not its profile.
    url: `https://x.com/${d.userName ?? handle}`,
    description: String(d.description ?? ''),
    location: String(d.location ?? ''),
    followers: Number(d.followers ?? 0),
    following: Number(d.following ?? 0),
    tweets: Number(d.statusesCount ?? 0),
    createdAt: iso(d.createdAt),
    verified: Boolean(d.isBlueVerified),
  };
}

/** Remaining account credits (provider units, not USD): purchased + bonus. */
export async function credits(): Promise<{ recharge: number; bonus: number }> {
  const d = await get('/oapi/my/info', {});
  return { recharge: Number(d?.recharge_credits ?? 0), bonus: Number(d?.total_bonus_credits ?? 0) };
}
