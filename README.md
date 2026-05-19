# OpenGateway Proxy

OpenAI-compatible reverse proxy untuk `opengateway.gitlawb.com` dengan round-robin key rotation, automatic failover, dashboard real-time, dan zero external dependencies.

## Quick Start

```powershell
cd E:\opengateway-proxy
node server.js
```

- Proxy listens on `http://localhost:8787`
- Dashboard: `http://localhost:8787/`
- OpenAI-compatible base URL: `http://localhost:8787/v1`

### First-time setup

1. Copy template config:
   ```powershell
   Copy-Item config.example.json config.json
   ```
2. Edit `config.json` — replace `ogw_live_PUT_YOUR_KEY_HERE` with your real keys (add as many entries as you want), or leave the example and add keys later via the dashboard.
3. Start the server:
   ```powershell
   node server.js
   ```
4. Open `http://localhost:8787/` — you'll be redirected to `/login` to set a dashboard password (min 6 chars).
5. Sign in. Add more keys via the dashboard if needed.

`config.json` is **gitignored** — your keys, password hash, and session secret stay local.

## Usage (OpenAI SDK Compatible)

### Python
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="anything")  # key ignored
resp = client.chat.completions.create(
    model="mimo-v2.5-pro",
    messages=[{"role": "user", "content": "Halo"}],
)
print(resp.choices[0].message.content)
```

### Node.js
```javascript
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "anything" });
const resp = await client.chat.completions.create({
  model: "mimo-v2.5-pro",
  messages: [{ role: "user", content: "Halo" }],
});
console.log(resp.choices[0].message.content);
```

### curl
```bash
curl http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"mimo-v2.5-pro","messages":[{"role":"user","content":"Halo"}]}'
```

`api_key` di client tidak penting — proxy auto-inject key dari pool.

## Dashboard

Buka `http://localhost:8787/` di browser untuk:

- Real-time stats (active keys, total requests, avg latency, error rate)
- Per-key stats (requests, errors, avg latency, status, last used)
- Add/disable/delete keys
- Test individual key connection
- Recent request log (50 terakhir)
- Browse semua model yang tersedia upstream

Auto-refresh setiap 2 detik.

### Password Protection

Pertama kali buka dashboard, kamu akan diarahkan ke `/login` untuk **set password awal** (minimal 6 karakter). Password disimpan sebagai SHA-256 hash di `config.json`.

**Selanjutnya:**
- Buka dashboard → otomatis redirect ke `/login` kalau belum sign in
- Sign in → cookie session HttpOnly + Strict (7 hari)
- Logout button di top-right corner
- `/v1/*` proxy endpoint **tetap public** — client OpenAI bisa pakai tanpa auth (rotation tetap jalan)
- `/admin/*` API butuh login (atau Bearer `ADMIN_TOKEN` env)

**Set password via env (opsional):**
```powershell
$env:DASHBOARD_PASSWORD = "myStrongPassword"
node server.js
```

Env value akan **override** password yang sudah di-set, jadi pakai untuk reset password kalau lupa.

**Forgot password / reset:**
Edit `config.json`, hapus field `passwordHash`, restart server. Buka dashboard → setup mode lagi.

## Cara Kerja

### Round-robin rotation

Setiap request masuk → proxy pilih key berikutnya dari pool secara berurutan. 5 request masuk → 5 key dipakai 1x masing-masing.

### Failover

Jika upstream return:
- **429** (rate limit) → key masuk cooldown 30 detik, request di-retry dengan key berikutnya
- **401 / 403** (auth error) → cooldown 30 detik
- **5xx** (server error) → langsung retry dengan key berikutnya tanpa cooldown
- **Network error** → retry dengan key berikutnya

Maksimal retry = jumlah key aktif. Kalau semua gagal, return 502.

### Streaming

SSE (`stream:true`) di-pass-through verbatim. Response body langsung di-pipe ke client tanpa buffering, jadi token muncul real-time.

### Persistence

Stats dan key list di-save ke `config.json` setiap 500ms (debounced). Restart server tidak hilang data.

## Available Models (5 verified usable)

Audit: 68 models di-list endpoint, hanya **5 yang accessible** dengan key kamu. Semua MiMo. GMI Cloud (Claude/GPT/Gemini/dll) diblok di tier ini.

| Model | Latency | Capabilities | Best for |
|---|---|---|---|
| `mimo-v2-flash` | ~800ms | chat, stream, tools, thinking | Fastest. Auto-complete, light chat. |
| `mimo-v2-pro` | ~1.3s | chat, stream, tools, thinking | Balanced cost-quality. |
| `mimo-v2-omni` | ~1.5s | chat, stream, tools, thinking, **vision** | Image input. Use OpenAI image_url format. |
| `mimo-v2.5` | ~2.7s | chat, stream, tools, thinking | Standard 2.5. |
| `mimo-v2.5-pro` | ~2.0s | chat, stream, tools, thinking | Production default. Top-tier reasoning. |

