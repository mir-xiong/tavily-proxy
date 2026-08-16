# Tavily-Proxy

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/Cloudflare%20KV-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare KV" />
  <img src="https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white" alt="Hono" />
  <img src="https://img.shields.io/badge/MCP%20SDK-000000" alt="MCP SDK" />
  <img src="https://img.shields.io/badge/Zod-3E67B1?logo=zod&logoColor=white" alt="Zod" />
</p>

A Cloudflare Worker that acts as an MCP (Model Context Protocol) proxy for the [Tavily API](https://tavily.com). It provides the same tools as the official Tavily MCP server, but with an **API key pool** — automatically rotating through multiple Tavily keys and selecting the one with the most remaining credit.

## Features

- **MCP Server** — Streamable HTTP transport at `POST /mcp`, compatible with any MCP client
- **4 Tavily Tools** — `tavily-search`, `tavily-extract`, `tavily-crawl`, `tavily-map`
- **API Key Pool** — Multiple Tavily API keys stored in Cloudflare KV; each request picks the least-recently-used healthy key
- **Health-aware routing** — Tavily 432 (quota exhausted) keys are skipped until the next UTC month; 429 rate limits apply a transient cooldown; 401/403 keys are invalidated
- **Key Management API + Admin Panel** — HTTP endpoints plus an embedded web panel (`GET /admin`) to add/delete keys and monitor usage
- **Auth Protected** — All endpoints except `GET /` and `GET /admin` require an `x-api-key` header

## Usage

### Connect MCP Clients

With `mcp-remote` (for clients like Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "tavily-proxy": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-worker.workers.dev/mcp",
        "--header", "x-api-key:${AUTH_KEY}"
      ],
      "env": {
        "AUTH_KEY": "your-auth-key"
      }
    }
  }
}
```

### Admin Panel

Open `https://your-worker.workers.dev/admin` in a browser. The panel asks for your `AUTH_KEY` (kept in the browser's `sessionStorage`), then lets you:

- List all keys — masked key, status (`active` / `exhausted` / cooling), credit availability, last-used and last-synced times
- Add and delete keys
- Force a usage sync via the **Sync usage now** button

![Admin panel](https://github.com/user-attachments/assets/1c7b9e03-41e7-4396-84db-40b5d1a35f64)

### Key Management

```bash
# Add a key (auto-queries remaining credit from Tavily)
curl -X POST https://your-worker.workers.dev/api/keys \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-auth-key" \
  -d '{"apiKey": "tvly-xxx"}'

# List all keys and credits
curl https://your-worker.workers.dev/api/keys \
  -H "x-api-key: your-auth-key"

# Force a usage sync for all keys
curl -X POST https://your-worker.workers.dev/api/keys/sync \
  -H "x-api-key: your-auth-key"

# Delete a key
curl -X DELETE https://your-worker.workers.dev/api/keys \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-auth-key" \
  -d '{"apiKey": "tvly-xxx"}'
```

## Setup

### Web

Click the button below to deploy your own instance of tavily-proxy directly to Cloudflare Workers:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Tokisaki-Galaxy/tavily-proxy)

1. **Configure KV Namespace**: The API key pool is stored in Cloudflare KV. You need create a namespace (`Workers & Pages` → `KV` → **Create a namespace**(name don't important).

2. **Configure KV Binding**: After creating the namespace, you need to bind it to your Worker. Go to your Cloudflare Worker dashboard → **Settings** → **Bindings** → **Add binding** and select the KV namespace you created.

![KV Binding](https://github.com/user-attachments/assets/fbb46e01-ce8f-4f53-9712-4aff3915ad69)

3. **Configure Secrets**: Once deployed successfully, go to your Cloudflare Worker dashboard → **Settings** → **Variables**. Add `AUTH_KEY` as an encrypted secret — it is the `x-api-key` header that protects the admin panel and management API.

4. **Redeploy**: Trigger a redeploy for the secret to take effect.

5. **Add Keys**: Visit your Worker URL at `/admin`, log in with your `AUTH_KEY`, and add your Tavily API key(s). The pool is ready — requests are served through `POST /mcp`.

6. (Optional) If you need custom domain, go to your Cloudflare Worker dashboard → **Settings** → **Custom domains** → **Add a custom domain**.

## How the Key Pool Works

The design follows [tavily-hikari](https://github.com/IvanLi-CN/tavily-hikari): the request hot path does **not** estimate or deduct credits locally. Key health is driven by real upstream signals:

1. Each request picks the **least-recently-used healthy key** (LRU).
2. **HTTP 432** (Tavily quota exhausted) → the key is marked `exhausted` and skipped for the rest of the current UTC month; it is restored automatically at the next monthly reset.
3. **HTTP 429** (rate limited) → the key is cooled down for the `Retry-After` window (fallback 60s) and the next key is tried.
4. **HTTP 401/403** → the key is marked `exhausted` and retried against the next key.
5. Remaining credit is only a **display field**, synced from Tavily's `/usage` endpoint in the background:
   - `POST /api/keys` queries usage when adding a key.
   - `GET /api/keys` returns cached values and kicks off a background sync when they are stale (>30 min).
   - `POST /api/keys/sync` forces a full sync.

### Workers Free Plan Note

Cron triggers do **not** fire on the Workers Free plan. The `scheduled` handler is still included, but on Free you should rely on the lazy sync built into `GET /api/keys` and the admin panel's **Sync usage now** button. Uncomment the `[triggers]` block in `wrangler.toml` to enable hourly cron syncs after upgrading to a paid plan.

## Endpoints

| Method   | Path            | Description                                               |
|----------|-----------------|-----------------------------------------------------------|
| `POST`   | `/mcp`          | MCP Streamable HTTP endpoint (tool calls)                 |
| `POST`   | `/api/keys`     | Add a Tavily API key to the pool                          |
| `DELETE` | `/api/keys`     | Remove a Tavily API key from the pool                     |
| `GET`    | `/api/keys`     | List all keys and their status (auto-triggers lazy sync)  |
| `POST`   | `/api/keys/sync`| Force a `/usage` sync for all keys                        |
| `GET`    | `/admin`        | Admin panel (opens without auth; prompts for AUTH_KEY)    |
| `GET`    | `/`             | Health check (no auth required)                           |

All endpoints except `GET /` and `GET /admin` require the `x-api-key` header matching your configured `AUTH_KEY`.
