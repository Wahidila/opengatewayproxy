// OpenGateway Proxy - OpenAI-compatible reverse proxy with round-robin key rotation
// Zero external dependencies. Node.js >= 20 (uses built-in fetch).

import http from "node:http";
import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// CONFIG
// ============================================================================

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "0.0.0.0";
const UPSTREAM = "https://opengateway.gitlawb.com";
const CONFIG_FILE = path.join(__dirname, "config.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";  // Optional Bearer for API automation
const DASHBOARD_PASSWORD_ENV = process.env.DASHBOARD_PASSWORD || ""; // Optional override
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = "ogw_session";
const COOLDOWN_MS = 30_000;        // Disable key for 30s after rate limit / auth error
const MAX_LOG_ENTRIES = 200;        // Keep last N requests in memory for dashboard
const HEALTH_CHECK_INTERVAL_MS = 60_000;

// ============================================================================
// STATE
// ============================================================================

/**
 * @typedef {Object} ApiKey
 * @property {string} id            - short uuid
 * @property {string} key           - raw API key
 * @property {string} label         - optional friendly name
 * @property {boolean} enabled      - manually toggled
 * @property {number} requests
 * @property {number} errors
 * @property {number} totalLatencyMs
 * @property {number} lastUsedAt    - epoch ms, 0 if never
 * @property {number} cooldownUntil - epoch ms, 0 if not cooling
 * @property {string|null} lastError
 * @property {number} addedAt
 */

const state = {
  /** @type {ApiKey[]} */
  keys: [],
  rrIndex: 0,
  startedAt: Date.now(),
  totalRequests: 0,
  totalErrors: 0,
  totalLatencyMs: 0,
  /** @type {Array<{ts:number,keyId:string,model:string,status:number,latencyMs:number,promptTokens:number,completionTokens:number,stream:boolean,path:string,error?:string,clientKeyId?:string}>} */
  log: [],
  /** SHA-256 hex of dashboard password. Empty string disables auth. */
  passwordHash: "",
  /** HMAC secret for session cookies. Auto-generated. */
  sessionSecret: "",
  /**
   * Client API keys for authenticating /v1/* requests.
   * Empty array = open relay (backward compat).
   * @type {Array<{id:string,key:string,label:string,enabled:boolean,requests:number,lastUsedAt:number,createdAt:number}>}
   */
  clientKeys: [],
};

// ============================================================================
// PERSISTENCE
// ============================================================================

async function loadConfig() {
  try {
    await access(CONFIG_FILE);
    const raw = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.keys)) {
      state.keys = parsed.keys.map(k => ({
        id: k.id || shortId(),
        key: k.key,
        label: k.label || "",
        enabled: k.enabled !== false,
        requests: k.requests || 0,
        errors: k.errors || 0,
        totalLatencyMs: k.totalLatencyMs || 0,
        lastUsedAt: k.lastUsedAt || 0,
        cooldownUntil: 0,
        lastError: null,
        addedAt: k.addedAt || Date.now(),
      }));
      console.log(`[config] loaded ${state.keys.length} keys from ${CONFIG_FILE}`);
    }
    state.passwordHash = parsed.passwordHash || "";
    state.sessionSecret = parsed.sessionSecret || crypto.randomBytes(32).toString("hex");
    state.clientKeys = Array.isArray(parsed.clientKeys) ? parsed.clientKeys.map(c => ({
      id: c.id || shortId(),
      key: c.key,
      label: c.label || "",
      enabled: c.enabled !== false,
      requests: c.requests || 0,
      lastUsedAt: c.lastUsedAt || 0,
      createdAt: c.createdAt || Date.now(),
    })) : [];
    if (state.clientKeys.length > 0) {
      console.log(`[config] loaded ${state.clientKeys.length} client API key(s) (proxy access locked)`);
    } else {
      console.log(`[config] no client keys — /v1/* is OPEN RELAY`);
    }
  } catch {
    console.log(`[config] no existing config, starting fresh`);
    state.sessionSecret = crypto.randomBytes(32).toString("hex");
  }
  // Allow env-set password to override / set initial
  if (DASHBOARD_PASSWORD_ENV) {
    state.passwordHash = sha256(DASHBOARD_PASSWORD_ENV);
    console.log(`[auth] password set from DASHBOARD_PASSWORD env`);
    saveConfigDebounced();
  }
}

