// Create an API key to give to someone.   Run:  npm run apikey:create
// Asks for the login of the account the key will act as, then prints the key once.
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const rl = readline.createInterface({ input, output });
const ask = async (q, def) => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;

const fail = (msg) => {
  console.error(`\n❌ ${msg}\n`);
  rl.close();
  process.exit(1);
};

const BASE = (await ask("Server URL", "https://task-backend-mn8a.onrender.com")).replace(/\/+$/, "");

console.log("\nChecking the server (Render may take ~1 minute to wake up)...");
let info;
try {
  info = await (await fetch(BASE + "/")).json();
} catch (e) {
  fail(`Cannot reach ${BASE} — ${e.message}`);
}
if (!info?.endpoints?.apiKeys) {
  fail("This server is still running the OLD code (no API key feature).\n   Deploy the new code to Render first, then run this again.");
}
console.log("✅ Server has the API key feature.\n");

console.log("Log in as the account the key should act as (best: a separate account made for this person).");
const email = await ask("Email");
const password = await ask("Password");

const login = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
}).then((r) => r.json());
const token = login?.data?.token;
if (!token) fail(`Login failed: ${login?.message || "unknown error"}`);
console.log(`✅ Logged in as ${login.data.name || email} (${login.data.role || "?"})\n`);

const name = await ask("Who is this key for (name)", "Client");
const access = (await ask('Access: "read" (view only) or "full"', "read")).toLowerCase();
const days = await ask("Expires after how many days (blank = never)", "");

const created = await fetch(BASE + "/api/api-keys", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ name, access, ...(days ? { expiresInDays: Number(days) } : {}) }),
}).then((r) => r.json());
if (!created?.data?.key) fail(`Could not create key: ${created?.message || "unknown error"}`);

const k = created.data;
console.log("\n==================== API KEY (shown only once) ====================\n");
console.log(`  ${k.key}\n`);
console.log("===================================================================");
console.log(`Name: ${k.name}   Access: ${k.access}   Expires: ${k.expiresAt || "never"}   Id: ${k._id}\n`);
console.log("Send this to the person:\n");
console.log(`  Base URL : ${BASE}`);
console.log(`  API key  : ${k.key}`);
console.log(`  Example  : curl ${BASE}/api/tasks -H "X-API-Key: ${k.key}"\n`);
console.log(`To revoke later: DELETE ${BASE}/api/api-keys/${k._id} (with your login token)\n`);
rl.close();
