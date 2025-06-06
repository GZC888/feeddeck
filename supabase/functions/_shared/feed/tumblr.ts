import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { FeedEntry } from "https://deno.land/x/rss@1.0.0/src/types/mod.ts";
import { unescape } from "https://raw.githubusercontent.com/lodash/lodash/4.17.21-es/lodash.js";
import { Redis } from "https://deno.land/x/redis@v0.32.0/mod.ts";

import { ISource } from "../models/source.ts";
import { IItem } from "../models/item.ts";
import { IProfile } from "../models/profile.ts";
import { utils } from "../utils/index.ts";
import { feedutils } from "./utils/index.ts";

/**
 * `isTumblrUrl` checks if the provided `url` is a valid Tumblr url. A url is
 * considered valid if the hostname starts with `tumblr.com`.
 */
export const isTumblrUrl = (url: string): boolean => {
  const parsedUrl = new URL(url);
  return parsedUrl.hostname.endsWith("tumblr.com");
};

export const getTumblrFeed = async (
  _supabaseClient: SupabaseClient,
  _redisClient: Redis | undefined,
  _profile: IProfile,
  source: ISource,
  feedData: string | undefined,
): Promise<{ source: ISource; items: IItem[] }> => {
  if (!source.options?.tumblr) {
    throw new feedutils.FeedValidationError("Invalid source options");
  }

  const parsedUrl = new URL(source.options.tumblr);
  const hostnameParts = parsedUrl.hostname.split(".");
  if (hostnameParts.length != 3) {
    throw new feedutils.FeedValidationError("Invalid source options");
  }

  if (hostnameParts[0] === "www") {
    const pathParts = parsedUrl.pathname.split("/");
    if (pathParts.length < 2) {
      throw new feedutils.FeedValidationError("Invalid source options");
    }
    source.options.tumblr = `https://${pathParts[1]}.tumblr.com/rss`;
  } else {
    source.options.tumblr = `https://${parsedUrl.hostname}/rss`;
  }

  /**
   * Get the RSS for the provided `tumblr` url and parse it. If a feed doesn't
   * contains a title we return an error.
   */
  const feed = await feedutils.getAndParseFeed(
    source.options.tumblr,
    source,
    feedData,
  );

  if (!feed.title.value) {
    throw new Error("Invalid feed");
  }

  /**
   * Generate a source id based on the user id, column id and the normalized
   * `tumblr` url. Besides that we also set the source type to `tumblr` and set
   * the title and link for the source.
   */
  if (source.id === "") {
    source.id = await generateSourceId(
      source.userId,
      source.columnId,
      source.options.tumblr,
    );
  }
  source.type = "tumblr";
  source.title = feed.title.value;
  if (feed.links.length > 0) {
    source.link = feed.links[0];
  }
  source.icon = undefined;

  /**
   * Now that the source does contain all the required information we can start
   * to generate the items for the source, by looping over all the feed entries.
   */
  const items: IItem[] = [];

  for (const [index, entry] of feed.entries.entries()) {
    if (skipEntry(index, entry, source.updatedAt || 0)) {
      continue;
    }

    /**
     * Create the item object and add it to the `items` array.
     */
    items.push({
      id: await generateItemId(source.id, entry.id),
      userId: source.userId,
      columnId: source.columnId,
      sourceId: source.id,
      title: entry.title!.value!,
      link: entry.links[0].href!,
      media: getMedia(entry),
      description: entry.description?.value
        ? unescape(entry.description?.value)
        : undefined,
      author: undefined,
      publishedAt: Math.floor(entry.published!.getTime() / 1000),
    });
  }

  return { source, items };
};

/**
 * `skipEntry` is used to determin if an entry should be skipped or not. When a
 * entry in the RSS feed is skipped it will not be added to the database. An
 * entry will be skipped when
 * - it is not within the first 50 entries of the feed, because we only keep the
 *   last 50 items of each source in our delete logic.
 * - the entry does not contain a title, a link or a published date.
 * - the published date of the entry is older than the last update date of the
 *   source minus 10 seconds.
 */
const skipEntry = (
  index: number,
  entry: FeedEntry,
  sourceUpdatedAt: number,
): boolean => {
  if (index === 50) {
    return true;
  }

  if (
    !entry.title?.value ||
    entry.links.length === 0 ||
    !entry.links[0].href ||
    !entry.published
  ) {
    return true;
  }

  if (Math.floor(entry.published.getTime() / 1000) <= sourceUpdatedAt - 10) {
    return true;
  }

  return false;
};

/**
 * `generateSourceId` generates a unique source id based on the user id, column
 * id and the link of the RSS feed. We use the MD5 algorithm for the link to
 * generate the id.
 */
const generateSourceId = async (
  userId: string,
  columnId: string,
  link: string,
): Promise<string> => {
  return `tumblr-${userId}-${columnId}-${await utils.md5(link)}`;
};

/**
 * `generateItemId` generates a unique item id based on the source id and the
 * identifier of the item. We use the MD5 algorithm for the identifier, which
 * can be the link of the item or the id of the item.
 */
const generateItemId = async (
  sourceId: string,
  identifier: string,
): Promise<string> => {
  return `${sourceId}-${await utils.md5(identifier)}`;
};

/**
 * `getMedia` returns an image for the provided feed entry from it's
 * description. If we could not get an image from the description we return
 * `undefined`.
 */
const getMedia = (entry: FeedEntry): string | undefined => {
  if (entry.description?.value) {
    const matches = /<img[^>]+\bsrc=["']([^"']+)["']/.exec(
      unescape(entry.description.value),
    );
    if (matches && matches.length == 2 && matches[1].startsWith("https://")) {
      return matches[1];
    }
  }

  return undefined;
};
