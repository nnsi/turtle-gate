/**
 * Market news fetcher (§8.5.2).
 *
 * Two-tier architecture:
 *   1. Finnhub — structured English market/sector news
 *   2. Google News RSS — Japanese-language market news
 *
 * Environment variables:
 *   FINNHUB_API_KEY — required for Finnhub (free tier: 60 req/min)
 */

export type NewsItem = {
  source: "finnhub" | "google_news";
  headline: string;
  summary: string;
  publishedAt: string;
  url: string;
  category?: string;
  sourceName?: string;
};

type FinnhubArticle = {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
};

const GOOGLE_NEWS_QUERIES = [
  "日本株 セクター",
  "日銀 金融政策",
  "TOPIX 業種",
  "東証 マーケット",
];

/**
 * Fetch market news from Finnhub.
 * Categories: general, forex, crypto, merger
 */
async function fetchFinnhubNews(
  categories: string[] = ["general", "forex"],
  maxPerCategory = 10,
): Promise<NewsItem[]> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.warn("FINNHUB_API_KEY not set, skipping Finnhub news");
    return [];
  }

  const items: NewsItem[] = [];

  for (const category of categories) {
    try {
      const url = `https://finnhub.io/api/v1/news?category=${category}&token=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`Finnhub API error (${category}): ${res.status}`);
        continue;
      }

      const articles = (await res.json()) as FinnhubArticle[];
      const recent = articles.slice(0, maxPerCategory);

      for (const a of recent) {
        items.push({
          source: "finnhub",
          headline: a.headline,
          summary: a.summary,
          publishedAt: new Date(a.datetime * 1000).toISOString(),
          url: a.url,
          category: a.category,
          sourceName: a.source,
        });
      }
    } catch (err) {
      console.warn(`Finnhub fetch error (${category}):`, err);
    }
  }

  return items;
}

/** Parse RSS XML into news items using regex (no external dependency). */
function parseRSS(xml: string): { title: string; link: string; pubDate: string; description: string }[] {
  const items: { title: string; link: string; pubDate: string; description: string }[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
    const description = block.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() ?? "";

    // Decode basic HTML entities
    const decode = (s: string) =>
      s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    items.push({
      title: decode(title),
      link: decode(link),
      pubDate,
      description: decode(description),
    });
  }

  return items;
}

/**
 * Fetch Japanese market news from Google News RSS.
 */
async function fetchGoogleNewsRSS(
  queries: string[] = GOOGLE_NEWS_QUERIES,
  maxPerQuery = 5,
): Promise<NewsItem[]> {
  const items: NewsItem[] = [];

  for (const query of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`Google News RSS error (${query}): ${res.status}`);
        continue;
      }

      const xml = await res.text();
      const parsed = parseRSS(xml);

      for (const entry of parsed.slice(0, maxPerQuery)) {
        // Skip duplicates by headline
        if (items.some((i) => i.headline === entry.title)) continue;

        items.push({
          source: "google_news",
          headline: entry.title,
          summary: entry.description.replace(/<[^>]*>/g, "").slice(0, 200),
          publishedAt: entry.pubDate ? new Date(entry.pubDate).toISOString() : "",
          url: entry.link,
          category: query,
          sourceName: "Google News",
        });
      }

      // Rate limit: small delay between queries
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.warn(`Google News RSS error (${query}):`, err);
    }
  }

  return items;
}

/**
 * Fetch all market news (Finnhub + Google News RSS).
 * Returns items sorted by recency, deduped.
 */
export async function fetchMarketNews(): Promise<NewsItem[]> {
  const [finnhub, google] = await Promise.all([
    fetchFinnhubNews(),
    fetchGoogleNewsRSS(),
  ]);

  const all = [...finnhub, ...google];

  // Sort by publishedAt descending (most recent first)
  all.sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db - da;
  });

  // Filter to last 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = all.filter((item) => {
    if (!item.publishedAt) return true; // keep items without date
    return new Date(item.publishedAt).getTime() > cutoff;
  });

  return recent;
}

/**
 * Format news items into a text block for LLM prompt injection.
 */
export function formatNewsForPrompt(items: NewsItem[], maxItems = 20): string {
  if (items.length === 0) return "(No recent news available)";

  const selected = items.slice(0, maxItems);
  const lines: string[] = [];

  for (const item of selected) {
    const time = item.publishedAt
      ? new Date(item.publishedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
      : "N/A";
    const src = item.source === "finnhub" ? `[EN:${item.sourceName ?? "Finnhub"}]` : `[JP:${item.sourceName ?? "Google News"}]`;
    lines.push(`${src} ${time}`);
    lines.push(`  ${item.headline}`);
    if (item.summary) lines.push(`  ${item.summary.slice(0, 150)}`);
    lines.push("");
  }

  return lines.join("\n");
}
