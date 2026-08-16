import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { z } from "zod";
import * as tavilyClient from "./tavily-client.js";
import {
  pickBestKey,
  addKey,
  deleteKey,
  listKeys,
  markExhausted,
  setCooldown,
  syncAllUsage,
  maskKey,
} from "./key-pool.js";
import { ADMIN_HTML } from "./admin-ui.js";

type Env = {
  KV: KVNamespace;
  AUTH_KEY: string;
};

/** Consider a key's credit display stale after this many seconds. */
const SYNC_STALE_SECS = 30 * 60;
/** Fallback cooldown when Retry-After is missing/not parseable. */
const DEFAULT_COOLDOWN_SECS = 60;
/** Cap a single 429 cooldown so a long Retry-After cannot sideline a key forever. */
const MAX_COOLDOWN_SECS = 3600;

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function parseRetryAfter(message: string): number {
  const match = /retry-after:\s*(\d+)/.exec(message);
  if (match) {
    const secs = Number(match[1]);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(MAX_COOLDOWN_SECS, Math.round(secs));
    }
  }
  return DEFAULT_COOLDOWN_SECS;
}

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Auth middleware: require x-api-key header on all routes except the pages a
// browser must be able to open directly (GET / health check, GET /admin panel).
// ---------------------------------------------------------------------------
app.use("*", async (c, next) => {
  const isPublicPage = c.req.method === "GET" && (c.req.path === "/" || c.req.path === "/admin");
  if (isPublicPage) {
    return next();
  }

  const provided = c.req.header("x-api-key");
  if (!provided || provided !== c.env.AUTH_KEY) {
    return c.json({ error: "Unauthorized: invalid or missing x-api-key header" }, 401);
  }

  return next();
});

