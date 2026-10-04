/** Static assets for the same-origin directory UI. Kept as modules for CSP + tests. */

export const directoryUiCss = `
:root {
  --canvas-0: #e8f0f4;
  --canvas-1: #f5f8fa;
  --surface: rgba(255, 255, 255, 0.78);
  --rail: rgba(247, 250, 252, 0.92);
  --ink: #102027;
  --muted: #5c6d75;
  --line: rgba(16, 32, 39, 0.1);
  --accent: #0f766e;
  --accent-ink: #042f2e;
  --accent-soft: rgba(15, 118, 110, 0.12);
  --danger: #9f1239;
  --ok: #166534;
  --radius: 12px;
  --shadow: 0 1px 0 var(--line);
  --font-ui: "Outfit", "Avenir Next", "Helvetica Neue", sans-serif;
  --font-display: "Fraunces", "Iowan Old Style", "Palatino Linotype", serif;
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 16px;
  line-height: 1.5;
  background:
    radial-gradient(1200px 600px at 10% -10%, rgba(15, 118, 110, 0.18), transparent 55%),
    radial-gradient(900px 500px at 90% 0%, rgba(30, 64, 80, 0.12), transparent 50%),
    linear-gradient(180deg, var(--canvas-0), var(--canvas-1) 40%, #eef3f6);
}

button, input { font: inherit; }
button {
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  padding: 0.8rem 1.1rem;
  cursor: pointer;
  transition: transform 160ms ease, background 160ms ease;
}
button:hover { background: #0d9488; }
button:active { transform: translateY(1px); }
button.secondary {
  background: transparent;
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--line);
}
button.secondary:hover { background: rgba(16, 32, 39, 0.04); }
input[type="password"] {
  width: 100%;
  border: 0;
  border-radius: 10px;
  background: #fff;
  box-shadow: inset 0 0 0 1px var(--line);
  padding: 0.85rem 0.95rem;
}
input[type="password"]:focus {
  outline: 2px solid rgba(15, 118, 110, 0.35);
  outline-offset: 1px;
}

.shell { min-height: 100vh; display: grid; }
.shell.unlock {
  place-items: center;
  padding: 2rem 1.25rem 3rem;
}
.brand-panel {
  width: min(520px, 100%);
  padding: 2.5rem 2rem 2rem;
  border-radius: 20px;
  background: var(--surface);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
  animation: rise 420ms ease both;
}
.brand {
  font-family: var(--font-display);
  font-size: clamp(2.4rem, 6vw, 3.4rem);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.05;
  margin: 0 0 0.75rem;
}
.lead {
  margin: 0 0 1.5rem;
  color: var(--muted);
  max-width: 34ch;
}
.field { display: grid; gap: 0.45rem; margin-bottom: 1rem; }
.field label { font-size: 0.92rem; font-weight: 500; }
.actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.hint { margin: 1rem 0 0; color: var(--muted); font-size: 0.9rem; }

.app {
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}
.rail {
  padding: 1.5rem 1rem;
  background: var(--rail);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  animation: slide 360ms ease both;
}
.rail .mark {
  font-family: var(--font-display);
  font-size: 1.45rem;
  font-weight: 500;
  letter-spacing: -0.02em;
  padding: 0.35rem 0.6rem;
}
.nav-item {
  display: block;
  padding: 0.65rem 0.75rem;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 600;
  text-decoration: none;
}
.main {
  padding: 2rem clamp(1rem, 3vw, 2.5rem) 3rem;
  animation: rise 480ms ease both;
}
.main-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
  margin-bottom: 1.5rem;
}
.main-head h1 {
  font-family: var(--font-display);
  font-size: clamp(1.8rem, 3vw, 2.4rem);
  font-weight: 500;
  letter-spacing: -0.02em;
  margin: 0 0 0.35rem;
}
.meta { color: var(--muted); font-size: 0.92rem; }
.totals {
  margin: 0 0 1.25rem;
  font-weight: 600;
}
.list { display: grid; gap: 0.85rem; }
.connection {
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
  padding: 1rem 1.1rem;
  animation: rise 500ms ease both;
}
.connection:nth-child(2) { animation-delay: 40ms; }
.connection:nth-child(3) { animation-delay: 80ms; }
.connection-top {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: baseline;
  margin-bottom: 0.65rem;
}
.provider {
  font-weight: 600;
  letter-spacing: -0.01em;
}
.badge {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  background: rgba(22, 101, 52, 0.12);
  color: var(--ok);
}
.badge.off {
  background: rgba(159, 18, 57, 0.1);
  color: var(--danger);
}
.uuid {
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.82rem;
  color: var(--muted);
  word-break: break-all;
}
.contacts { display: grid; gap: 0.55rem; margin-top: 0.85rem; }
.contact {
  padding: 0.7rem 0.8rem;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.7);
  box-shadow: inset 0 0 0 1px var(--line);
}
.contact strong { font-weight: 600; }
.contact dl {
  margin: 0.35rem 0 0;
  display: grid;
  gap: 0.2rem;
  color: var(--muted);
  font-size: 0.9rem;
}
.contact div { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.contact dt { font-weight: 600; color: var(--ink); }
.contact dd { margin: 0; }
.empty, .error, .footnote {
  color: var(--muted);
}
.error {
  color: var(--danger);
  background: rgba(159, 18, 57, 0.06);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
}
.footnote { margin-top: 1.5rem; font-size: 0.9rem; }
.hidden { display: none !important; }

@keyframes rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes slide {
  from { opacity: 0; transform: translateX(-8px); }
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
    padding: 1rem;
  }
  .main-head { flex-direction: column; }
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
    case "unauthorized": return "閲覧資格情報を確認し、運営へ再発行を依頼してください";
    case "forbidden": return "運営へ閲覧権限の確認を依頼してください";
    case "connection_not_found": return "自分の一覧と登録控えから接続IDを確認してください";
    case "inventory_too_large": return "接続を絞るか運営へ相談してください";
    case "rate_limited": return "少し待ってから再実行してください";
    case "invalid_request": return "入力内容を確認してください";
    default: return "一覧を確認できませんでした。しばらくしてから再実行するか運営へ連絡してください";
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
  const scoped = body.scope.connectionId ? "指定した接続の全件" : "自分の全接続";
  summary.textContent = "取得開始: " + sanitize(body.checkedAt) + " · " + scoped + " / 全件取得済み";
  const seen = new Set();
  for (const connection of body.connections) {
    for (const contact of connection.contacts) {
      seen.add([connection.connectionId, contact.connectionId].sort().join(":"));
    }
  }
  totals.textContent = "自分の登録 " + body.connections.length + "件 / 関係 " + seen.size + "組";
  listRoot.replaceChildren();
  if (!body.connections.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "登録された接続はありません";
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
    provider.textContent = "自分の接続: " + sanitize(connection.provider);
    const id = document.createElement("div");
    id.className = "uuid";
    id.textContent = "接続ID: " + sanitize(connection.connectionId);
    title.append(provider, id);
    const badge = document.createElement("span");
    badge.className = "badge" + (connection.registration === "active" ? "" : " off");
    badge.textContent = connection.registration === "active" ? "登録 有効" : "登録 無効";
    top.append(title, badge);
    article.append(top);
    const contacts = document.createElement("div");
    contacts.className = "contacts";
    if (!connection.contacts.length) {
      const none = document.createElement("p");
      none.className = "empty";
      none.textContent = "許可された相手はありません";
      contacts.append(none);
    }
    for (const contact of connection.contacts) {
      const row = document.createElement("div");
      row.className = "contact";
      const head = document.createElement("strong");
      head.textContent = "相手: " + sanitize(contact.provider) + " / " + sanitize(contact.connectionId);
      const dl = document.createElement("dl");
      const rows = [
        ["登録上の持ち主", contact.sameOwner ? "自分" : "他人"],
        ["通信許可", "記録あり（運営設定）"],
        ["登録上の通信条件", contact.registrationAllowsCommunication ? "有効" : "無効"],
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
    note.textContent = "許可された相手はありません";
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
    showUnlock("閲覧資格情報を確認し、運営へ再発行を依頼してください");
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
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Anybots 接続一覧</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/directory/app.css">
</head>
<body>
  <main id="unlock" class="shell unlock">
    <section class="brand-panel">
      <h1 class="brand">Anybots</h1>
      <p class="lead">登録済みのAI接続と、直結している相手だけを確認します。本文は開きません。</p>
      <p id="unlock-error" class="error hidden" role="alert"></p>
      <form id="unlock-form">
        <div class="field">
          <label for="secret">一覧専用の閲覧鍵</label>
          <input id="secret" name="secret" type="password" autocomplete="off" maxlength="256" required>
        </div>
        <div class="actions">
          <button type="submit">一覧を表示</button>
        </div>
      </form>
      <p class="hint">鍵はこのブラウザの一時領域にだけ置き、ページを閉じると消えます。チャットへ貼らないでください。</p>
    </section>
  </main>
  <div id="app" class="shell app hidden">
    <aside class="rail">
      <div class="mark">Anybots</div>
      <a class="nav-item" href="/directory">Connections</a>
      <button id="clear-secret" class="secondary" type="button">この端末の閲覧鍵を消す</button>
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
      <p class="footnote">個別AIの識別・現在のオンライン状態・外部操作権限は未確認です。</p>
    </section>
  </div>
  <script src="/directory/app.js" defer></script>
</body>
</html>`;
}