All models support context up to 1.05M tokens.

## Endpoints

### OpenAI-compatible (proxied)
| Path | Method | Desc |
|---|---|---|
| `/v1/chat/completions` | POST | Standard chat (mimo + gmi via unified routing) |
| `/v1/xiaomi-mimo/chat/completions` | POST | Explicit MiMo |
| `/v1/gmi-cloud/chat/completions` | POST | Explicit GMI Cloud |
| `/v1/xiaomi-mimo/models` | GET | List MiMo models |
| `/v1/gmi-cloud/models` | GET | List GMI models |

### Admin / Dashboard API
| Path | Method | Desc |
|---|---|---|
| `/admin/auth/status` | GET | Check if password set + authenticated (public) |
| `/admin/auth/setup` | POST | First-time set password (`{password}`) |
| `/admin/auth/login` | POST | Sign in with password (`{password}`) |
| `/admin/auth/logout` | POST | Clear session cookie |
| `/admin/auth/change` | POST | Change password (auth required) |
| `/admin/stats` | GET | Overall stats + per-key breakdown |
| `/admin/log` | GET | Last 200 requests |
| `/admin/models` | GET | All accessible models |
| `/admin/keys` | POST | Add new key (`{key, label}`) |
| `/admin/keys/:id` | PATCH | Update key (`{enabled, label, clearCooldown, resetStats}`) |
| `/admin/keys/:id` | DELETE | Remove key |
| `/admin/keys/:id/test` | POST | Test key against upstream |
| `/health` | GET | Health check |

## Configuration

| Env Var | Default | Desc |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen interface |
| `DASHBOARD_PASSWORD` | `(none)` | Set/override dashboard password. Empty = first-run setup mode. |
| `ADMIN_TOKEN` | `(none)` | Optional `Bearer` token for admin API automation (bypasses cookie). |

## Keuntungan Punya Banyak API Key

### Hasil Investigasi Gateway

Setelah probing langsung ke `opengateway.gitlawb.com`, ditemukan fakta penting:

**Gateway TIDAK validasi API key sama sekali.** Request dengan key `invalid`, `abc123`, atau bahkan kosong tetap dapat 200. Auth check kemungkinan ada di tier billing dan rate-limit, bukan validasi format.

Artinya, manfaat punya 5 key yang aku verify:

| Aspek | Tanpa Proxy (1 key) | Dengan Proxy (5 key rotated) |
|---|---|---|
| **Concurrent requests** | 20-30 stabil (no 429 ditemukan) | **5x = 100-150 stabil** |
| **Request distribution** | Semua di 1 key | Merata 1/5 per key |
| **Hit rate-limit per key** | Lebih cepat (semua trafik 1 akun) | **5x lebih lama** karena beban dibagi |
| **Failover** | Tidak ada — gagal = gagal | **Auto-retry** ke key lain |
| **Quota tracking** | Manual per akun | Per-key di dashboard |
| **Single point of failure** | Iya | Tidak — 1 key dead, 4 lain jalan |

### Estimasi Throughput (Conservative)

Test 50 concurrent paralel ke 1 key → 48/50 sukses tanpa 429, ~3 detik per request rata-rata.

Dengan 5 key di rotation:
- **Theoretical max**: 5 × 50 = 250 concurrent
- **Safe estimate**: 5 × 25 = 125 concurrent stabil
- **Sustained RPM**: ~150-300 request/menit, tergantung response time

Ini cukup untuk:
- Aplikasi multi-user kecil (<200 user aktif simultan)
- Bot/automation pipeline batch processing
- Development tools yang banyak streaming
- LLM agent dengan tool-calling intensif

### Rate Limit Per Key

Gateway TIDAK expose header `x-ratelimit-*` di response. Saat probe:
- 50 concurrent burst → 100% sukses (tidak ada 429)
- Tidak ada throttling per detik yang teramati
- Limit kemungkinan ada di account-tier billing, bukan technical RPM

Asumsi konservatif: **20-30 RPM per key** stabil tanpa risk. Total **100-150 RPM** dengan 5 key di pool.

## File Structure

```
E:\opengateway-proxy\
├── server.js          # Main proxy + admin API (~450 lines)
├── package.json       # No deps, type: module, requires Node >= 20
├── config.json        # Persisted keys + stats
└── public\
    ├── index.html     # Dashboard
    ├── app.js         # Dashboard logic
    └── style.css      # Dark theme
```

## Limitations

- **In-memory log**: 200 entries. Restart loses log (stats persist).
- **No multi-process**: Single Node process. Tidak ada cluster mode.
- **No HTTPS**: Pakai reverse proxy (nginx, Caddy) di depan untuk TLS.
- **No auth on dashboard by default**: Set `ADMIN_TOKEN` env var untuk protect.

## Stop / Restart

```powershell
# Stop
$serverPid = Get-Content E:\opengateway-proxy\server.pid
Stop-Process -Id $serverPid -Force

# Start
node E:\opengateway-proxy\server.js
```

## License

MIT
