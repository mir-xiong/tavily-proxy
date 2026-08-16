/**
 * Embedded single-file admin panel. Served at GET /admin.
 *
 * The browser cannot set a custom x-api-key header on page navigation, so the
 * page itself is public and prompts for the AUTH_KEY. The key is kept in
 * localStorage (survives refresh / browser restart) and attached to every API
 * request via a fetch wrapper. A Logout button clears it.
 */

const CSS = `
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --border: #262b36;
    --text: #d7dce4;
    --muted: #8b94a3;
    --accent: #7c3aed;
    --ok: #34d399;
    --warn: #fbbf24;
    --bad: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--text);
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  input[type=text], input[type=password] {
    flex: 1; min-width: 220px; background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px; padding: 9px 10px; font-size: 14px;
  }
  button {
    background: var(--accent); color: #fff; border: 0; border-radius: 6px;
    padding: 9px 14px; font-size: 14px; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  button.danger { background: transparent; color: var(--bad); border: 1px solid var(--border); }
  button:hover { filter: brightness(1.1); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .msg { font-size: 13px; margin-top: 10px; min-height: 18px; }
  .msg.ok { color: var(--ok); } .msg.err { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 600; padding: 8px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 8px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  .badge.active { background: rgba(52,211,153,.15); color: var(--ok); }
  .badge.exhausted { background: rgba(248,113,113,.15); color: var(--bad); }
  .badge.cooling { background: rgba(251,191,36,.15); color: var(--warn); }
  .muted { color: var(--muted); font-size: 12px; }
  .empty { color: var(--muted); text-align: center; padding: 24px 0; }
  .toolbar { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  td.note { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tavily-proxy · Admin</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div>
      <h1>tavily-proxy Admin</h1>
      <div class="sub">MCP proxy for Tavily with an API key pool</div>
    </div>
    <button id="logoutBtn" class="ghost" style="display:none" onclick="logout()">Logout</button>
  </div>

  <div class="card" id="loginCard">
    <form class="row" onsubmit="login(); return false;">
      <input id="authInput" type="password" placeholder="AUTH_KEY (x-api-key header)" autocomplete="off" />
      <button>Unlock</button>
    </form>
    <div class="msg" id="loginMsg"></div>
  </div>

  <div class="card" id="addCard" style="display:none">
    <form class="row" onsubmit="addKey(); return false;">
      <input id="keyInput" type="text" placeholder="tvly-... new Tavily API key" autocomplete="off" spellcheck="false" />
      <input id="noteInput" type="text" placeholder="Note (optional)" autocomplete="off" spellcheck="false" />
      <button>Add key</button>
    </form>
    <div class="msg" id="addMsg"></div>
  </div>

  <div class="card" id="listCard" style="display:none">
    <table>
      <thead>
        <tr>
          <th>Key</th><th>Status</th><th>Credit</th>
          <th>Note</th><th>Added</th><th>Last used</th><th>Synced</th><th></th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" style="display:none">No keys yet. Add one above.</div>
    <div class="toolbar">
      <button class="ghost" onclick="loadKeys()">Refresh</button>
      <button onclick="syncUsage()">Sync usage now</button>
    </div>
    <div class="msg" id="listMsg"></div>
  </div>
</div>

<script>
const AUTH_KEY = "tavilyProxyAuthKey";

function timeAgo(secs) {
  if (!secs) return "-";
  var diff = Math.floor(Date.now() / 1000) - secs;
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function formatTime(secs) {
  if (!secs) return "-";
  var d = new Date(secs * 1000);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function statusBadge(key) {
  if (key.cooldownUntil > Math.floor(Date.now() / 1000)) {
    return '<span class="badge cooling">cooling</span>';
  }
  return '<span class="badge ' + key.status + '">' + key.status + "</span>";
}

function creditBadge(key) {
  const hasCredit = !(key.status === "exhausted" || key.creditRemaining <= 0);
  return '<span class="badge ' + (hasCredit ? "active" : "exhausted") + '">' + (hasCredit ? "Available" : "No credit") + "</span>";
}

function api(path, options) {
  const headers = Object.assign({}, (options && options.headers) || {}, {
    "x-api-key": localStorage.getItem(AUTH_KEY) || "",
  });
  if (options && options.body) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(path, Object.assign({}, options, { headers }));
}

async function handle(res) {
  if (res.status === 401) {
    document.getElementById("loginCard").style.display = "";
    document.getElementById("addCard").style.display = "none";
    document.getElementById("listCard").style.display = "none";
    document.getElementById("logoutBtn").style.display = "none";
    setMsg("loginMsg", "Unauthorized: wrong AUTH_KEY", true);
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    throw new Error(data.error || ("HTTP " + res.status));
  }
  return data;
}

function setMsg(id, text, isErr) {
  const el = document.getElementById(id);
  el.textContent = text || "";
  el.className = "msg " + (isErr ? "err" : "ok");
}

function login() {
  const value = document.getElementById("authInput").value.trim();
  if (!value) return;
  localStorage.setItem(AUTH_KEY, value);
  document.getElementById("loginCard").style.display = "none";
  document.getElementById("logoutBtn").style.display = "";
  loadKeys();
}

function logout() {
  localStorage.removeItem(AUTH_KEY);
  document.getElementById("loginCard").style.display = "";
  document.getElementById("addCard").style.display = "none";
  document.getElementById("listCard").style.display = "none";
  document.getElementById("logoutBtn").style.display = "none";
  document.getElementById("authInput").value = "";
  setMsg("loginMsg", "", false);
}

function init() {
  if (localStorage.getItem(AUTH_KEY)) {
    document.getElementById("loginCard").style.display = "none";
    document.getElementById("logoutBtn").style.display = "";
    loadKeys();
  }
}
init();

function addKey() {
  const value = document.getElementById("keyInput").value.trim();
  if (!value) { setMsg("addMsg", "Enter a Tavily API key", true); return; }
  const note = document.getElementById("noteInput").value.trim();
  api("/api/keys", { method: "POST", body: JSON.stringify({ apiKey: value, note: note }) })
    .then(handle)
    .then(function () {
      document.getElementById("keyInput").value = "";
      document.getElementById("noteInput").value = "";
      setMsg("addMsg", "Key added");
      return loadKeys();
    })
    .catch(function (e) { setMsg("addMsg", e.message, true); });
}

function deleteKey(apiKey) {
  if (!confirm("Delete key " + apiKey + "?")) return;
  api("/api/keys", { method: "DELETE", body: JSON.stringify({ apiKey: apiKey }) })
    .then(handle)
    .then(function () { return loadKeys(); })
    .catch(function (e) { setMsg("listMsg", e.message, true); });
}

function syncUsage() {
  setMsg("listMsg", "Syncing usage from Tavily…");
  api("/api/keys/sync", { method: "POST", body: "{}" })
    .then(handle)
    .then(function (data) {
      render(data.keys);
      setMsg("listMsg", "Synced " + (data.synced || 0) + " keys");
    })
    .catch(function (e) { setMsg("listMsg", e.message, true); });
}

function render(keys) {
  const rows = document.getElementById("rows");
  const empty = document.getElementById("empty");
  rows.innerHTML = "";
  if (!keys || keys.length === 0) {
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";
  keys.forEach(function (k) {
    const tr = document.createElement("tr");
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Delete";
    btn.onclick = function () { deleteKey(k.apiKey); };
    tr.innerHTML =
      '<td><code>' + k.mask + "</code></td>" +
      "<td>" + statusBadge(k) + "</td>" +
      "<td>" + creditBadge(k) + "</td>" +
      '<td class="note" title="' + escapeHtml(k.note) + '">' + (k.note ? escapeHtml(k.note) : '<span class="muted">\u2013</span>') + "</td>" +
      '<td class="muted">' + formatTime(k.addedAt) + "</td>" +
      '<td class="muted">' + timeAgo(k.lastUsedAt) + "</td>" +
      '<td class="muted">' + timeAgo(k.creditSyncedAt) + "</td>";
    const td = document.createElement("td");
    td.style.textAlign = "right";
    td.appendChild(btn);
    tr.appendChild(td);
    rows.appendChild(tr);
  });
}

function loadKeys() {
  api("/api/keys")
    .then(handle)
    .then(function (data) {
      document.getElementById("addCard").style.display = "";
      document.getElementById("listCard").style.display = "";
      render(data.keys);
      setMsg("listMsg", "");
    })
    .catch(function (e) { setMsg("listMsg", e.message, true); });
}
</script>
</body>
</html>`;

export const ADMIN_HTML = HTML;