let saveTimer = null;
function saveConfigDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, 500);
}

async function saveConfig() {
  const data = {
    passwordHash: state.passwordHash,
    sessionSecret: state.sessionSecret,
    keys: state.keys.map(k => ({
      id: k.id,
      key: k.key,
      label: k.label,
      enabled: k.enabled,
      requests: k.requests,
      errors: k.errors,
      totalLatencyMs: k.totalLatencyMs,
      lastUsedAt: k.lastUsedAt,
      addedAt: k.addedAt,
    })),
    clientKeys: state.clientKeys.map(c => ({
      id: c.id,
      key: c.key,
      label: c.label,
      enabled: c.enabled,
      requests: c.requests,
      lastUsedAt: c.lastUsedAt,
      createdAt: c.createdAt,
    })),
  };
  try {
    await writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error(`[config] save failed:`, e.message);
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ---------- Session cookie helpers (HMAC-signed, no DB) ----------

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", state.sessionSecret)
    .update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac("sha256", state.sessionSecret)
    .update(data).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  const h = req.headers["cookie"] || "";
  for (const part of h.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  // Bearer token (for API automation) bypasses cookie
  if (ADMIN_TOKEN) {
    const h = req.headers["authorization"] || "";
    if (h === `Bearer ${ADMIN_TOKEN}`) return true;
  }
  // No password set → no auth possible (force setup flow)
  if (!state.passwordHash) return false;
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE_NAME]) !== null;
}

