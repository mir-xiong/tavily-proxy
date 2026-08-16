/**
 * Thin wrapper around the Tavily REST API.
 */

const TAVILY_BASE = "https://api.tavily.com";

async function tavilyRequest(
  endpoint: string,
  method: "GET" | "POST",
  apiKey: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(`${TAVILY_BASE}${endpoint}`, {
    method,
    headers,
    body: method === "POST" && body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    // Include Retry-After in the message so callers can schedule a cooldown.
    const retryAfter = res.headers.get("retry-after");
    const suffix = retryAfter ? ` (retry-after: ${retryAfter})` : "";
    throw new Error(`Tavily API error ${res.status}${suffix}: ${text}`);
  }

  return res.json();
}

export async function search(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/search", "POST", apiKey, params);
}

export async function extract(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/extract", "POST", apiKey, params);
}

export async function crawl(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/crawl", "POST", apiKey, params);
}

export async function map(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/map", "POST", apiKey, params);
}

/**
 * Query the Tavily /usage endpoint. Returns remaining credits for a key.
 * Throws `Tavily API error <status>: <body>` on non-2xx responses.
 */
export async function usage(apiKey: string): Promise<{ limit: number; remaining: number }> {
  const res = await fetch(`${TAVILY_BASE}/usage`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    key: { usage: number; limit: number | null };
    account: { plan_limit: number; plan_usage: number };
  };

  const limit = data.key.limit ?? data.account.plan_limit ?? 0;
  const usage = data.key.usage;
  return { limit, remaining: Math.max(0, limit - usage) };
}
