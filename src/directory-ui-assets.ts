/** Static assets for the same-origin directory UI. Kept as modules for CSP + tests. */

export const directoryUiCss = `
:root {
  --canvas: #ffffff;
  --rail: #f8f8f8;
  --ink: #0d0d0d;
  --ink-soft: #34322d;
  --muted: #5d5d5d;
  --line: rgba(0, 0, 0, 0.08);
  --veil: rgba(0, 0, 0, 0.04);
  --veil-strong: rgba(0, 0, 0, 0.08);
  --danger: #7f1d1d;
  --radius: 10px;
  --font-ui: "DM Sans", "Avenir Next", "Helvetica Neue", sans-serif;
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 15px;
  line-height: 1.5;
  background:
    radial-gradient(900px 420px at 12% -8%, rgba(0, 0, 0, 0.035), transparent 55%),
    radial-gradient(700px 360px at 92% 0%, rgba(52, 50, 45, 0.04), transparent 50%),
    var(--canvas);
}

button, input { font: inherit; }
button {
  border: 0;
  border-radius: var(--radius);
  background: var(--ink);
  color: #fff;
  padding: 0.75rem 1.05rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 160ms ease, transform 160ms ease, opacity 160ms ease;
}
button:hover { background: #1a1a1a; }
button:active { transform: translateY(1px); }
button.secondary {
  background: transparent;
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--line);
}
button.secondary:hover { background: var(--veil); }
input[type="password"] {
  width: 100%;
  border: 0;
  border-radius: var(--radius);
  background: var(--canvas);
  box-shadow: inset 0 0 0 1px var(--line);
  padding: 0.8rem 0.9rem;
  color: var(--ink);
}
input[type="password"]:focus {
  outline: 2px solid rgba(13, 13, 13, 0.28);
  outline-offset: 1px;
}

.shell { min-height: 100vh; display: grid; }
.shell.unlock {
  place-items: center;
  padding: 2rem 1.25rem 3rem;
}
.brand-panel {
  width: min(440px, 100%);
  padding: 2.75rem 0 1rem;
  animation: rise 420ms ease both;
}
.brand {
  font-size: clamp(2.6rem, 7vw, 3.6rem);
  font-weight: 600;
  letter-spacing: -0.045em;
  line-height: 1.02;
  margin: 0 0 0.85rem;
  color: var(--ink);
}
.lead {
  margin: 0 0 1.75rem;
  color: var(--muted);
  max-width: 36ch;
  font-size: 1.02rem;
}
.field { display: grid; gap: 0.4rem; margin-bottom: 1rem; }
.field label {
  font-size: 0.88rem;
  font-weight: 500;
  color: var(--ink-soft);
}
.actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.hint {
  margin: 1.15rem 0 0;
  color: var(--muted);
  font-size: 0.88rem;
  max-width: 42ch;
}

.app {
  grid-template-columns: 248px 1fr;
  min-height: 100vh;
}
.rail {
  padding: 1.35rem 0.9rem;
  background: var(--rail);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 1.35rem;
  animation: slide 360ms ease both;
}
.rail .mark {
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.03em;
  padding: 0.4rem 0.65rem;
  color: var(--ink);
}
.nav-item {
  display: block;
  padding: 0.6rem 0.7rem;
  border-radius: var(--radius);
  background: var(--veil-strong);
  color: var(--ink);
  font-weight: 600;
  text-decoration: none;
}
.main {
  padding: 2rem clamp(1rem, 3vw, 2.75rem) 3rem;
  max-width: 920px;
  animation: rise 480ms ease both;
}
.main-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
  margin-bottom: 1.35rem;
}
.main-head h1 {
  font-size: clamp(1.65rem, 2.8vw, 2.1rem);
  font-weight: 600;
  letter-spacing: -0.03em;
  margin: 0 0 0.3rem;
}
.meta { color: var(--muted); font-size: 0.9rem; }
.totals {
  margin: 0 0 1.1rem;
  font-weight: 600;
  color: var(--ink-soft);
}
.list { display: grid; gap: 0; }
.connection {
  padding: 1.05rem 0;
  border-top: 1px solid var(--line);
  animation: rise 500ms ease both;
}
.connection:first-child { border-top: 0; padding-top: 0.2rem; }
.connection:nth-child(2) { animation-delay: 40ms; }
.connection:nth-child(3) { animation-delay: 80ms; }
.connection-top {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: baseline;
  margin-bottom: 0.55rem;
}
.provider {
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--ink);
}
.badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.18rem 0.45rem;
  border-radius: 6px;
  background: var(--veil-strong);
  color: var(--ink-soft);
}
.badge.off {
  background: transparent;
  color: var(--muted);
  box-shadow: inset 0 0 0 1px var(--line);
}
.uuid {
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.8rem;
  color: var(--muted);
  word-break: break-all;
}
.contacts { display: grid; gap: 0.45rem; margin-top: 0.75rem; }
.contact {
  padding: 0.7rem 0.75rem;
  border-radius: var(--radius);
  background: var(--rail);
}
.contact strong { font-weight: 600; color: var(--ink); }
.contact dl {
  margin: 0.35rem 0 0;
  display: grid;
  gap: 0.18rem;
  color: var(--muted);
  font-size: 0.88rem;
}
.contact div { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.contact dt { font-weight: 600; color: var(--ink-soft); }
.contact dd { margin: 0; }
.empty, .error, .footnote {
  color: var(--muted);
}
.error {
  color: var(--danger);
  background: rgba(127, 29, 29, 0.05);
  border-radius: var(--radius);
  padding: 0.8rem 0.95rem;
  margin-bottom: 1rem;
}
.footnote { margin-top: 1.5rem; font-size: 0.88rem; }
.hidden { display: none !important; }

@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes slide {
  from { opacity: 0; transform: translateX(-6px); }
  to { opacity: 1; transform: translateX(0); }
}

@media (max-width: 820px) {
  .app { grid-template-columns: 1fr; }
  .rail {
    border-right: 0;
    border-bottom: 1px solid var(--line);
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 0.9rem 1rem;
  }
  .main-head { flex-direction: column; }
  .brand-panel { padding-top: 1.5rem; }
}
`;