function setSessionCookie(res) {
  const token = signSession({ sub: "admin", exp: Date.now() + SESSION_TTL_MS });
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader("set-cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 16) return key.slice(0, 4) + "***";
  return key.slice(0, 12) + "***" + key.slice(-5);
}

function nowMs() { return Date.now(); }

function sanitizeKey(k) {
  return {
    id: k.id,
    label: k.label,
    masked: maskKey(k.key),
    enabled: k.enabled,
    requests: k.requests,
    errors: k.errors,
    avgLatencyMs: k.requests > 0 ? Math.round(k.totalLatencyMs / k.requests) : 0,
    lastUsedAt: k.lastUsedAt,
    cooldownUntil: k.cooldownUntil,
    cooldownRemainingMs: Math.max(0, k.cooldownUntil - nowMs()),
    lastError: k.lastError,
    addedAt: k.addedAt,
    status: keyStatus(k),
  };
}

function keyStatus(k) {
  if (!k.enabled) return "disabled";
  if (k.cooldownUntil > nowMs()) return "cooldown";
  return "healthy";
}

function pickKey() {
  const n = state.keys.length;
  if (n === 0) return null;
  const now = nowMs();
  for (let i = 0; i < n; i++) {
    const idx = (state.rrIndex + i) % n;
    const k = state.keys[idx];
    if (k.enabled && k.cooldownUntil <= now) {
      state.rrIndex = (idx + 1) % n;
      return k;
    }
  }
  return null;
}

function pushLog(entry) {
  state.log.push(entry);
  if (state.log.length > MAX_LOG_ENTRIES) state.log.shift();
}

// ============================================================================
// PROXY CORE
// ============================================================================

async function proxyRequest(req, res, body) {
  // ---- Client API key authentication ----
  // If clientKeys is non-empty, require Bearer auth from the caller.
  if (state.clientKeys.length > 0) {
    const authHeader = (req.headers["authorization"] || "").trim();
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    const presentedKey = m ? m[1].trim() : "";
    const clientKey = state.clientKeys.find(c => c.enabled && c.key === presentedKey);
    if (!clientKey) {
      respondJson(res, 401, {
        error: {
          message: "Invalid or missing client API key. Pass it as 'Authorization: Bearer <key>'.",
          type: "invalid_client_key",
          code: "unauthorized",
        },
      });
      pushLog({
        ts: nowMs(), keyId: "-", model: extractModel(body), status: 401,
        latencyMs: 0, promptTokens: 0, completionTokens: 0,
        stream: body && /\"stream\"\s*:\s*true/.test(body),
        path: req.url, error: "client auth failed",
      });
      return;
    }
    // Track usage on the matched client key
    clientKey.requests++;
    clientKey.lastUsedAt = nowMs();
    req._clientKeyId = clientKey.id;
    saveConfigDebounced();
  }

  // ---- Normalize request body ----
  // Fix case-sensitive model names (upstream requires lowercase)
  // Strip/fix params that cause "Param Incorrect" on upstream
  if (body) {
    // Debug: save last request body to /tmp for inspection (remove in production)
    import("node:fs").then(fs => {
      try { fs.writeFileSync("/tmp/last-request.json", body); } catch {}
    }).catch(() => {});
    body = normalizeRequestBody(body);
  }

  const upstreamPath = req.url.replace(/^\/v1/, "/v1");
  const isStream = body && /\"stream\"\s*:\s*true/.test(body);

  let attempts = 0;
  const maxAttempts = Math.max(1, state.keys.filter(k => k.enabled).length);
  let lastError = null;
  let lastStatus = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const key = pickKey();
    if (!key) {
      respondJson(res, 503, {
        error: { message: "No healthy API keys available", type: "no_keys", code: "service_unavailable" },
      });
      state.totalErrors++;
      pushLog({
        ts: nowMs(), keyId: "-", model: extractModel(body), status: 503,
        latencyMs: 0, promptTokens: 0, completionTokens: 0,
        stream: isStream, path: req.url, error: "no healthy keys",
      });
      return;
    }

    const startedAt = nowMs();
    try {
      const upstreamRes = await fetch(UPSTREAM + upstreamPath, {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, key.key),
        body: body ?? null,
      });

      // Failover-eligible status codes
      if (
        (upstreamRes.status === 429 || upstreamRes.status === 401 ||
         upstreamRes.status === 403 || upstreamRes.status >= 500)
        && attempts < maxAttempts
      ) {
        const errText = await upstreamRes.text().catch(() => "");
        markKeyFailure(key, upstreamRes.status, errText);
        lastError = errText.slice(0, 200);
        lastStatus = upstreamRes.status;
        continue; // try next key
      }

      // Success path - stream or buffered
      const latencyMs = nowMs() - startedAt;

      // Forward status + headers (excluding hop-by-hop)
      const respHeaders = {};
      upstreamRes.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (["transfer-encoding", "connection", "keep-alive", "content-encoding", "content-length"].includes(lk)) return;
        respHeaders[k] = v;
      });
      res.writeHead(upstreamRes.status, respHeaders);

      let promptTokens = 0;
      let completionTokens = 0;
      let captureBuffer = "";
      const captureUsage = (chunkStr) => {
        // Extract last "usage":{...} occurrence (works for streaming + non-stream)
        const matches = chunkStr.match(/"usage"\s*:\s*\{[^}]*\}/g);
        if (matches) {
          try {
            const last = matches[matches.length - 1];
            const usage = JSON.parse("{" + last + "}").usage;
            if (usage) {
              promptTokens = usage.prompt_tokens || promptTokens;
              completionTokens = usage.completion_tokens || completionTokens;
            }
          } catch {}
        }
      };

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.writableEnded) {
            res.write(value);
          }
          // Sniff usage from chunk for stats only (cheap)
          if (captureBuffer.length < 200_000) {
            captureBuffer += decoder.decode(value, { stream: true });
            if (captureBuffer.length > 50_000) {
              // Keep only tail to find usage
              captureBuffer = captureBuffer.slice(-20_000);
            }
          }
        }
        captureUsage(captureBuffer);
      }
      res.end();

      // Update stats
      const isError = upstreamRes.status >= 400;
      key.requests++;
      key.totalLatencyMs += latencyMs;
      key.lastUsedAt = startedAt;
      if (isError) {
        key.errors++;
        state.totalErrors++;
        if (upstreamRes.status === 429 || upstreamRes.status === 401 || upstreamRes.status === 403) {
          key.cooldownUntil = nowMs() + COOLDOWN_MS;
          key.lastError = `${upstreamRes.status}`;
        }
      } else {
        key.lastError = null;
      }
      state.totalRequests++;
      state.totalLatencyMs += latencyMs;

      pushLog({
        ts: startedAt, keyId: key.id, model: extractModel(body),
        status: upstreamRes.status, latencyMs,
        promptTokens, completionTokens,
        stream: isStream, path: req.url,
        error: isError ? `HTTP ${upstreamRes.status}` : undefined,
        clientKeyId: req._clientKeyId,
      });

      saveConfigDebounced();
      return;

    } catch (err) {
      const latencyMs = nowMs() - startedAt;
      key.requests++;
      key.errors++;
      key.totalLatencyMs += latencyMs;
      key.lastUsedAt = startedAt;
      key.lastError = String(err.message || err).slice(0, 120);
      state.totalErrors++;
      state.totalRequests++;
      lastError = key.lastError;
      lastStatus = 502;
      // try next key
    }
  }

  // All retries exhausted
  if (!res.headersSent) {
    respondJson(res, 502, {
      error: {
        message: `All ${maxAttempts} key(s) failed. Last error: ${lastError || "unknown"}`,
        type: "upstream_exhausted",
        code: lastStatus || "bad_gateway",
      },
    });
  }
  pushLog({
    ts: nowMs(), keyId: "-", model: extractModel(body), status: 502,
    latencyMs: 0, promptTokens: 0, completionTokens: 0,
    stream: isStream, path: req.url, error: lastError || "all keys failed",
  });
}

