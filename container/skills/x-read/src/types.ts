/**
 * Provider-neutral shapes. Everything outside provider-*.ts speaks only these,
 * so swapping twitterapi.io for SocialData or the official X API means writing
 * one new provider module with the same exports.
 */

export interface Tweet {
  id: string;
  url: string;
  author: string;
  name: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  text: string;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  isReply: boolean;
  isRetweet: boolean;
  quotedUrl: string | null;
}

export interface Profile {
  id: string;
  userName: string;
  name: string;
  url: string;
  description: string;
  location: string;
  followers: number;
  following: number;
  tweets: number;
  createdAt: string;
  verified: boolean;
}

export interface Page {
  tweets: Tweet[];
  nextCursor: string | null;
}

/** HTTP or API-level failure. `body` is the raw response, kept for 401/403 gateway hints. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}