export const directoryUiJs = `
const STORAGE_KEY = "anybots.directory.secret";
const unlock = document.getElementById("unlock");
const app = document.getElementById("app");
const form = document.getElementById("unlock-form");
const secretInput = document.getElementById("secret");
const unlockError = document.getElementById("unlock-error");
const listError = document.getElementById("list-error");
const listRoot = document.getElementById("list");
const summary = document.getElementById("summary");
const totals = document.getElementById("totals");
const clearButton = document.getElementById("clear-secret");
const params = new URLSearchParams(location.search);

function sanitize(value) {
  return String(value).replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u202A-\\u202E\\u2066-\\u2069]/g, "");
}

function guidance(code) {
  switch (code) {
    case "unauthorized": return "Check the browsing credential, then ask an operator to reissue it.";
    case "forbidden": return "Ask an operator to confirm your directory access.";
    case "connection_not_found": return "Confirm the connection ID against your list and registration notes.";
    case "inventory_too_large": return "Narrow the connection filter, or ask an operator for help.";
    case "rate_limited": return "Wait a moment, then try again.";
    case "invalid_request": return "Check your input and try again.";
    default: return "Could not load the list. Try again shortly, or contact an operator.";
  }
}

function showUnlock(message) {
  app.classList.add("hidden");
  unlock.classList.remove("hidden");
  unlockError.textContent = message || "";
  unlockError.classList.toggle("hidden", !message);
}

function showApp() {
  unlock.classList.add("hidden");
  app.classList.remove("hidden");
}

function render(body) {
  listError.classList.add("hidden");
  listError.textContent = "";
  const scoped = body.scope.connectionId ? "Selected connection" : "All of your connections";
  summary.textContent = "Fetched " + sanitize(body.checkedAt) + " · " + scoped + " · complete";
  const seen = new Set();
  for (const connection of body.connections) {
    for (const contact of connection.contacts) {
      seen.add([connection.connectionId, contact.connectionId].sort().join(":"));
    }
  }
  totals.textContent = body.connections.length + " connections · " + seen.size + " " + (seen.size === 1 ? "relationship" : "relationships");
  listRoot.replaceChildren();
  if (!body.connections.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No connections are registered.";
    listRoot.append(empty);
    return;
  }
  let contactRows = 0;
  for (const connection of body.connections) {
    contactRows += connection.contacts.length;
    const article = document.createElement("article");
    article.className = "connection";
    const top = document.createElement("div");
    top.className = "connection-top";
    const title = document.createElement("div");
    const provider = document.createElement("div");
    provider.className = "provider";
    provider.textContent = "Your connection · " + sanitize(connection.provider);
    const id = document.createElement("div");
    id.className = "uuid";
    id.textContent = "Connection ID · " + sanitize(connection.connectionId);
    title.append(provider, id);
    const badge = document.createElement("span");
    badge.className = "badge" + (connection.registration === "active" ? "" : " off");
    badge.textContent = connection.registration === "active" ? "Active" : "Disabled";
    top.append(title, badge);
    article.append(top);
    const contacts = document.createElement("div");
    contacts.className = "contacts";
    if (!connection.contacts.length) {
      const none = document.createElement("p");
      none.className = "empty";
      none.textContent = "No permitted contacts.";
      contacts.append(none);
    }
    for (const contact of connection.contacts) {
      const row = document.createElement("div");
      row.className = "contact";
      const head = document.createElement("strong");
      head.textContent = "Contact · " + sanitize(contact.provider) + " / " + sanitize(contact.connectionId);
      const dl = document.createElement("dl");
      const rows = [
        ["Registered owner", contact.sameOwner ? "You" : "Someone else"],
        ["Communication permission", "Recorded (operator)"],
        ["Registration allows communication", contact.registrationAllowsCommunication ? "Yes" : "No"],
      ];
      for (const [label, value] of rows) {
        const wrap = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        wrap.append(dt, dd);
        dl.append(wrap);
      }
      row.append(head, dl);
      contacts.append(row);
    }
    article.append(contacts);
    listRoot.append(article);
  }
  if (contactRows === 0) {
    const note = document.createElement("p");
    note.className = "empty";
    note.textContent = "No permitted contacts.";
    listRoot.append(note);
  }
}

async function load(secret) {
  const url = new URL("/v1/me/connections", location.origin);
  const connectionId = params.get("connection_id");
  if (connectionId) url.searchParams.set("connection_id", connectionId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: "Bearer " + secret,
        accept: "application/json",
      },
    });
    const type = response.headers.get("content-type") || "";
    const raw = await response.text();
    if (!response.ok) {
      let code = "unavailable";
      try { code = JSON.parse(raw).error || code; } catch {}
      throw Object.assign(new Error(code), { code });
    }
    if (!type.includes("application/json")) throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    const body = JSON.parse(raw);
    if (!body || body.schemaVersion !== 1 || body.complete !== true || !Array.isArray(body.connections)) {
      throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    }
    showApp();
    render(body);
  } finally {
    clearTimeout(timer);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const secret = secretInput.value.trim();
  unlockError.classList.add("hidden");
  if (secret.length < 32 || secret.length > 256) {
    showUnlock("Check the browsing credential, then ask an operator to reissue it.");
    return;
  }
  try {
    await load(secret);
    sessionStorage.setItem(STORAGE_KEY, secret);
    secretInput.value = "";
  } catch (error) {
    sessionStorage.removeItem(STORAGE_KEY);
    const code = error && error.code ? error.code : "unavailable";
    showUnlock(guidance(code));
  }
});

clearButton.addEventListener("click", () => {
  sessionStorage.removeItem(STORAGE_KEY);
  listRoot.replaceChildren();
  showUnlock("");
  secretInput.focus();
});

const existing = sessionStorage.getItem(STORAGE_KEY);
if (existing) {
  load(existing).catch((error) => {
    sessionStorage.removeItem(STORAGE_KEY);
    const code = error && error.code ? error.code : "unavailable";
    showUnlock(guidance(code));
  });
} else {
  showUnlock("");
}
`;

