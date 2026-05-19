// OpenGateway Proxy Dashboard - vanilla JS, polls /admin/stats every 2s

const REFRESH_MS = 2000;
let lastReqCount = 0;
let lastReqTimestamp = Date.now();
let recentRpm = 0;

const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

function fmtRelative(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function fmtUptime(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return `${h}h ${m}m`;
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
}

// ============================================================================
// STATS REFRESH
// ============================================================================

async function refresh() {
  const r = await api("/admin/stats");
  if (r.status === 401) {
    location.href = "/login";
    return;
  }
  if (!r.ok) {
    $("status-dot").className = "dot dot-error";
    return;
  }
  const s = r.data;
  $("status-dot").className = "dot dot-running";
  $("listen-info").textContent = `:${location.port || 80}`;
  $("t-requests").textContent = s.totalRequests.toLocaleString();
  $("t-errors").textContent = s.totalErrors.toLocaleString();
  $("t-uptime").textContent = fmtUptime(s.uptime);

  $("c-active").textContent = s.healthyKeyCount;
  $("c-total").textContent = s.keyCount;
  const sleeping = s.keys.filter(k => k.status === "cooldown").length;
  const dead = s.keys.filter(k => k.status === "disabled").length;
  $("c-active-sub").textContent =
    s.keyCount === 0 ? "no keys yet" :
    sleeping > 0 ? `${sleeping} cooling down` :
    dead > 0 ? `${dead} disabled` : "all healthy";

  $("c-req").textContent = s.totalRequests.toLocaleString();
  // estimate rpm
  const dt = (Date.now() - lastReqTimestamp) / 1000;
  if (dt >= 1) {
    const delta = s.totalRequests - lastReqCount;
    recentRpm = Math.round((delta / dt) * 60);
    lastReqCount = s.totalRequests;
    lastReqTimestamp = Date.now();
  }
  $("c-req-sub").textContent = `~${recentRpm} req/min`;

  $("c-lat").textContent = s.avgLatencyMs ? `${s.avgLatencyMs}ms` : "—";
  $("c-lat-sub").textContent = `${s.totalRequests} samples`;

  const errRate = s.totalRequests > 0 ? ((s.totalErrors / s.totalRequests) * 100).toFixed(1) : "0.0";
  $("c-err").textContent = `${errRate}%`;
  $("c-err-sub").textContent = `${s.totalErrors} errors / ${s.totalRequests} req`;

  renderKeys(s.keys);
  refreshLog();
}

function renderKeys(keys) {
  const tbody = $("keys-tbody");
  if (!keys.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No keys yet. Click "+ Add Key" to add one.</td></tr>`;
    return;
  }
  const max = Math.max(1, ...keys.map(k => k.requests));
  tbody.innerHTML = keys.map(k => {
    const dotClass =
      k.status === "healthy" ? "dot-running" :
      k.status === "cooldown" ? "dot-warn" :
      "dot-dead";
    const pillClass = `status-${k.status}`;
    const cooldownText = k.status === "cooldown" ? `cooldown ${Math.ceil(k.cooldownRemainingMs/1000)}s` : k.status;
    const barWidth = max > 0 ? (k.requests / max) * 60 : 0;
    return `
      <tr>
        <td><span class="dot ${dotClass}"></span></td>
        <td>
          <div class="key-mono">${escapeHtml(k.masked)}</div>
          ${k.label ? `<div class="label-text">${escapeHtml(k.label)}</div>` : ""}
        </td>
        <td class="num">
          ${k.requests}
          <span class="bar" style="width:${barWidth}px"></span>
        </td>
        <td class="num">${k.errors}</td>
        <td class="num">${k.avgLatencyMs}ms</td>
        <td class="num">${fmtRelative(k.lastUsedAt)}</td>
        <td><span class="status-pill ${pillClass}">${cooldownText}</span></td>
        <td class="actions">
          <button class="btn-icon" title="Test" onclick="testKey('${k.id}')">▶</button>
          <button class="btn-icon" title="${k.enabled ? "Disable" : "Enable"}" onclick="toggleKey('${k.id}', ${!k.enabled})">${k.enabled ? "⏸" : "▶"}</button>
          ${k.cooldownRemainingMs > 0 ? `<button class="btn-icon" title="Clear cooldown" onclick="clearCooldown('${k.id}')">↻</button>` : ""}
          <button class="btn-icon btn-danger" title="Delete" onclick="deleteKey('${k.id}')">×</button>
        </td>
      </tr>
    `;
  }).join("");
}

// ============================================================================
// LOG
// ============================================================================

async function refreshLog() {
  const filter = $("log-filter").value;
  const r = await api("/admin/log");
  if (!r.ok) return;
  let entries = r.data.entries;
  if (filter === "errors") entries = entries.filter(e => e.status >= 400 || e.error);
  if (filter === "stream") entries = entries.filter(e => e.stream);
  $("log-count").textContent = `${entries.length} entries`;
  const tbody = $("log-tbody");
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No requests yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = entries.slice(0, 50).map(e => `
    <tr>
      <td class="ts">${fmtTime(e.ts)}</td>
      <td class="key-id">${escapeHtml(e.keyId.slice(0, 6))}</td>
      <td class="model">${escapeHtml(e.model || "—")}${e.stream ? ' <span class="muted">(s)</span>' : ""}</td>
      <td class="status status-${e.status}">${e.status}</td>
      <td class="lat">${e.latencyMs}ms</td>
      <td class="num">${e.promptTokens || 0}+${e.completionTokens || 0}</td>
    </tr>
  `).join("");
}

// ============================================================================
// MODELS
// ============================================================================

async function loadModels() {
  const list = $("models-list");
  list.innerHTML = `<p class="muted small">Loading…</p>`;
  const r = await api("/admin/models");
  if (!r.ok) {
    list.innerHTML = `<p class="muted small">Error: ${r.data?.error || r.status}</p>`;
    return;
  }
  const models = r.data.models || [];
  if (!models.length) {
    list.innerHTML = `<p class="muted small">No usable models.</p>`;
    return;
  }
  const capLabel = {
    chat: "chat", stream: "stream", tool: "tools",
    thinking: "thinking", vision: "vision",
  };
  const html = models.map(m => {
    const caps = (m.capabilities || []).map(c =>
      `<span class="cap cap-${c}">${capLabel[c] || c}</span>`
    ).join("");
    return `
      <div class="model-item-v2">
        <div class="model-row">
          <span class="model-name">${escapeHtml(m.id)}</span>
          <span class="model-ctx">${(m.context/1000).toFixed(0)}K ctx</span>
        </div>
        <div class="model-caps">${caps}</div>
        ${m.note ? `<div class="model-note">${escapeHtml(m.note)}</div>` : ""}
      </div>
    `;
  }).join("");
  list.innerHTML = `<div class="model-group">Xiaomi MiMo (${models.length} usable)</div>` + html;
}

// ============================================================================
// KEY ACTIONS
// ============================================================================

async function testKey(id) {
  const r = await api(`/admin/keys/${id}/test`, { method: "POST" });
  if (r.data?.ok) {
    alert(`OK - ${r.data.modelCount} models accessible (${r.data.latencyMs}ms)`);
  } else {
    alert(`Failed: ${r.data?.error || `HTTP ${r.data?.status}`}`);
  }
}

async function toggleKey(id, enabled) {
  await api(`/admin/keys/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  refresh();
}

async function clearCooldown(id) {
  await api(`/admin/keys/${id}`, { method: "PATCH", body: JSON.stringify({ clearCooldown: true }) });
  refresh();
}

async function deleteKey(id) {
  if (!confirm("Delete this API key?")) return;
  await api(`/admin/keys/${id}`, { method: "DELETE" });
  refresh();
}

// ============================================================================
// ADD KEY MODAL
// ============================================================================

function openAddModal() {
  $("new-key").value = "";
  $("new-label").value = "";
  $("test-result").className = "test-result";
  $("test-result").textContent = "";
  $("add-modal").hidden = false;
  $("new-key").focus();
}
function closeAddModal() { $("add-modal").hidden = true; }

async function testNewKey() {
  const k = $("new-key").value.trim();
  if (!k) return setTestResult("error", "Enter a key first.");
  setTestResult("", "Testing...");
  // Add temp, test, then remove
  const r = await fetch("/admin/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: k, label: "(testing)" }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    return setTestResult("error", err.error || `HTTP ${r.status}`);
  }
  const { key } = await r.json();
  const t = await api(`/admin/keys/${key.id}/test`, { method: "POST" });
  await api(`/admin/keys/${key.id}`, { method: "DELETE" });
  if (t.data?.ok) {
    setTestResult("success", `OK - ${t.data.modelCount} models, ${t.data.latencyMs}ms latency`);
  } else {
    setTestResult("error", t.data?.error || `HTTP ${t.data?.status}`);
  }
}

async function saveNewKey() {
  const k = $("new-key").value.trim();
  const label = $("new-label").value.trim();
  if (!k) return setTestResult("error", "Enter a key first.");
  const r = await fetch("/admin/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: k, label }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    return setTestResult("error", err.error || `HTTP ${r.status}`);
  }
  closeAddModal();
  refresh();
}

function setTestResult(kind, msg) {
  $("test-result").className = `test-result ${kind || ""}`.trim();
  $("test-result").textContent = msg;
}

// ============================================================================
// HELPERS
// ============================================================================

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ============================================================================
// BOOT
// ============================================================================

$("log-filter").addEventListener("change", refreshLog);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("add-modal").hidden) closeAddModal();
});
$("logout-btn").addEventListener("click", async () => {
  if (!confirm("Sign out of the dashboard?")) return;
  await fetch("/admin/auth/logout", { method: "POST" });
  location.href = "/login";
});

refresh();
loadModels();
setInterval(refresh, REFRESH_MS);