function buildUpstreamHeaders(reqHeaders, apiKey) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase();
    if (["host", "authorization", "content-length", "connection", "accept-encoding"].includes(lk)) continue;
    out[k] = v;
  }
  out["authorization"] = `Bearer ${apiKey}`;
  out["accept-encoding"] = "identity"; // Prevent gzip so we can sniff usage
  return out;
}

function markKeyFailure(key, status, errText) {
  key.errors++;
  key.lastError = `${status}: ${errText.slice(0, 80)}`;
  if (status === 429 || status === 401 || status === 403) {
    key.cooldownUntil = nowMs() + COOLDOWN_MS;
  }
  state.totalErrors++;
}

function extractModel(body) {
  if (!body) return "";
  const m = body.match(/"model"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "";
}

// ============================================================================
// REQUEST NORMALIZATION (fix upstream "Param Incorrect" errors)
// ============================================================================

/** Model name aliases → canonical lowercase names upstream accepts */
const MODEL_ALIASES = {
  "mimo-v2.5-pro": "mimo-v2.5-pro",
  "mimo-v2.5": "mimo-v2.5",
  "mimo-v2-pro": "mimo-v2-pro",
  "mimo-v2-flash": "mimo-v2-flash",
  "mimo-v2-omni": "mimo-v2-omni",
  // Common case variants people/IDEs might use
  "mimo-v2.5-pro": "mimo-v2.5-pro",
  "mimov2.5pro": "mimo-v2.5-pro",
  "mimo": "mimo-v2.5-pro",
};

function normalizeRequestBody(body) {
  try {
    const obj = JSON.parse(body);

    // 1. Normalize model name to lowercase
    if (obj.model && typeof obj.model === "string") {
      const lower = obj.model.toLowerCase();
      obj.model = MODEL_ALIASES[lower] || lower;
    }

    // 2. Fix empty messages array
    if (Array.isArray(obj.messages) && obj.messages.length === 0) {
      obj.messages = [{ role: "user", content: "" }];
    }

    // 3. Transform messages for MiMo compatibility
    // MiMo does NOT support: role="tool", assistant.tool_calls, role="function"
    // Strategy: convert tool-call flows into plain text equivalents
    if (Array.isArray(obj.messages)) {
      const normalized = [];
      for (let i = 0; i < obj.messages.length; i++) {
        const msg = obj.messages[i];
        if (!msg) continue;

        // Fix role aliases
        if (msg.role === "human") msg.role = "user";
        if (msg.role === "ai") msg.role = "assistant";

        // Handle assistant messages with tool_calls
        if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
          // Keep content if exists, otherwise describe what assistant did
          const existingContent = msg.content || "";
          normalized.push({ role: "assistant", content: existingContent || "I will use a tool to help with this." });
          continue;
        }

        // Handle assistant messages with function_call (legacy)
        if (msg.role === "assistant" && msg.function_call) {
          const existingContent = msg.content || "";
          normalized.push({ role: "assistant", content: existingContent || "I will use a function to help." });
          continue;
        }

        // Handle role="tool" → convert to role="user" with natural format
        if (msg.role === "tool") {
          const toolName = msg.name || msg.tool_call_id || "tool";
          const content = `[Tool executed: ${toolName}]\nOutput:\n${msg.content || "(no output)"}`;
          // Merge consecutive tool results into one user message
          const prev = normalized[normalized.length - 1];
          if (prev && prev.role === "user" && prev._isTool) {
            prev.content += "\n\n" + content;
          } else {
            normalized.push({ role: "user", content, _isTool: true });
          }
          continue;
        }

        // Handle role="function" (legacy) → convert to role="user"
        if (msg.role === "function") {
          const content = `[Tool executed: ${msg.name || "function"}]\nOutput:\n${msg.content || "(no output)"}`;
          normalized.push({ role: "user", content, _isTool: true });
          continue;
        }

        // Ensure content field exists
        if (!("content" in msg) || msg.content === null) {
          msg.content = "";
        }

        // Normal message — pass through
        normalized.push({ role: msg.role, content: msg.content });
      }

      // Clean up internal markers and fix consecutive same-role messages
      // MiMo may also reject consecutive user/user or assistant/assistant
      const final = [];
      for (const msg of normalized) {
        delete msg._isTool;
        const prev = final[final.length - 1];
        if (prev && prev.role === msg.role) {
          // Merge consecutive same-role messages
          prev.content += "\n\n" + msg.content;
        } else {
          final.push(msg);
        }
      }
      obj.messages = final;
    }

    // 4. Clamp temperature to valid range [0, 2]
    if (typeof obj.temperature === "number") {
      obj.temperature = Math.max(0, Math.min(2, obj.temperature));
    }

    // 5. Fix max_tokens: must be > 0, cap at reasonable limit
    if ("max_tokens" in obj) {
      if (typeof obj.max_tokens !== "number" || obj.max_tokens <= 0) {
        delete obj.max_tokens;
      } else if (obj.max_tokens > 128000) {
        obj.max_tokens = 128000;
      }
    }
    if ("max_completion_tokens" in obj && !("max_tokens" in obj)) {
      obj.max_tokens = obj.max_completion_tokens;
      delete obj.max_completion_tokens;
      if (typeof obj.max_tokens !== "number" || obj.max_tokens <= 0) {
        delete obj.max_tokens;
      }
    }

    // 6. Remove params that upstream doesn't understand
    const STRIP_PARAMS = [
      "logit_bias", "top_logprobs",
      "service_tier", "store", "metadata",
    ];
    for (const p of STRIP_PARAMS) {
      delete obj[p];
    }

    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

function respondJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : null;
}

function checkAdminAuth(req) {
  return isAuthenticated(req);
}

// ============================================================================
// AUTH ENDPOINTS
// ============================================================================

async function handleAuth(req, res, urlPath, body) {
  // GET /admin/auth/status - public, no body
  if (req.method === "GET" && urlPath === "/admin/auth/status") {
    return respondJson(res, 200, {
      passwordSet: !!state.passwordHash,
      authenticated: isAuthenticated(req),
    });
  }

  // POST /admin/auth/setup - set initial password (only if no password yet)
  if (req.method === "POST" && urlPath === "/admin/auth/setup") {
    if (state.passwordHash) {
      return respondJson(res, 409, { error: "Password already set. Use /admin/auth/change instead." });
    }
    let parsed;
    try { parsed = JSON.parse(body || "{}"); } catch { return respondJson(res, 400, { error: "Invalid JSON" }); }
    const pw = (parsed.password || "").toString();
    if (pw.length < 6) return respondJson(res, 400, { error: "Password must be at least 6 characters." });
    state.passwordHash = sha256(pw);
    saveConfigDebounced();
    setSessionCookie(res);
    return respondJson(res, 201, { ok: true });
  }

  // POST /admin/auth/login
  if (req.method === "POST" && urlPath === "/admin/auth/login") {
    if (!state.passwordHash) {
      return respondJson(res, 400, { error: "No password set. POST /admin/auth/setup first." });
    }
    let parsed;
    try { parsed = JSON.parse(body || "{}"); } catch { return respondJson(res, 400, { error: "Invalid JSON" }); }
    const pw = (parsed.password || "").toString();
    const incoming = sha256(pw);
    const stored = state.passwordHash;
    if (incoming.length !== stored.length ||
        !crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(stored))) {
      // Tiny delay to slow brute force
      await new Promise(r => setTimeout(r, 250));
      return respondJson(res, 401, { error: "Wrong password." });
    }
    setSessionCookie(res);
    return respondJson(res, 200, { ok: true });
  }

  // POST /admin/auth/logout
  if (req.method === "POST" && urlPath === "/admin/auth/logout") {
    clearSessionCookie(res);
    return respondJson(res, 200, { ok: true });
  }

  // POST /admin/auth/change - change password (must be authenticated)
  if (req.method === "POST" && urlPath === "/admin/auth/change") {
    if (!isAuthenticated(req)) return respondJson(res, 401, { error: "Login first." });
    let parsed;
    try { parsed = JSON.parse(body || "{}"); } catch { return respondJson(res, 400, { error: "Invalid JSON" }); }
    const pw = (parsed.password || "").toString();
    if (pw.length < 6) return respondJson(res, 400, { error: "Password must be at least 6 characters." });
    state.passwordHash = sha256(pw);
    saveConfigDebounced();
    return respondJson(res, 200, { ok: true });
  }

  return respondJson(res, 404, { error: "Not found" });
}

