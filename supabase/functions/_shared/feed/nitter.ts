import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { FeedEntry } from "https://deno.land/x/rss@1.0.0/src/types/mod.ts";
import { Redis } from "https://deno.land/x/redis@v0.32.0/mod.ts";
import { unescape } from "https://raw.githubusercontent.com/lodash/lodash/4.17.21-es/lodash.js";

import { IItem } from "../models/item.ts";
import { ISource } from "../models/source.ts";
import { IProfile } from "../models/profile.ts";
import {
  FEEDDECK_SOURCE_NITTER_BASIC_AUTH,
  FEEDDECK_SOURCE_NITTER_INSTANCE,
} from "../utils/constants.ts";
import { utils } from "../utils/index.ts";
import { feedutils } from "./utils/index.ts";

export const getNitterFeed = async (
  supabaseClient: SupabaseClient,
  _redisClient: Redis | undefined,
  _profile: IProfile,
  source: ISource,
  feedData: string | undefined,
): Promise<{ source: ISource; items: IItem[] }> => {
  if (!source.options?.nitter || source.options.nitter.length === 0) {
    throw new feedutils.FeedValidationError("Invalid source options");
  }

  const nitterOptions = parseNitterOptions(source.options.nitter);

  /**
   * Get the RSS for the provided `nitter` username or search term. If a feed
   * doesn't contains a title we return an error.
   */
  const feed = await feedutils.getAndParseFeed(
    nitterOptions.feedUrl,
    source,
    feedData,
    nitterOptions.isCustomInstance
      ? undefined
      : {
          headers: {
            Authorization: `Basic ${FEEDDECK_SOURCE_NITTER_BASIC_AUTH}`,
          },
        },
  );

  if (!feed.title.value) {
    throw new Error("Invalid feed");
  }

  /**
   * Generate a source id based on the user id, column id and the normalized
   * `nitter` options. Besides that we also set the source type to `nitter` and
   * the link for the source. In opposite to the other sources we do not use the
   * title of the feed as the title for the source, instead we are using the
   * user input as title.
   */
  if (source.id === "") {
    source.id = await generateSourceId(
      source.userId,
      source.columnId,
      source.options.nitter,
    );
  }
  source.type = "nitter";
  source.title = nitterOptions.sourceTitle;
  if (feed.links.length > 0) {
    source.link = feed.links[0];
  }

  /**
   * When the source doesn't has an icon yet and the user requested the feed of
   * a user (string starts with `@`) we try to get an icon for the source.
   */
  if (!source.icon && nitterOptions.isUsername && feed.image?.url) {
    source.icon = feed.image.url;
    source.icon = await feedutils.uploadSourceIcon(supabaseClient, source);
  }

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
     * Each item need a unique id which is generated using the `generateItemId`
     * function. The id is a combination of the source id and the id of the
     * entry or if the entry does not have an id we use the link of the first
     * link of the entry.
     */
    let itemId = "";
    if (entry.id != "") {
      itemId = await generateItemId(source.id, entry.id);
    } else if (entry.links.length > 0 && entry.links[0].href) {
      itemId = await generateItemId(source.id, entry.links[0].href);
    } else {
      continue;
    }

    /**
     * Create the item object and add it to the `items` array. Before the item
     * is created we also try to get a list of media fils (images) and add it to
     * the options. Since there could be multiple media files we add it to the
     * options and not to the media field.
     */
    const media = getMedia(entry);

    items.push({
      id: itemId,
      userId: source.userId,
      columnId: source.columnId,
      sourceId: source.id,
      title: entry.title!.value!,
      link: entry.links[0].href!,
      options: media && media.length > 0 ? { media: media } : undefined,
      description: entry.description?.value
        ? unescape(entry.description.value)
        : undefined,
      author: entry["dc:creator"]?.join(", "),
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
 * `parseNitterOptions` parsed the Nitter options and returns an object with all
 * the required data to get the feed and to create the database entry for the
 * source.
 *
 * This is required, because a user can provide the RSS feed of his own Nitter
 * instance or a username or search term, where we have to use our own Nitter
 * instance.
 */
export const parseNitterOptions = (
  options: string,
): {
  feedUrl: string;
  sourceTitle: string;
  isUsername: boolean;
  isCustomInstance: boolean;
} => {
  if (options.startsWith("http://") || options.startsWith("https://")) {
    if (options.endsWith("/rss")) {
      return {
        feedUrl: options,
        sourceTitle: `@${options.slice(
          options.replace("/rss", "").lastIndexOf("/") + 1,
          options.replace("/rss", "").length,
        )}`,
        isUsername: true,
        isCustomInstance: true,
      };
    }

    const url = new URL(options);
    return {
      feedUrl: options,
      sourceTitle: url.searchParams.get("q") || options,
      isUsername: false,
      isCustomInstance: true,
    };
  }

  if (options[0] === "@") {
    return {
      feedUrl: `${FEEDDECK_SOURCE_NITTER_INSTANCE}/${options.slice(1)}/rss`,
      sourceTitle: options,
      isUsername: true,
      isCustomInstance: false,
    };
  }

  return {
    feedUrl: `${FEEDDECK_SOURCE_NITTER_INSTANCE}/search/rss?f=tweets&q=${encodeURIComponent(
      options,
    )}`,
    sourceTitle: options,
    isUsername: false,
    isCustomInstance: false,
  };
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
  return `nitter-${userId}-${columnId}-${await utils.md5(link)}`;
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
const getMedia = (entry: FeedEntry): string[] | undefined => {
  const images = [];

  if (entry.description?.value) {
    const re = /<img[^>]+\bsrc=["']([^"']+)["']/g;
    let matches;

    do {
      matches = re.exec(unescape(entry.description.value));
      if (matches && matches.length == 2) {
        if (matches[1].startsWith("http://")) {
          images.push(matches[1].replace("http://", "https://"));
        } else if (matches[1].startsWith("https://")) {
          images.push(matches[1]);
        }
      }
    } while (matches);
  }

  return images;
};