export function directoryUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Anybots Connections</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/directory/app.css">
</head>
<body>
  <main id="unlock" class="shell unlock">
    <section class="brand-panel">
      <h1 class="brand">Anybots</h1>
      <p class="lead">Review your registered AI connections and direct contacts. Message bodies stay closed.</p>
      <p id="unlock-error" class="error hidden" role="alert"></p>
      <form id="unlock-form">
        <div class="field">
          <label for="secret">Directory browsing key</label>
          <input id="secret" name="secret" type="password" autocomplete="off" maxlength="256" required>
        </div>
        <div class="actions">
          <button type="submit">Show connections</button>
        </div>
      </form>
      <p class="hint">The key stays in this browser session only and clears when the page closes. Do not paste it into chat.</p>
    </section>
  </main>
  <div id="app" class="shell app hidden">
    <aside class="rail">
      <div class="mark">Anybots</div>
      <a class="nav-item" href="/directory">Connections</a>
      <button id="clear-secret" class="secondary" type="button">Clear browsing key</button>
    </aside>
    <section class="main">
      <header class="main-head">
        <div>
          <h1>Connections</h1>
          <p id="summary" class="meta"></p>
        </div>
      </header>
      <p id="list-error" class="error hidden" role="alert"></p>
      <p id="totals" class="totals"></p>
      <div id="list" class="list"></div>
      <p class="footnote">Per-agent identity, live online status, and external tool authority are unverified.</p>
    </section>
  </div>
  <script src="/directory/app.js" defer></script>
</body>
</html>`;
}