// ============================================================================
// ADMIN API
// ============================================================================

async function handleAdmin(req, res, urlPath, body) {
  // /admin/auth/* endpoints are public (login/setup/status)
  if (urlPath.startsWith("/admin/auth/")) {
    return handleAuth(req, res, urlPath, body);
  }
  if (!checkAdminAuth(req)) {
    return respondJson(res, 401, { error: "Unauthorized. Login at /login." });
  }

  // GET /admin/stats
  if (req.method === "GET" && urlPath === "/admin/stats") {
    const enabled = state.keys.filter(k => k.enabled);
    const healthy = enabled.filter(k => k.cooldownUntil <= nowMs()).length;
    return respondJson(res, 200, {
      uptime: Math.floor((nowMs() - state.startedAt) / 1000),
      totalRequests: state.totalRequests,
      totalErrors: state.totalErrors,
      avgLatencyMs: state.totalRequests > 0 ? Math.round(state.totalLatencyMs / state.totalRequests) : 0,
      keys: state.keys.map(sanitizeKey),
      keyCount: state.keys.length,
      healthyKeyCount: healthy,
      clientKeys: state.clientKeys.map(c => ({
        id: c.id,
        label: c.label,
        masked: maskKey(c.key),
        enabled: c.enabled,
        requests: c.requests,
        lastUsedAt: c.lastUsedAt,
        createdAt: c.createdAt,
      })),
      proxyLocked: state.clientKeys.length > 0,
    });
  }

  // GET /admin/log
  if (req.method === "GET" && urlPath === "/admin/log") {
    return respondJson(res, 200, { entries: state.log.slice().reverse() });
  }

  // POST /admin/keys
  if (req.method === "POST" && urlPath === "/admin/keys") {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return respondJson(res, 400, { error: "Invalid JSON" }); }
    const k = (parsed.key || "").trim();
    const label = (parsed.label || "").trim();
    if (!k) return respondJson(res, 400, { error: "Missing 'key' field" });
    if (state.keys.some(x => x.key === k)) {
      return respondJson(res, 409, { error: "Key already exists" });
    }
    /** @type {ApiKey} */
    const newKey = {
      id: shortId(), key: k, label, enabled: true,
      requests: 0, errors: 0, totalLatencyMs: 0,
      lastUsedAt: 0, cooldownUntil: 0, lastError: null,
      addedAt: nowMs(),
    };
    state.keys.push(newKey);
    saveConfigDebounced();
    return respondJson(res, 201, { ok: true, key: sanitizeKey(newKey) });
  }

  // POST /admin/keys/:id/test
  const testMatch = urlPath.match(/^\/admin\/keys\/([a-f0-9]+)\/test$/);
  if (req.method === "POST" && testMatch) {
    const k = state.keys.find(x => x.id === testMatch[1]);
    if (!k) return respondJson(res, 404, { error: "Key not found" });
    try {
      const start = nowMs();
      const r = await fetch(UPSTREAM + "/v1/xiaomi-mimo/models", {
        headers: {
          "authorization": `Bearer ${k.key}`,
          "accept-encoding": "identity",
        },
      });
      const latency = nowMs() - start;
      const ok = r.ok;
      let modelCount = 0;
      try {
        const data = await r.json();
        modelCount = (data.data || []).length;
      } catch {}
      return respondJson(res, 200, { ok, status: r.status, latencyMs: latency, modelCount });
    } catch (e) {
      return respondJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  // PATCH /admin/keys/:id
  const patchMatch = urlPath.match(/^\/admin\/keys\/([a-f0-9]+)$/);
  if (req.method === "PATCH" && patchMatch) {
    const k = state.keys.find(x => x.id === patchMatch[1]);
    if (!k) return respondJson(res, 404, { error: "Key not found" });
    let parsed;
    try { parsed = JSON.parse(body); } catch { return respondJson(res, 400, { error: "Invalid JSON" }); }
    if (typeof parsed.enabled === "boolean") k.enabled = parsed.enabled;
    if (typeof parsed.label === "string") k.label = parsed.label;
    if (parsed.resetStats) {
      k.requests = 0; k.errors = 0; k.totalLatencyMs = 0; k.lastError = null;
    }
    if (parsed.clearCooldown) k.cooldownUntil = 0;
    saveConfigDebounced();
    return respondJson(res, 200, { ok: true, key: sanitizeKey(k) });
  }

  // DELETE /admin/keys/:id
  if (req.method === "DELETE" && patchMatch) {
    const idx = state.keys.findIndex(x => x.id === patchMatch[1]);
    if (idx === -1) return respondJson(res, 404, { error: "Key not found" });
    state.keys.splice(idx, 1);
    saveConfigDebounced();
    return respondJson(res, 200, { ok: true });
  }

  // ----- Client API keys (for /v1/* access control) -----

  // GET /admin/client-keys
  if (req.method === "GET" && urlPath === "/admin/client-keys") {
    return respondJson(res, 200, {
      proxyLocked: state.clientKeys.length > 0,
      keys: state.clientKeys.map(c => ({
        id: c.id, label: c.label, masked: maskKey(c.key),
        enabled: c.enabled, requests: c.requests,
        lastUsedAt: c.lastUsedAt, createdAt: c.createdAt,
      })),
    });
  }

  // POST /admin/client-keys - generate a new client key
  if (req.method === "POST" && urlPath === "/admin/client-keys") {
    let parsed;
    try { parsed = JSON.parse(body || "{}"); } catch { return respondJson(res, 400, { error: "Invalid JSON" }); }
    const label = (parsed.label || "").trim();
    // Generate a strong random key, prefixed for clarity (sk-ogw-<48 hex chars>)
    const newKey = "sk-ogw-" + crypto.randomBytes(24).toString("hex");
    const entry = {
      id: shortId(), key: newKey, label, enabled: true,
      requests: 0, lastUsedAt: 0, createdAt: nowMs(),
    };
    state.clientKeys.push(entry);
    saveConfigDebounced();
    // Return FULL key once so dashboard can display it. After this it is masked.
    return respondJson(res, 201, {
      ok: true,
      key: {
        id: entry.id, label: entry.label, fullKey: newKey,
        masked: maskKey(newKey), enabled: true,
        requests: 0, lastUsedAt: 0, createdAt: entry.createdAt,
      },
    });
  }

  // PATCH /admin/client-keys/:id - enable/disable/relabel
  const ckPatch = urlPath.match(/^\/admin\/client-keys\/([a-f0-9]+)$/);
  if (req.method === "PATCH" && ckPatch) {
    const c = state.clientKeys.find(x => x.id === ckPatch[1]);
    if (!c) return respondJson(res, 404, { error: "Client key not found" });
    let parsed;
    try { parsed = JSON.parse(body || "{}"); } catch { return respondJson(res, 400, { error: "Invalid JSON" }); }
    if (typeof parsed.enabled === "boolean") c.enabled = parsed.enabled;
    if (typeof parsed.label === "string") c.label = parsed.label;
    saveConfigDebounced();
    return respondJson(res, 200, { ok: true });
  }

  // DELETE /admin/client-keys/:id
  if (req.method === "DELETE" && ckPatch) {
    const idx = state.clientKeys.findIndex(x => x.id === ckPatch[1]);
    if (idx === -1) return respondJson(res, 404, { error: "Client key not found" });
    state.clientKeys.splice(idx, 1);
    saveConfigDebounced();
    return respondJson(res, 200, { ok: true });
  }

  // GET /admin/models -> only the models actually usable with this gateway/key
  if (req.method === "GET" && urlPath === "/admin/models") {
    // Hardcoded list of verified-usable models (audited 2026-05-19)
    // GMI Cloud models all return 400 "unsupported" or 402 "insufficient balance"
    // MiMo TTS models need a different endpoint
    const USABLE = [
      { id: "mimo-v2-flash",  context: 1050000, capabilities: ["chat", "stream", "tool", "thinking"], note: "Fastest (~800ms). Light chat, autocomplete." },
      { id: "mimo-v2-pro",    context: 1050000, capabilities: ["chat", "stream", "tool", "thinking"], note: "Gen-2 pro. Balanced (~1.3s)." },
      { id: "mimo-v2-omni",   context: 1050000, capabilities: ["chat", "stream", "tool", "thinking", "vision"], note: "Vision support. Image input via OpenAI format." },
      { id: "mimo-v2.5",      context: 1050000, capabilities: ["chat", "stream", "tool", "thinking"], note: "Standard 2.5 (~2.7s)." },
      { id: "mimo-v2.5-pro",  context: 1050000, capabilities: ["chat", "stream", "tool", "thinking"], note: "Top-tier reasoning. Production default (~2.0s)." },
    ];
    return respondJson(res, 200, { models: USABLE });
  }

  return respondJson(res, 404, { error: "Not found" });
}

// ============================================================================
// STATIC DASHBOARD
// ============================================================================

async function serveStatic(req, res, urlPath) {
  let file = urlPath === "/" || urlPath === "/dashboard" ? "/index.html" : urlPath;
  const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(__dirname, "public", safe);
  try {
    const data = await readFile(full);
    const ext = path.extname(full).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

// ============================================================================
// REQUEST DISPATCHER
// ============================================================================

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  // CORS for dashboard / API consumers
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204); return res.end();
  }

  try {
    // 1. Login page (always public)
    if (p === "/login" || p === "/login.html") {
      return serveStatic(req, res, "/login.html");
    }

    // 2. Dashboard / static — require auth (except login assets)
    if (p === "/" || p === "/dashboard" || p === "/index.html" || p === "/app.js" || p === "/style.css" || p === "/login.js") {
      // If user is not authenticated (whether due to no password set or no cookie), redirect to login
      if (!isAuthenticated(req) && (p === "/" || p === "/dashboard" || p === "/index.html")) {
        res.writeHead(302, { location: "/login" });
        return res.end();
      }
      const sp = (p === "/" || p === "/dashboard") ? "/index.html" : p;
      return serveStatic(req, res, sp);
    }
    if (p.startsWith("/static/")) {
      return serveStatic(req, res, p.replace("/static", ""));
    }

    // 2. Admin API
    if (p.startsWith("/admin/")) {
      const body = ["POST", "PATCH"].includes(req.method) ? await readBody(req) : null;
      return handleAdmin(req, res, p, body);
    }

    // 3. OpenAI-compatible proxy: /v1/*
    if (p.startsWith("/v1/")) {
      const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : null;
      return proxyRequest(req, res, body);
    }

    // 4. Health
    if (p === "/health" || p === "/healthz") {
      return respondJson(res, 200, { ok: true, keys: state.keys.length, uptime: Math.floor((nowMs() - state.startedAt) / 1000) });
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) {
      respondJson(res, 500, { error: { message: String(err.message || err), type: "internal_error" } });
    } else {
      res.end();
    }
  }
});

// ============================================================================
// BACKGROUND TASKS
// ============================================================================

setInterval(() => {
  // Auto-clear cooldown on expiration (already implicit), keep config saved
  saveConfigDebounced();
}, HEALTH_CHECK_INTERVAL_MS);

// ============================================================================
// BOOT
// ============================================================================

await loadConfig();

server.listen(PORT, HOST, () => {
  console.log(`\n  OpenGateway Proxy`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Listening on   http://${HOST}:${PORT}`);
  console.log(`  Dashboard      http://localhost:${PORT}/`);
  console.log(`  OpenAI base    http://localhost:${PORT}/v1`);
  console.log(`  Upstream       ${UPSTREAM}`);
  console.log(`  Keys loaded    ${state.keys.length}`);
  console.log(`  Admin token    ${ADMIN_TOKEN ? "set" : "(none, dashboard public)"}`);
  console.log(`  ─────────────────────────────────────────────\n`);
});

// Graceful shutdown saves config
const shutdown = async (sig) => {
  console.log(`\n[${sig}] saving config and shutting down...`);
  await saveConfig();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
