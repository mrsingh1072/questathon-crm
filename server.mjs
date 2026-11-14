import http from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL(".", import.meta.url));
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
const PORT = Number(process.env.PORT || 3000);
const MCP = "https://questathon.aihackerscollective.com/api/public/mcp";
const MINUTE = 60_000;
// DATA_DIR lets managed hosts mount durable storage without placing a database
// inside the ephemeral build directory. Local development continues to use data/.
const dataDir = process.env.DATA_DIR || join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "crm.sqlite"));
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (kind TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, called_at INTEGER NOT NULL, outcome TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (fingerprint TEXT PRIMARY KEY, payload TEXT NOT NULL, received_at TEXT NOT NULL, noted INTEGER NOT NULL DEFAULT 0);
`);

function json(res, status, body) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); }
function sourceId(x) { return x?.id ?? x?.record_id ?? x?.file_id ?? x?.path ?? x?.source_id ?? null; }
function asArray(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function load(kind) { const row = db.prepare("SELECT payload, fetched_at FROM snapshots WHERE kind=?").get(kind); return row ? { data: JSON.parse(row.payload), fetchedAt: row.fetched_at } : null; }
function save(kind, data) { db.prepare("INSERT INTO snapshots(kind,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at").run(kind, JSON.stringify(data), new Date().toISOString()); }
function lastCall() { return db.prepare("SELECT called_at FROM calls ORDER BY called_at DESC LIMIT 1").get()?.called_at ?? 0; }
function secondsUntilAllowed() { return Math.max(0, Math.ceil((lastCall() + MINUTE - Date.now()) / 1000)); }
async function callTool(name, args = {}) {
  if (!process.env.AQ_TOKEN) throw new Error("AQ_TOKEN is not configured on this server.");
  const wait = secondsUntilAllowed(); if (wait) throw new Error(`Rate gate active: retry in ${wait}s.`);
  try {
    const response = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.AQ_TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }) });
    const result = await response.json();
    if (!response.ok || result.error || result.result?.isError) throw new Error(result.error?.message || result.result?.content?.[0]?.text || `MCP HTTP ${response.status}`);
    const text = result.result?.content?.[0]?.text; const data = typeof text === "string" ? JSON.parse(text) : result.result;
    db.prepare("INSERT INTO calls(tool,called_at,outcome) VALUES(?,?,?)").run(name, Date.now(), "ok"); return data;
  } catch (error) { db.prepare("INSERT INTO calls(tool,called_at,outcome) VALUES(?,?,?)").run(name, Date.now(), `error:${error.message.slice(0,300)}`); throw error; }
}
function accountsFrom(data) { return asArray(data?.accounts ?? data?.data?.accounts ?? data); }
function accountKey(account, index) { return account?.id ?? account?.account_id ?? account?.code ?? account?.name ?? `account-${index + 1}`; }
function accountName(account, index) { return account?.name ?? account?.account_name ?? `Account ${index + 1}`; }
function collect(entity, keys) { return keys.flatMap(k => asArray(entity?.[k])); }
function numberFields(value, path = "", out = []) { if (typeof value === "number") out.push({ path, value }); else if (Array.isArray(value)) value.forEach((v,i) => numberFields(v, `${path}[${i}]`, out)); else if (value && typeof value === "object") Object.entries(value).forEach(([k,v]) => numberFields(v, path ? `${path}.${k}` : k, out)); return out; }
function deriveAccount(account, index, paperwork) {
  const id = accountKey(account, index), name = accountName(account, index), evidence = sourceId(account) || id;
  const deals = collect(account, ["deals", "opportunities", "offers"]);
  const people = collect(account, ["people", "contacts", "stakeholders"]);
  const deadlines = collect(account, ["deadlines", "dates"]);
  const numericEvidence = numberFields(account).map(n => ({ ...n, source: evidence }));
  const power = people.map(p => ({ name: p.name ?? p.full_name ?? "Unnamed person", decision: p.decision_maker ?? p.decision ?? "Unknown", payer: p.payer ?? "Unknown", user: p.user ?? "Unknown", blocker: p.blocker ?? "Unknown", relationship: p.relationship_status ?? p.stance ?? "Unknown", source: sourceId(p) || evidence }));
  const actionCandidates = collect(account, ["next_steps", "actions", "tasks"]).slice(0,3).map((a, n) => ({ rank:n+1, action:a.text ?? a.action ?? a.title ?? "Unknown action", owner:a.owner ?? "Unknown", date:a.date ?? a.due_date ?? "Unknown", impact:a.deal ?? a.deal_id ?? "Unknown", source:sourceId(a)||evidence }));
  const risks = collect(account, ["risks", "warnings", "blockers"]).map(r => ({ text:r.text ?? r.risk ?? r.title ?? "Unknown risk", turnsBad:r.date ?? r.deadline ?? "Unknown", source:sourceId(r)||evidence }));
  const unknowns = collect(account, ["unknowns", "gaps", "open_questions"]).map(u => ({ question:u.question ?? u.text ?? u.title ?? "Unknown", why:u.why ?? u.impact ?? "Why it matters not recorded", ask:u.owner ?? u.ask ?? "Who can answer not recorded", source:sourceId(u)||evidence }));
  return { id, name, raw: account, paperwork: paperwork?.data ?? null, fetchedAt: paperwork?.fetchedAt ?? null, evidence, deals, people: power, deadlines, numericEvidence, actions: actionCandidates, risks, unknowns };
}
function dashboard() { const accountsSnap = load("accounts"); const accounts = accountsFrom(accountsSnap?.data); return { configured: Boolean(process.env.AQ_TOKEN), rateLimitSeconds: secondsUntilAllowed(), lastCall: lastCall() || null, accounts: accounts.map((a,i) => deriveAccount(a,i,load(`paperwork:${accountKey(a,i)}`))), signals: load("signals"), sourceUpdatedAt: accountsSnap?.fetchedAt ?? null }; }
async function work() {
  if (!process.env.AQ_TOKEN || secondsUntilAllowed()) return;
  const accountSnap = load("accounts");
  if (!accountSnap) { save("accounts", await callTool("get_my_accounts")); return; }
  const accounts = accountsFrom(accountSnap.data);
  for (let i=0;i<accounts.length;i++) { const key=accountKey(accounts[i],i); if (!load(`paperwork:${key}`)) { save(`paperwork:${key}`, await callTool("get_all_paperwork", { account: key })); return; } }
  const globalReads = [
    ["data_format", "get_data_format"],
    ["feature_requests", "get_feature_requests"],
    ["release_notes", "get_release_notes"],
    ["flytbase_team", "get_flytbase_team"],
    ["notes", "list_notes"],
  ];
  for (const [kind, tool] of globalReads) {
    if (!load(kind)) { save(kind, await callTool(tool)); return; }
  }
  const pending = db.prepare("SELECT fingerprint,payload FROM events WHERE noted=0 ORDER BY received_at LIMIT 1").get();
  if (pending) {
    const event = JSON.parse(pending.payload);
    const eventId = sourceId(event) || pending.fingerprint;
    await callTool("write_note", { account: event.account ?? event.account_id, kind: "risk", title: "Live signal captured", text: `CRM captured live signal ${eventId}. Review the original signal evidence in the dashboard.` });
    db.prepare("UPDATE events SET noted=1 WHERE fingerprint=?").run(pending.fingerprint);
    return;
  }
  const signals = await callTool("get_signals"); save("signals", signals);
  for (const event of asArray(signals?.signals ?? signals?.events ?? signals)) { const raw=JSON.stringify(event); const fingerprint=sourceId(event) || Buffer.from(raw).toString("base64url").slice(0,80); db.prepare("INSERT OR IGNORE INTO events(fingerprint,payload,received_at) VALUES(?,?,?)").run(fingerprint,raw,new Date().toISOString()); }
}
setInterval(() => { work().catch(() => {}); }, 15_000);
function staticFile(pathname, res) { const file = pathname === "/" ? "index.html" : pathname.slice(1); if (file.includes("..")) return false; const full=join(root,"public",file); if (!existsSync(full)) return false; const type={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"}[extname(full)] || "application/octet-stream"; res.writeHead(200,{"content-type":type});res.end(readFileSync(full));return true; }
const server = http.createServer(async (req,res) => { const u=new URL(req.url,`http://${req.headers.host}`); if (req.method === "GET" && u.pathname === "/api/dashboard") return json(res,200,dashboard()); if (req.method === "POST" && u.pathname === "/api/sync") { try { await work(); return json(res,200,{ok:true,...dashboard()}); } catch(e) { return json(res,429,{ok:false,error:e.message,...dashboard()}); } } if (!staticFile(u.pathname,res)) json(res,404,{error:"Not found"}); });
if (process.argv.includes("--sync-once")) {
  try { await work(); const state = dashboard(); console.log(JSON.stringify({ configured: state.configured, accountsStored: state.accounts.length, rateLimitSeconds: state.rateLimitSeconds, signalsStored: Boolean(state.signals) })); }
  catch (error) { console.error(`Sync failed: ${error.message}`); process.exitCode = 1; }
  finally { db.close(); }
} else server.listen(PORT,()=>console.log(`Questathon CRM listening on http://localhost:${PORT}`));