// ---------------------------------------------------------------------------
// Helper: call a Tavily tool with automatic key fallback.
// Key health is driven by real upstream signals:
//   432 -> quota exhausted, mark exhausted (skipped until next UTC month)
//   429 -> rate limited, cool down per Retry-After, try the next key
//   401/403 -> invalid key, mark exhausted
// ---------------------------------------------------------------------------
async function withKeyFallback(
  kv: KVNamespace,
  toolName: string,
  fn: (apiKey: string) => Promise<unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const triedKeys = new Set<string>();

  while (true) {
    const apiKey = await pickBestKey(kv);
    if (!apiKey || triedKeys.has(apiKey)) {
      return {
        content: [{ type: "text", text: "Error: No available API keys in the pool. Please add keys first." }],
        isError: true,
      };
    }
    triedKeys.add(apiKey);
    console.log(`[MCP] ${toolName} using key: ${maskKey(apiKey)}`);

    try {
      const result = await fn(apiKey);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (/Tavily API error 432/.test(message)) {
        console.error(`[MCP] ${toolName} key ${maskKey(apiKey)} quota exhausted (432), marking exhausted`);
        await markExhausted(kv, apiKey);
        continue;
      }

      if (/Tavily API error 429/.test(message)) {
        const cooldown = parseRetryAfter(message);
        console.error(`[MCP] ${toolName} key ${maskKey(apiKey)} rate limited (429), cooling for ${cooldown}s`);
        await setCooldown(kv, apiKey, nowSecs() + cooldown);
        continue;
      }

      if (/Tavily API error (401|403)/.test(message)) {
        console.error(`[MCP] ${toolName} key ${maskKey(apiKey)} auth error, marking exhausted`);
        await markExhausted(kv, apiKey);
        continue;
      }

      return {
        content: [{ type: "text", text: `Error calling Tavily ${toolName}: ${message}` }],
        isError: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: create a fresh MCP server with Tavily tools bound to a specific KV
// ---------------------------------------------------------------------------
function createMcpServer(kv: KVNamespace) {
  const server = new McpServer({
    name: "tavily-proxy",
    version: "1.0.0",
  });

  // -- tavily-search --------------------------------------------------------
  server.tool(
    "tavily-search",
    "A powerful web search tool that provides comprehensive, real-time results using Tavily's AI search engine. Returns relevant web content with titles, URLs, and content snippets. Supports filtering by topic, time range, domain inclusion/exclusion, and more.",
    {
      query: z.string().describe("The search query to execute with Tavily."),
      search_depth: z
        .enum(["advanced", "basic", "fast", "ultra-fast"])
        .optional()
        .default("basic")
        .describe(
          "Controls the latency vs. relevance tradeoff. 'advanced': highest relevance, increased latency. 'basic': balanced. 'fast': lower latency. 'ultra-fast': minimum latency."
        ),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .default("general")
        .describe("The category of the search. 'news' for real-time updates, 'general' for broader searches, 'finance' for financial data."),
      max_results: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .default(5)
        .describe("The maximum number of search results to return (0-20)."),
      time_range: z
        .enum(["day", "week", "month", "year", "d", "w", "m", "y"])
        .optional()
        .describe("Time range to filter results based on publish/updated date."),
      include_answer: z
        .union([z.boolean(), z.enum(["basic", "advanced"])])
        .optional()
        .default(false)
        .describe("Include an LLM-generated answer. 'basic'/true for quick answer, 'advanced' for detailed."),
      include_raw_content: z
        .union([z.boolean(), z.enum(["markdown", "text"])])
        .optional()
        .default(false)
        .describe("Include cleaned HTML content. 'markdown'/true for markdown, 'text' for plain text."),
      include_images: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also perform an image search and include results."),
      include_image_descriptions: z
        .boolean()
        .optional()
        .default(false)
        .describe("When include_images is true, also add descriptive text for each image."),
      include_domains: z
        .array(z.string())
        .optional()
        .describe("A list of domains to specifically include in results (max 300)."),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe("A list of domains to specifically exclude from results (max 150)."),
      chunks_per_source: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("Max relevant chunks per source (1-3). Only for 'advanced' search_depth."),
      country: z
        .string()
        .optional()
        .describe("Boost results from a specific country. Only for 'general' topic."),
    },
    async (params) =>
      withKeyFallback(kv, "tavily-search", (apiKey) => tavilyClient.search(apiKey, params))
  );

  // -- tavily-extract -------------------------------------------------------
  server.tool(
    "tavily-extract",
    "Extract web page content from one or more specified URLs. Returns cleaned, parsed content optimized for LLMs. Supports basic and advanced extraction depths, optional image extraction, and content format selection.",
    {
      urls: z
        .union([z.string(), z.array(z.string())])
        .describe("A single URL or list of URLs to extract content from."),
      query: z
        .string()
        .optional()
        .describe("User intent for reranking extracted content chunks."),
      extract_depth: z
        .enum(["basic", "advanced"])
        .optional()
        .default("basic")
        .describe("Depth of extraction. 'advanced' retrieves more data including tables."),
      include_images: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include images extracted from the URLs."),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .default("markdown")
        .describe("Format of extracted content. 'markdown' or 'text'."),
      chunks_per_source: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Max relevant chunks per source (1-5). Only when 'query' is provided."),
    },
    async (params) =>
      withKeyFallback(kv, "tavily-extract", (apiKey) => tavilyClient.extract(apiKey, params))
  );

  // -- tavily-crawl ---------------------------------------------------------
  server.tool(
    "tavily-crawl",
    "A graph-based website traversal tool that explores hundreds of paths in parallel with built-in extraction and intelligent discovery. Crawls from a base URL, extracts content, and returns structured results.",
    {
      url: z.string().describe("The root URL to begin the crawl."),
      instructions: z
        .string()
        .optional()
        .describe("Natural language instructions for the crawler."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .default(1)
        .describe("Max depth from the base URL the crawler can explore (1-5)."),
      max_breadth: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(20)
        .describe("Max links to follow per page (1-500)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(50)
        .describe("Total links the crawler will process before stopping."),
      select_paths: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to select only URLs with specific path patterns."),
      select_domains: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to select specific domains or subdomains."),
      exclude_paths: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to exclude URLs with specific path patterns."),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to exclude specific domains or subdomains."),
      allow_external: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to include external domain links in results."),
      include_images: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include images in crawl results."),
      extract_depth: z
        .enum(["basic", "advanced"])
        .optional()
        .default("basic")
        .describe("Extraction depth. 'advanced' retrieves more data but costs more."),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .default("markdown")
        .describe("Format of extracted content."),
      chunks_per_source: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Max relevant chunks per source (1-5). Only when 'instructions' provided."),
    },
    async (params) =>
      withKeyFallback(kv, "tavily-crawl", (apiKey) => tavilyClient.crawl(apiKey, params))
  );

  // -- tavily-map -----------------------------------------------------------
  server.tool(
    "tavily-map",
    "Traverses websites like a graph to generate comprehensive site maps. Explores hundreds of paths in parallel with intelligent discovery. Returns a list of discovered URLs.",
    {
      url: z.string().describe("The root URL to begin the mapping."),
      instructions: z
        .string()
        .optional()
        .describe("Natural language instructions for the mapper."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .default(1)
        .describe("Max depth from the base URL (1-5)."),
      max_breadth: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(20)
        .describe("Max links to follow per page (1-500)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(50)
        .describe("Total links to process before stopping."),
      select_paths: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to select only URLs with specific path patterns."),
      select_domains: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to select specific domains or subdomains."),
      exclude_paths: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to exclude URLs with specific path patterns."),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to exclude specific domains or subdomains."),
      allow_external: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to include external domain links."),
    },
    async (params) =>
      withKeyFallback(kv, "tavily-map", (apiKey) => tavilyClient.map(apiKey, params))
  );

  return server;
}

// ---------------------------------------------------------------------------
// MCP endpoint - /mcp
// Matches the Tavily official MCP endpoint path
// ---------------------------------------------------------------------------
app.post("/mcp", async (c) => {
  const { req, res } = toReqRes(c.req.raw);
  const server = createMcpServer(c.env.KV);

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, await c.req.json());

    res.on("close", () => {
      transport.close();
      server.close();
    });

    return toFetchResponse(res);
  } catch (error) {
    console.error("MCP error:", error);
    return c.json({ error: "Internal MCP server error" }, 500);
  }
});

app.get("/mcp", async (c) => {
  return c.json({ error: "Method not allowed. MCP requires POST." }, 405);
});

app.delete("/mcp", async (c) => {
  return c.json({ error: "Method not allowed." }, 405);
});

// ---------------------------------------------------------------------------
// HTTP API: Key Management
// ---------------------------------------------------------------------------

// Add a key (queries Tavily for remaining credit, inserts/updates KV)
app.post("/api/keys", async (c) => {
  try {
    const body = await c.req.json<{ apiKey: string; note?: string }>();
    if (!body.apiKey) {
      return c.json({ error: "Missing 'apiKey' in request body" }, 400);
    }
    const info = await addKey(c.env.KV, body.apiKey, body.note);
    return c.json({ success: true, key: info });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Delete a key
app.delete("/api/keys", async (c) => {
  try {
    const body = await c.req.json<{ apiKey: string }>();
    if (!body.apiKey) {
      return c.json({ error: "Missing 'apiKey' in request body" }, 400);
    }
    await deleteKey(c.env.KV, body.apiKey);
    return c.json({ success: true, deleted: body.apiKey });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Force a background /usage sync for all keys, then return the updated list.
app.post("/api/keys/sync", async (c) => {
  try {
    const synced = await syncAllUsage(c.env.KV);
    const keys = await listKeys(c.env.KV);
    return c.json({ success: true, synced, keys });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// List all keys with cached credit. If the cached values are stale, kick off a
// background sync via waitUntil so the next refresh is fresh (Free plan has no
// cron triggers, so this lazy path is the primary sync mechanism).
app.get("/api/keys", async (c) => {
  try {
    const keys = await listKeys(c.env.KV);
    const now = nowSecs();
    const stale = keys.some((k) => now - k.creditSyncedAt > SYNC_STALE_SECS);
    if (stale) {
      c.executionCtx.waitUntil(syncAllUsage(c.env.KV));
    }
    return c.json({ keys });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Admin panel (embedded single-file HTML, no build step)
// ---------------------------------------------------------------------------
app.get("/admin", (c) => {
  return c.html(ADMIN_HTML);
});

// ---------------------------------------------------------------------------
// Health check / root
// ---------------------------------------------------------------------------
app.get("/", (c) => {
  return c.json({
    service: "tavily-proxy",
    version: "1.0.0",
    endpoints: {
      mcp: "POST /mcp",
      addKey: "POST /api/keys { apiKey: string }",
      deleteKey: "DELETE /api/keys { apiKey: string }",
      listKeys: "GET /api/keys",
      syncKeys: "POST /api/keys/sync",
      adminPanel: "GET /admin",
    },
  });
});

// ---------------------------------------------------------------------------
// Scheduled handler: background /usage sync.
// NOTE: cron triggers do NOT fire on the Workers Free plan. This runs when you
// upgrade to a paid plan and enable the cron in wrangler.toml. On Free, usage
// is kept fresh by the lazy sync in GET /api/keys and POST /api/keys/sync.
// ---------------------------------------------------------------------------
async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  try {
    const count = await syncAllUsage(env.KV);
    console.log(`[scheduled] usage sync completed for ${count} keys`);
  } catch (err) {
    console.error("[scheduled] usage sync failed:", err);
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
