// Integration tests — real Express app + throwaway in-memory MongoDB.
// Never touches the database in .env.   Run: npm test
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

process.env.JWT_SECRET = "test-secret-only-for-tests";
// Never talk to the real Google account / mailbox from tests (.env would load them)
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "SMTP_USER", "SMTP_PASS"]) process.env[k] = "";
process.env.NODE_ENV = "test";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongoose = (await import("mongoose")).default;
const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri(); // in case anything reads it

const { server } = await import("../src/app.js");
// Never run the real Whisper model in tests (individual tests install their own fakes)
const { setTranscriber } = await import("../src/services/transcriptionService.js");
setTranscriber(async () => ({ seconds: 1, segments: [{ text: "test", start: 0 }] }));
const User = (await import("../src/models/User.js")).default;
const Task = (await import("../src/models/Task.js")).default;
const { UPLOAD_DIR } = await import("../src/controllers/taskController.js");
const { sentMessages } = await import("../src/services/accountEmailService.js");
const Meeting = () => mongoose.model("Meeting");

let base;
const createdFiles = [];

const call = async (method, url, { token, json, form } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const res = await fetch(base + url, { method, headers, body });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
};

const login = async (email, password) => {
  const r = await call("POST", "/api/auth/login", { json: { email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.data.token;
};

// Latest one-time verification token emailed to this address
const tokenFor = (email) => {
  const msg = [...sentMessages].reverse().find((m) => m.to === email.toLowerCase() && /verify-email\//.test(m.text));
  return msg?.text.match(/verify-email\/([a-f0-9]{64})/)?.[1];
};

// What a new user does: open the email link (password shown once), then log in
const activate = async (email, password) => {
  const r = await call("POST", "/api/auth/verify-email", { json: { token: tokenFor(email) } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.data.password, password, "revealed password matches the admin-set one");
  return login(email, password);
};

const csvForm = (text, name = "tasks.csv") => {
  const f = new FormData();
  f.append("file", new Blob([text], { type: "text/csv" }), name);
  return f;
};

const T = {}; // tokens
const ID = {}; // ids

before(async () => {
  await mongoose.connect(mongod.getUri());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  await User.create({
    name: "Root", email: "root@test.io", password: "Root@123", role: "SuperAdmin",
  });
  T.super = await login("ROOT@test.io ", "Root@123"); // email is case/space-insensitive
});

after(async () => {
  for (const f of createdFiles) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  const { RECORDING_DIR } = await import("../src/controllers/meetingMediaController.js");
  for (const m of await mongoose.model("Meeting").find({ "recordingFile.filename": { $ne: null } }).lean()) {
    if (m.recordingFile?.filename) fs.rmSync(path.join(RECORDING_DIR, m.recordingFile.filename), { force: true });
  }
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

describe("Super Admin login + dashboard data", () => {
  test("login returns role and full permissions; /me refreshes them", async () => {
    const me = await call("GET", "/api/auth/me", { token: T.super });
    assert.equal(me.status, 200);
    assert.equal(me.data.data.role, "SuperAdmin");
    assert.ok(me.data.data.permissions.users.includes("assign"));
    assert.equal(me.data.data.password, undefined);
  });

  test("SuperAdmin creates two Admins (two organizations)", async () => {
    for (const k of ["A", "B"]) {
      const r = await call("POST", "/api/admins", {
        token: T.super,
        json: { name: `Admin ${k}`, email: `admin${k}@test.io`, password: "Admin@123", companyName: `Company ${k}` },
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ID[`admin${k}`] = r.data.data._id;
      T[`admin${k}`] = await activate(`admin${k}@test.io`, "Admin@123");
    }
  });

  test("SuperAdmin can create a member inside a chosen organization", async () => {
    const r = await call("POST", "/api/users", {
      token: T.super,
      json: { name: "Bob B", email: "bob@test.io", password: "User@123", role: "User", department: "Sales", adminId: ID.adminB },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(String(r.data.data.admin_id), ID.adminB);
    ID.bob = r.data.data._id;
    T.bob = await activate("bob@test.io", "User@123");
  });

  test("SuperAdmin dashboard endpoints return real admins with org counts", async () => {
    const admins = await call("GET", "/api/admins", { token: T.super });
    assert.equal(admins.status, 200);
    assert.equal(admins.data.count, 2);
    const b = admins.data.data.find((a) => a._id === ID.adminB);
    assert.equal(b.members, 1);
    const users = await call("GET", "/api/users", { token: T.super });
    assert.equal(users.status, 200);
    assert.ok(users.data.data.every((u) => u.role !== "SuperAdmin"));
  });

  test("Admins cannot reach SuperAdmin-only APIs", async () => {
    assert.equal((await call("GET", "/api/admins", { token: T.adminA })).status, 403);
    assert.equal((await call("POST", "/api/admins", { token: T.adminA, json: { name: "x", email: "x@x.io", password: "123456" } })).status, 403);
    assert.equal((await call("GET", "/api/permissions/admins", { token: T.adminA })).status, 403);
  });
});

describe("User roles", () => {
  test("Admin creates Manager and Team Member — role is saved", async () => {
    const m = await call("POST", "/api/users", {
      token: T.adminA,
      json: { name: "Mia Manager", email: "mia@test.io", password: "User@123", role: "Manager", department: "Development" },
    });
    assert.equal(m.status, 201, JSON.stringify(m.data));
    assert.equal(m.data.data.role, "Manager");
    ID.mia = m.data.data._id;

    for (const [key, name, email, dept] of [
      ["alice", "Alice", "alice@test.io", "Development"],
      ["dan", "Dan", "dan@test.io", "Development"],
      ["sam", "Sam Sales", "sam@test.io", "Sales"],
    ]) {
      const r = await call("POST", "/api/users", {
        token: T.adminA,
        json: { name, email, password: "User@123", role: "User", department: dept },
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ID[key] = r.data.data._id;
    }
    T.mia = await activate("mia@test.io", "User@123");
    T.alice = await activate("alice@test.io", "User@123");
    T.dan = await activate("dan@test.io", "User@123");

    const list = await call("GET", "/api/users", { token: T.adminA });
    const roles = Object.fromEntries(list.data.data.map((u) => [u.email, u.role]));
    assert.deepEqual(roles, { "mia@test.io": "Manager", "alice@test.io": "User", "dan@test.io": "User", "sam@test.io": "User" });
    assert.ok(!list.data.data.some((u) => u.email === "bob@test.io"), "Admin A must not see Admin B's users");
  });

  test("invalid / escalating role assignments are rejected", async () => {
    const asSuper = await call("POST", "/api/users", {
      token: T.adminA, json: { name: "Evil", email: "evil@test.io", password: "User@123", role: "SuperAdmin" },
    });
    assert.equal(asSuper.status, 403);
    const asAdmin = await call("PUT", `/api/users/${ID.alice}`, { token: T.adminA, json: { role: "Admin" } });
    assert.equal(asAdmin.status, 403);
    const bogus = await call("PUT", `/api/users/${ID.alice}`, { token: T.adminA, json: { role: "Wizard" } });
    assert.equal(bogus.status, 403);
    const self = await call("PUT", `/api/users/${ID.mia}`, { token: T.mia, json: { role: "Admin" } });
    assert.equal(self.status, 403);
  });

  test("role change persists on the correct record", async () => {
    const r = await call("PUT", `/api/users/${ID.dan}`, { token: T.adminA, json: { role: "Manager" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await User.findById(ID.dan)).role, "Manager");
    assert.equal((await User.findById(ID.alice)).role, "User");
    const back = await call("PUT", `/api/users/${ID.dan}`, { token: T.adminA, json: { role: "User" } });
    assert.equal(back.status, 200);
  });

  test("cross-organization user management is blocked", async () => {
    assert.equal((await call("PUT", `/api/users/${ID.bob}`, { token: T.adminA, json: { name: "hacked" } })).status, 403);
    assert.equal((await call("DELETE", `/api/users/${ID.bob}`, { token: T.adminA })).status, 403);
    assert.equal((await call("GET", `/api/users/${ID.bob}`, { token: T.adminA })).status, 403);
  });

  test("Team Members cannot list or manage users", async () => {
    assert.equal((await call("GET", "/api/users", { token: T.alice })).status, 403);
    assert.equal((await call("POST", "/api/users", { token: T.alice, json: {} })).status, 403);
  });
});

describe("Tasks — create with attachments, edit, delete, permissions", () => {
  test("Admin creates a task with files (multipart) assigned to Alice", async () => {
    const f = new FormData();
    f.append("name", "Write spec");
    f.append("department", "Development");
    f.append("assignedUser", "Alice");
    f.append("dueDate", "2030-01-15");
    f.append("subtasks", JSON.stringify([{ title: "outline" }]));
    f.append("recurring", "false");
    f.append("files", new Blob(["%PDF-1.4 test"], { type: "application/pdf" }), "spec.pdf");
    f.append("files", new Blob(["a,b\n1,2"], { type: "text/csv" }), "data.csv");
    const r = await call("POST", "/api/tasks", { token: T.adminA, form: f });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const t = r.data.data;
    ID.task = t.id;
    assert.equal(t.assignedUser, "Alice");
    assert.equal(t.attachments.length, 2);
    assert.equal(t.subtasks.length, 1);
    t.attachments.forEach((a) => createdFiles.push(a.filename));
    ID.file = t.attachments[0].filename;
    assert.ok(fs.existsSync(path.join(UPLOAD_DIR, ID.file)), "file stored on disk, not in MongoDB");
  });

  test("unsupported file type is rejected with 400", async () => {
    const f = new FormData();
    f.append("name", "Bad file");
    f.append("files", new Blob(["MZ"]), "virus.exe");
    const r = await call("POST", "/api/tasks", { token: T.adminA, form: f });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /not a supported file type/);
  });

  test("empty files are rejected with 400", async () => {
    const f = new FormData();
    f.append("name", "Empty file");
    f.append("files", new Blob([]), "empty.pdf");
    const r = await call("POST", "/api/tasks", { token: T.adminA, form: f });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /is empty/);
  });

  test("attachments persist and download only for authorized users", async () => {
    const list = await call("GET", "/api/tasks", { token: T.alice });
    const t = list.data.data.find((x) => x.id === ID.task);
    assert.equal(t.attachments.length, 2);
    const ok = await call("GET", `/api/tasks/attachments/${ID.file}`, { token: T.alice });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-disposition"), /spec\.pdf/);
    assert.equal((await call("GET", `/api/tasks/attachments/${ID.file}`, { token: T.adminB })).status, 404);
    assert.equal((await call("GET", `/api/tasks/attachments/${ID.file}`)).status, 401);
    assert.equal((await fetch(`${base}/uploads/tasks/${ID.file}`)).status, 404, "no public static access");
  });

  test("Admin edits the task — resending the same assignee is not a reassignment", async () => {
    const r = await call("PATCH", `/api/tasks/${ID.task}`, {
      token: T.adminA,
      json: { name: "Write spec v2", assignedUser: "Alice", priority: "High", attachments: [{ filename: ID.file }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.name, "Write spec v2");
    assert.equal(r.data.data.attachments.length, 1, "removed attachment dropped");
    const fresh = await Task.findById(ID.task);
    assert.equal(fresh.priority, "High");
  });

  test("assignee (not creator) cannot edit or delete, but can update status", async () => {
    const edit = await call("PATCH", `/api/tasks/${ID.task}`, { token: T.alice, json: { name: "mine now" } });
    assert.equal(edit.status, 403);
    const del = await call("DELETE", `/api/tasks/${ID.task}`, { token: T.alice });
    assert.equal(del.status, 403);
    const st = await call("PATCH", `/api/tasks/${ID.task}/status`, { token: T.alice, json: { status: "In Progress" } });
    assert.equal(st.status, 200);
  });

  test("other organization cannot see, edit or delete the task", async () => {
    assert.equal((await call("PATCH", `/api/tasks/${ID.task}`, { token: T.adminB, json: { name: "x" } })).status, 404);
    assert.equal((await call("DELETE", `/api/tasks/${ID.task}`, { token: T.adminB })).status, 404);
    assert.equal((await call("GET", `/api/tasks/${ID.task}`, { token: T.bob })).status, 404);
  });

  test("Team Member creates, edits and deletes his OWN task; cannot assign others", async () => {
    const c = await call("POST", "/api/tasks", { token: T.alice, json: { name: "Personal todo", assignedUser: ID.alice } });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const e = await call("PATCH", `/api/tasks/${c.data.data.id}`, { token: T.alice, json: { description: "updated" } });
    assert.equal(e.status, 200);
    const d = await call("DELETE", `/api/tasks/${c.data.data.id}`, { token: T.alice });
    assert.equal(d.status, 200);
    const other = await call("POST", "/api/tasks", { token: T.alice, json: { name: "For Sam", assignedUser: "Sam Sales" } });
    assert.equal(other.status, 403);
  });

  test("same-named user in another organization does not break assignment", async () => {
    await call("POST", "/api/users", {
      token: T.adminB, json: { name: "Alice", email: "alice.b@test.io", password: "User@123", role: "User", department: "Development" },
    });
    const r = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Name clash", assignedUser: "Alice", department: "Development" } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(String(r.data.data.assignedTo), ID.alice);
  });

  test("assigning a user from another org or another department is refused", async () => {
    const cross = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "x", assignedUser: ID.bob } });
    assert.equal(cross.status, 403);
    const dept = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "x", assignedUser: ID.sam, department: "Development" } });
    assert.equal(dept.status, 400);
    assert.match(dept.data.message, /not in the "Development" department/);
  });

  test("Admin deletes the task and its files are removed", async () => {
    const r = await call("DELETE", `/api/tasks/${ID.task}`, { token: T.adminA });
    assert.equal(r.status, 200);
    assert.equal(await Task.findById(ID.task), null);
    assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, ID.file)));
  });
});

describe("Task Bank assignment", () => {
  test("assign creates a real task for the selected user", async () => {
    const item = await call("POST", "/api/taskbank", {
      token: T.adminA,
      json: { title: "Code review", description: "Review the PR", department: "Development", priority: "High" },
    });
    assert.equal(item.status, 201);
    ID.bank = item.data.data._id;

    const r = await call("POST", `/api/taskbank/${ID.bank}/assign`, {
      token: T.adminA, json: { assignedUser: ID.alice, dueDate: "2030-02-01" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.data.lastAssignedTo, "Alice");
    assert.equal(r.data.data.usageCount, 1);

    const mine = await call("GET", "/api/tasks", { token: T.alice });
    const t = mine.data.data.find((x) => x.name === "Code review");
    assert.ok(t, "task visible in the assignee's task list");
    assert.equal(t.assignedUser, "Alice");
    assert.equal(t.dueDate, "2030-02-01");
    assert.equal(String(t.sourceTemplate), ID.bank);

    const reload = await call("GET", "/api/taskbank", { token: T.adminA });
    assert.equal(reload.data.data.find((i) => i._id === ID.bank).lastAssignedTo, "Alice");
  });

  test("missing, foreign and wrong-department users are rejected", async () => {
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.adminA, json: {} })).status, 400);
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.adminA, json: { assignedUser: ID.bob } })).status, 403);
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.adminA, json: { assignedUser: ID.sam } })).status, 400);
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.adminB, json: { assignedUser: ID.bob } })).status, 404);
  });

  test("reassign moves the SAME task to another user (no duplicate) and emails both", async () => {
    const before = await Task.countDocuments({ sourceTemplate: ID.bank });
    const r = await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminA, json: { assignedUser: ID.dan } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.lastAssignedTo, "Dan");
    assert.equal(await Task.countDocuments({ sourceTemplate: ID.bank }), before, "no new task");
    const t = await Task.findOne({ sourceTemplate: ID.bank });
    assert.equal(String(t.assignedTo), ID.dan);
    const until = Date.now() + 3000;
    while (Date.now() < until && !sentMessages.some((m) => m.to === "dan@test.io" && /Task reassigned to you: Code review/.test(m.subject))) {
      await new Promise((x) => setTimeout(x, 25));
    }
    assert.ok(sentMessages.some((m) => m.to === "dan@test.io" && /Task reassigned to you: Code review/.test(m.subject)));
    assert.ok(sentMessages.some((m) => m.to === "alice@test.io" && /Task reassigned: Code review → Dan/.test(m.subject)));

    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminA, json: { assignedUser: ID.dan } })).status, 400, "same person");
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminA, json: { assignedUser: ID.bob } })).status, 403, "other org user");
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminB, json: { assignedUser: ID.bob } })).status, 404, "other org template");
    const fresh = await call("POST", "/api/taskbank", { token: T.adminA, json: { title: "Never assigned", description: "x", department: "Development" } });
    const na = await call("POST", `/api/taskbank/${fresh.data.data._id}/reassign`, { token: T.adminA, json: { assignedUser: ID.dan } });
    assert.equal(na.status, 400);
    // back to Alice so later tests keep their assumptions
    await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminA, json: { assignedUser: ID.alice } });
  });

  test("Team Member without taskbank.assign cannot assign; seed is SuperAdmin-only", async () => {
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.alice, json: { assignedUser: ID.alice } })).status, 403);
    assert.equal((await call("GET", "/api/taskbank/seed")).status, 401);
    assert.equal((await call("GET", "/api/taskbank/seed", { token: T.adminA })).status, 403);
  });
});

describe("Calendar CSV import", () => {
  const csv = [
    "Title,Date,Time,Department,Assignee,Status,Priority,Description",
    "Deploy,2030-03-10,10:30,Development,Alice,Pending,High,Ship it",
    "No date,,09:00,Development,Alice,Pending,Low,",
    "Bad date,2030-02-30,09:00,Development,Alice,Pending,Low,",
    "Ghost,2030-03-11,09:00,Development,Nobody,Pending,Low,",
    "Deploy,2030-03-10,10:30,Development,Alice,Pending,High,dup in file",
    "Bad prio,2030-03-12,09:00,Development,Alice,Pending,Urgent,",
  ].join("\n");

  test("preview validates rows without saving", async () => {
    const before = await Task.countDocuments();
    const r = await call("POST", "/api/tasks/import?preview=true", { token: T.adminA, form: csvForm(csv) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.summary, { total: 6, valid: 1, invalid: 4, duplicates: 1 });
    assert.equal(await Task.countDocuments(), before);
  });

  test("import saves valid rows; re-import is detected as duplicate", async () => {
    const r = await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm(csv) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.imported, 1);
    const t = await Task.findOne({ name: "Deploy" });
    assert.equal(t.dueTime, "10:30");
    assert.equal(String(t.assignedTo), ID.alice);
    assert.equal(String(t.admin_id), ID.adminA);

    const again = await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm(csv) });
    assert.equal(again.status, 400);
    assert.equal(again.data.summary.duplicates, 2);
  });

  test("empty, header-only, malformed and non-CSV files are rejected", async () => {
    assert.equal((await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm("") })).status, 400);
    assert.equal((await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm("Title,Date\n") })).status, 400);
    assert.equal((await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm("foo,bar\n1,2") })).status, 400);
    assert.equal((await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm("x", "x.txt") })).status, 400);
  });

  test("Team Member (no calendar.import) cannot import", async () => {
    assert.equal((await call("POST", "/api/tasks/import", { token: T.alice, form: csvForm(csv) })).status, 403);
  });
});

describe("Role-based permissions (backend managed)", () => {
  test("Admin loads role config with real user counts", async () => {
    const r = await call("GET", "/api/permissions/roles", { token: T.adminA });
    assert.equal(r.status, 200);
    const user = r.data.data.roles.find((x) => x.role === "User");
    assert.equal(user.users, 3);
    assert.equal(user.isCustomized, false);
  });

  test("revoking a permission takes effect immediately", async () => {
    assert.equal((await call("GET", "/api/taskbank", { token: T.alice })).status, 200);
    const cfg = await call("GET", "/api/permissions/roles", { token: T.adminA });
    const perms = cfg.data.data.roles.find((x) => x.role === "User").permissions;
    perms.taskbank = [];
    const save = await call("PUT", "/api/permissions/roles/User", { token: T.adminA, json: { permissions: perms } });
    assert.equal(save.status, 200, JSON.stringify(save.data));
    assert.equal((await call("GET", "/api/taskbank", { token: T.alice })).status, 403);
    const me = await call("GET", "/api/auth/me", { token: T.alice });
    assert.deepEqual(me.data.data.permissions.taskbank, []);
    // Admin B's users are unaffected (organization isolation)
    assert.equal((await call("GET", "/api/taskbank", { token: T.bob })).status, 200);
  });

  test("SuperAdmin restricts an Admin; the Admin cannot grant what he lacks", async () => {
    const all = (await call("GET", "/api/permissions/admins", { token: T.super })).data.data.find((a) => a._id === ID.adminA).permissions;
    const restricted = { ...all, reports: [] };
    const r = await call("PUT", `/api/permissions/admins/${ID.adminA}`, { token: T.super, json: { permissions: restricted } });
    assert.equal(r.status, 200);

    assert.equal((await call("GET", "/api/reports/summary", { token: T.adminA })).status, 403);
    // Members inherit the cap
    assert.equal((await call("GET", "/api/reports/summary", { token: T.mia })).status, 403);

    const grant = await call("PUT", "/api/permissions/roles/Manager", {
      token: T.adminA, json: { permissions: { ...restricted, reports: ["view"] } },
    });
    assert.equal(grant.status, 403);

    // restore
    await call("PUT", `/api/permissions/admins/${ID.adminA}`, { token: T.super, json: { permissions: all } });
    assert.equal((await call("GET", "/api/reports/summary", { token: T.adminA })).status, 200);
  });

  test("members cannot edit role permissions", async () => {
    assert.equal((await call("PUT", "/api/permissions/roles/User", { token: T.mia, json: { permissions: {} } })).status, 403);
  });
});

describe("Email verification + admin-set passwords", () => {
  test("new account cannot log in before verifying; email never contains the password", async () => {
    const r = await call("POST", "/api/users", {
      token: T.adminA, json: { name: "Vera", email: "vera@test.io", password: "Vera@1234", role: "User", department: "Development" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.emailSent, true);
    const blocked = await call("POST", "/api/auth/login", { json: { email: "vera@test.io", password: "Vera@1234" } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, "EMAIL_NOT_VERIFIED");
    const mail = [...sentMessages].reverse().find((m) => m.to === "vera@test.io");
    assert.ok(!mail.text.includes("Vera@1234"), "password is not in the email");
    const stored = await User.findOne({ email: "vera@test.io" }).select("+pendingPasswordEnc").lean();
    assert.ok(stored.pendingPasswordEnc && !stored.pendingPasswordEnc.includes("Vera@1234"), "stored encrypted");
    ID.vera = String(stored._id);
  });

  test("verification link reveals the password once, then it is destroyed", async () => {
    const token = tokenFor("vera@test.io");
    const first = await call("POST", "/api/auth/verify-email", { json: { token } });
    assert.equal(first.status, 200);
    assert.equal(first.data.data.password, "Vera@1234");
    assert.equal(first.data.data.visibleForSeconds, 30);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const again = await call("POST", "/api/auth/verify-email", { json: { token } });
    assert.equal(again.status, 404, "link is single-use");
    const stored = await User.findById(ID.vera).select("+pendingPasswordEnc").lean();
    assert.equal(stored.pendingPasswordEnc, null);
    T.vera = await login("vera@test.io", "Vera@1234");
    assert.equal((await call("POST", "/api/auth/verify-email", { json: { token: "abc" } })).status, 400);
  });

  test("expired link is refused", async () => {
    await call("POST", "/api/users", {
      token: T.adminA, json: { name: "Late", email: "late@test.io", password: "Late@1234", role: "User", department: "Development" },
    });
    await User.updateOne({ email: "late@test.io" }, { verificationExpires: new Date(Date.now() - 1000) });
    const r = await call("POST", "/api/auth/verify-email", { json: { token: tokenFor("late@test.io") } });
    assert.equal(r.status, 410);
    // admin resends → new working link
    const late = await User.findOne({ email: "late@test.io" });
    const resend = await call("POST", `/api/users/${late._id}/resend-verification`, { token: T.adminA });
    assert.equal(resend.status, 200, JSON.stringify(resend.data));
    const ok = await call("POST", "/api/auth/verify-email", { json: { token: tokenFor("late@test.io") } });
    assert.equal(ok.data.data.password, "Late@1234");
  });

  test("forgot password → request + email to the user's Admin → admin sets new password", async () => {
    const r = await call("POST", "/api/auth/forgot-password", { json: { email: "vera@test.io" } });
    assert.equal(r.status, 200);
    const unknown = await call("POST", "/api/auth/forgot-password", { json: { email: "nobody@test.io" } });
    assert.equal(unknown.data.message, r.data.message, "same answer for unknown emails");
    await call("POST", "/api/auth/forgot-password", { json: { email: "vera@test.io" } }); // duplicate ignored

    const notice = [...sentMessages].reverse().find((m) => m.to === "admina@test.io");
    assert.match(notice.subject, /Password reset requested by Vera/);

    const listA = await call("GET", "/api/password-requests", { token: T.adminA });
    assert.equal(listA.data.count, 1);
    assert.equal((await call("GET", "/api/password-requests", { token: T.adminB })).data.count, 0, "other org can't see it");
    assert.equal((await call("GET", "/api/password-requests", { token: T.alice })).status, 403);

    const set = await call("POST", `/api/users/${ID.vera}/set-password`, { token: T.adminA, json: { password: "Fresh@5678" } });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    assert.equal((await call("GET", "/api/password-requests", { token: T.adminA })).data.count, 0, "request completed");

    const reveal = await call("POST", "/api/auth/verify-email", { json: { token: tokenFor("vera@test.io") } });
    assert.equal(reveal.data.data.password, "Fresh@5678");
    await login("vera@test.io", "Fresh@5678");
  });

  test("only the user's own administrator can set passwords", async () => {
    assert.equal((await call("POST", `/api/users/${ID.vera}/set-password`, { token: T.adminB, json: { password: "Hack@1234" } })).status, 403);
    assert.equal((await call("POST", `/api/users/${ID.vera}/set-password`, { token: T.alice, json: { password: "Hack@1234" } })).status, 403);
    assert.equal((await call("POST", `/api/users/${ID.vera}/set-password`, { token: T.adminA, json: { password: "123" } })).status, 400);
  });

  test("Admin's forgot-password request goes to the SuperAdmin", async () => {
    await call("POST", "/api/auth/forgot-password", { json: { email: "adminB@test.io" } });
    const list = await call("GET", "/api/password-requests", { token: T.super });
    assert.ok(list.data.data.some((x) => x.user.email === "adminb@test.io"));
    const notice = [...sentMessages].reverse().find((m) => m.to === "root@test.io");
    assert.match(notice.subject, /Admin B/);
  });
});

describe("Task email notifications + reminders", () => {
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const mailsTo = (email, rx) => sentMessages.filter((m) => m.to === email && rx.test(m.subject));
  let svc;
  let taskId;
  let deadline;

  before(async () => {
    svc = await import("../src/services/taskNotificationService.js");
  });

  test("assigning a task emails the assignee and adds a dashboard notification", async () => {
    const r = await call("POST", "/api/tasks", {
      token: T.adminA,
      json: { name: "Notify me", assignedUser: ID.dan, department: "Development", dueDate: "2031-03-10", dueTime: "15:00" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    taskId = r.data.data.id;
    assert.ok(await waitFor(() => mailsTo("dan@test.io", /New task assigned: Notify me/).length === 1), "assignment email");
    const n = await call("GET", "/api/notifications", { token: T.dan });
    assert.ok(n.data.data.some((x) => x.type === "task_assigned" && x.taskName === "Notify me"));
    deadline = svc.deadlineOf(await Task.findById(taskId));
    assert.equal(deadline.toISOString(), "2031-03-10T09:30:00.000Z", "15:00 Asia/Kolkata");
  });

  test("reminder 1 at 3h, reminder 2 at 1h, each sent once", async () => {
    const at = (ms) => new Date(deadline.getTime() + ms);
    const H = 3600 * 1000;
    assert.deepEqual(await svc.runTaskReminderSweep(at(-4 * H)), { reminder3h: 0, reminder1h: 0, overdue: 0 });
    assert.equal((await svc.runTaskReminderSweep(at(-2.5 * H))).reminder3h, 1);
    assert.equal((await svc.runTaskReminderSweep(at(-2.4 * H))).reminder3h, 0, "not repeated");
    assert.equal((await svc.runTaskReminderSweep(at(-0.5 * H))).reminder1h, 1);
    assert.equal(mailsTo("dan@test.io", /Reminder 1: "Notify me" is due in 3 hours/).length, 1);
    assert.equal(mailsTo("dan@test.io", /Reminder 2: "Notify me" is due in 1 hour/).length, 1);
  });

  test("deadline reached while not started → alert to user AND the assigner", async () => {
    const r = await svc.runTaskReminderSweep(new Date(deadline.getTime() + 60 * 1000));
    assert.equal(r.overdue, 1);
    assert.equal(mailsTo("dan@test.io", /Deadline reached: please start "Notify me"/).length, 1);
    assert.equal(mailsTo("admina@test.io", /Dan has not started "Notify me"/).length, 1);
    assert.equal((await svc.runTaskReminderSweep(new Date(deadline.getTime() + 5 * 60 * 1000))).overdue, 0, "once only");
    const n = await call("GET", "/api/notifications", { token: T.adminA });
    assert.ok(n.data.data.some((x) => x.type === "task_overdue" && x.actorName === "Dan"));
  });

  test("started tasks get no reminders; old missed deadlines are not alerted", async () => {
    const started = await call("POST", "/api/tasks", {
      token: T.adminA, json: { name: "Already going", assignedUser: ID.dan, dueDate: "2031-04-01", dueTime: "12:00" },
    });
    await call("PATCH", `/api/tasks/${started.data.data.id}/status`, { token: T.dan, json: { status: "In Progress" } });
    const old = await call("POST", "/api/tasks", {
      token: T.adminA, json: { name: "Long overdue", assignedUser: ID.dan, dueDate: "2031-04-01", dueTime: "12:00" },
    });
    const d = svc.deadlineOf(await Task.findById(old.data.data.id));
    const r1 = await svc.runTaskReminderSweep(new Date(d.getTime() - 2 * 3600 * 1000));
    assert.equal(r1.reminder3h, 1, "only the not-started task");
    const r2 = await svc.runTaskReminderSweep(new Date(d.getTime() + 5 * 3600 * 1000));
    assert.equal(r2.overdue, 0, "missed more than 2h ago → no alert");
  });

  test("status change emails the assigner and shows who changed it on their dashboard", async () => {
    const r = await call("PATCH", `/api/tasks/${taskId}/status`, { token: T.dan, json: { status: "In Progress" } });
    assert.equal(r.status, 200);
    assert.ok(await waitFor(() => mailsTo("admina@test.io", /Dan moved "Notify me" to In Progress/).length === 1));
    const n = await call("GET", "/api/notifications?type=task_status", { token: T.adminA });
    const item = n.data.data.find((x) => x.taskName === "Notify me");
    assert.equal(item.actorName, "Dan");
    assert.equal(item.fromStatus, "To Do");
    assert.equal(item.toStatus, "In Progress");
    assert.ok(n.data.unread >= 1);
    // only my own notifications; mark read
    const other = await call("GET", "/api/notifications?type=task_status", { token: T.adminB });
    assert.ok(!other.data.data.some((x) => x.taskName === "Notify me"));
    assert.equal((await call("PATCH", `/api/notifications/${item._id}/read`, { token: T.adminB })).status, 404);
    assert.equal((await call("PATCH", `/api/notifications/${item._id}/read`, { token: T.adminA })).status, 200);
    assert.equal((await call("PATCH", "/api/notifications/read-all", { token: T.adminA })).status, 200);
    assert.equal((await call("GET", "/api/notifications", { token: T.adminA })).data.unread, 0);
  });

  test("reassigning emails the new AND the previous assignee", async () => {
    const t = await call("POST", "/api/tasks", {
      token: T.adminA, json: { name: "Hand over", assignedUser: ID.dan, department: "Development" },
    });
    await waitFor(() => mailsTo("dan@test.io", /New task assigned: Hand over/).length === 1);

    const r = await call("PATCH", `/api/tasks/${t.data.data.id}`, {
      token: T.adminA, json: { assignedUser: ID.alice },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(await waitFor(() => mailsTo("alice@test.io", /Task reassigned to you: Hand over/).length === 1), "new assignee");
    assert.ok(await waitFor(() => mailsTo("dan@test.io", /Task reassigned: Hand over → Alice/).length === 1), "previous assignee");
    assert.equal(mailsTo("alice@test.io", /New task assigned: Hand over/).length, 0, "no duplicate plain assignment email");
    const n = await call("GET", "/api/notifications", { token: T.dan });
    assert.ok(n.data.data.some((x) => x.type === "task_reassigned" && /no longer assigned to you/.test(x.message)));

    // saving the form with the same assignee is NOT a reassignment
    const before = sentMessages.length;
    await call("PATCH", `/api/tasks/${t.data.data.id}`, { token: T.adminA, json: { assignedUser: ID.alice, description: "x" } });
    await new Promise((r2) => setTimeout(r2, 200));
    assert.equal(sentMessages.slice(before).filter((m) => /reassigned/i.test(m.subject)).length, 0);

    // Manager can reassign too; unassigning tells the previous person
    await call("PATCH", `/api/tasks/${t.data.data.id}`, { token: T.mia, json: { assignedUser: "" } });
    assert.ok(await waitFor(() => mailsTo("alice@test.io", /you were removed from Hand over/).length === 1), "removed notice");
  });

  test("users who turned off email notifications still get dashboard notifications only", async () => {
    await call("PUT", "/api/auth/me/preferences", { token: T.dan, json: { emailNotifications: false } });
    const before = sentMessages.length;
    await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Quiet task", assignedUser: ID.dan } });
    await waitFor(async () => (await call("GET", "/api/notifications", { token: T.dan })).data.data.some((x) => x.taskName === "Quiet task"));
    assert.equal(sentMessages.slice(before).filter((m) => m.to === "dan@test.io").length, 0);
    await call("PUT", "/api/auth/me/preferences", { token: T.dan, json: { emailNotifications: true } });
  });
});

describe("Settings", () => {
  test("profile and preferences persist; protected fields ignored", async () => {
    const r = await call("PUT", "/api/auth/me", {
      token: T.alice, json: { name: "Alice Wonder", phone: "9876543210", bio: "hi", department: "Sales", role: "Admin" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const me = await call("GET", "/api/auth/me", { token: T.alice });
    assert.equal(me.data.data.name, "Alice Wonder");
    assert.equal(me.data.data.department, "Development", "members cannot move themselves to another department");
    assert.equal(me.data.data.role, "User");

    const p = await call("PUT", "/api/auth/me/preferences", { token: T.alice, json: { taskReminders: false, timezone: "Europe/London" } });
    assert.equal(p.status, 200);
    const again = await call("GET", "/api/auth/me", { token: T.alice });
    assert.equal(again.data.data.preferences.taskReminders, false);
    assert.equal(again.data.data.preferences.timezone, "Europe/London");
    assert.equal((await call("PUT", "/api/auth/me/preferences", { token: T.alice, json: { timezone: "Mars" } })).status, 400);
  });

  test("password change validates current password", async () => {
    const bad = await call("PUT", "/api/auth/change-password", { token: T.alice, json: { currentPassword: "nope", newPassword: "Next@123" } });
    assert.equal(bad.status, 400);
    const ok = await call("PUT", "/api/auth/change-password", { token: T.alice, json: { currentPassword: "User@123", newPassword: "Next@123" } });
    assert.equal(ok.status, 200);
    T.alice = await login("alice@test.io", "Next@123");
  });
});

describe("Organization isolation — MoM meetings and support tickets", () => {
  test("meetings are visible only inside the creator's organization", async () => {
    const Meeting = (await import("../src/models/Meeting.js")).default;
    const m = await Meeting.create({ title: "Org A sync", meetingDate: new Date("2030-01-01"), createdBy: ID.adminA });
    const listA = await call("GET", "/api/meetings", { token: T.alice });
    assert.ok(listA.data.data.some((x) => x._id === String(m._id)), "same-org member sees it");
    const listB = await call("GET", "/api/meetings", { token: T.adminB });
    assert.ok(!listB.data.data.some((x) => x._id === String(m._id)), "other org does not");
    assert.equal((await call("GET", `/api/meetings/${m._id}`, { token: T.bob })).status, 404);
    assert.equal((await call("DELETE", `/api/meetings/${m._id}`, { token: T.adminB })).status, 404);
    assert.ok(await Meeting.findById(m._id), "not deleted by other org");
    const all = await call("GET", "/api/meetings", { token: T.super });
    assert.ok(all.data.data.some((x) => x._id === String(m._id)), "SuperAdmin sees all");
  });

  test("tickets: owner + own org admin only", async () => {
    const t = await call("POST", "/api/support/tickets", { token: T.alice, json: { subject: "Help", message: "Broken" } });
    assert.equal(t.status, 201);
    const id = t.data.data.id;
    assert.equal((await call("GET", `/api/support/tickets/${id}`, { token: T.adminB })).status, 404);
    assert.equal((await call("DELETE", `/api/support/tickets/${id}`, { token: T.bob })).status, 404);
    assert.equal((await call("PATCH", `/api/support/tickets/${id}`, { token: T.adminB, json: { status: "Closed" } })).status, 404);
    assert.equal((await call("GET", `/api/support/tickets/${id}`, { token: T.adminA })).status, 200);
    const stats = await call("GET", "/api/support/tickets/stats", { token: T.adminB });
    assert.equal(stats.data.data.total, 0, "stats are org-scoped");
    assert.equal((await call("PATCH", `/api/support/tickets/${id}`, { token: T.adminA, json: { status: "Resolved" } })).status, 200);
    assert.equal((await call("POST", "/api/support/faqs", { token: T.alice, json: { question: "q", answer: "a" } })).status, 403);
  });
});

describe("MoM — points, action plans, multiple users, recording, transcript", () => {
  let mid;

  test("discussion points, action plans (multiple owners) and members are saved", async () => {
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: {
        title: "Sprint review", meetingDate: "2031-02-01", meetingType: "Offline",
        departments: ["Development"], recording: true, transcription: true,
        attendees: [
          { name: "Alice", email: "alice@test.io", userId: ID.alice },
          { name: "Dan", email: "dan@test.io", userId: ID.dan },
        ],
        points: [{ title: "Velocity dropped" }, { title: "Release plan", completed: true }],
        actions: [{
          title: "Fix flaky tests",
          owners: [{ userId: ID.alice, name: "Alice", email: "alice@test.io" }, { userId: ID.dan, name: "Dan" }],
          owner: "Alice, Dan", dueDate: "2031-02-05",
        }],
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    mid = r.data.data._id;
    const g = await call("GET", `/api/meetings/${mid}`, { token: T.alice });
    const m = g.data.data;
    assert.equal(m.points.length, 2);
    assert.equal(m.points[1].completed, true);
    assert.equal(m.actions[0].owners.length, 2);
    assert.deepEqual(m.departments, ["Development"]);
    assert.equal(m.recording, true);
    assert.equal(m.transcription, true);
    assert.equal(m.attendees.length, 2);
  });

  test("participants list = my organization only", async () => {
    const r = await call("GET", "/api/meetings/participants", { token: T.alice });
    assert.equal(r.status, 200);
    const emails = r.data.data.map((u) => u.email);
    assert.ok(emails.includes("dan@test.io") && emails.includes("admina@test.io"));
    assert.ok(!emails.includes("bob@test.io"), "other org excluded");
  });

  test("recording upload → stream (with range) → org isolation → delete", async () => {
    const f = new FormData();
    f.append("durationSec", "42");
    f.append("recording", new Blob([Buffer.alloc(2048, 7)], { type: "video/webm" }), "meeting.webm");
    const up = await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: f });
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.data.durationSec, 42);

    const res = await fetch(`${base}/api/meetings/${mid}/recording`, {
      headers: { Authorization: `Bearer ${T.dan}`, Range: "bytes=0-99" },
    });
    assert.equal(res.status, 206, "seekable stream");
    assert.equal((await res.arrayBuffer()).byteLength, 100);
    assert.equal((await call("GET", `/api/meetings/${mid}/recording`, { token: T.adminB })).status, 404);
    assert.equal((await call("GET", `/api/meetings/${mid}/recording`)).status, 401);

    // browser-style codec label and generic octet-stream are both accepted
    const codec = new FormData();
    codec.append("recording", new Blob([Buffer.alloc(64, 1)], { type: "video/webm;codecs=vp9,opus" }), "meeting.webm");
    assert.equal((await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: codec })).status, 201);
    const generic = new FormData();
    generic.append("recording", new Blob([Buffer.alloc(64, 1)], { type: "application/octet-stream" }), "meeting.webm");
    const g2 = await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: generic });
    assert.equal(g2.status, 201);
    assert.equal(g2.data.data.mimetype, "video/webm");

    const bad = new FormData();
    bad.append("recording", new Blob(["x"], { type: "application/pdf" }), "x.pdf");
    assert.equal((await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: bad })).status, 400);

    const del = await call("DELETE", `/api/meetings/${mid}/recording`, { token: T.adminA });
    assert.equal(del.status, 200);
    assert.equal((await call("GET", `/api/meetings/${mid}/recording`, { token: T.adminA })).status, 404);
  });

  test("transcript import (Google Meet export) shows speakers; live lines append", async () => {
    const imp = await call("POST", `/api/meetings/${mid}/transcript/import`, {
      token: T.adminA, json: { text: "Transcript\n00:00:05\nAlice: Hello everyone\nDan: Status is green" },
    });
    assert.equal(imp.status, 200, JSON.stringify(imp.data));
    assert.deepEqual(imp.data.data.transcript.entries.map((e) => e.speaker), ["Alice", "Dan"]);

    await call("PUT", `/api/meetings/${mid}/transcript`, {
      token: T.adminA, json: { source: "live", entries: [{ speaker: "Admin A", text: "First live line", at: new Date().toISOString() }] },
    });
    const app2 = await call("PUT", `/api/meetings/${mid}/transcript`, {
      token: T.adminA, json: { source: "live", append: true, entries: [{ speaker: "Admin A", text: "Second" }] },
    });
    assert.equal(app2.data.data.transcript.entries.length, 2);
    assert.equal(app2.data.data.transcript.source, "live");

    assert.equal((await call("POST", `/api/meetings/${mid}/transcript/import`, { token: T.adminA, json: { text: "  " } })).status, 400);
    assert.equal((await call("PUT", `/api/meetings/${mid}/transcript`, { token: T.adminB, json: { entries: [{ text: "x" }] } })).status, 404);
  });

  test("Google Meet transcript fetch (fake Meet API) + clear message without a Meet link", async () => {
    const { app } = await import("../src/app.js");
    await Meeting().updateOne({ _id: mid }, { googleMeetLink: "https://meet.google.com/abc-defg-hij" });
    app.set("meetClient", {
      conferenceRecords: {
        list: async ({ filter }) => ({ data: { conferenceRecords: filter.includes("abc-defg-hij") ? [{ name: "conferenceRecords/c1", startTime: "2031-02-01T10:00:00Z" }] : [] } }),
        recordings: { list: async () => ({ data: { recordings: [{ driveDestination: { exportUri: "https://drive.google.com/rec1" } }] } }) },
        transcripts: {
          list: async () => ({ data: { transcripts: [{ name: "conferenceRecords/c1/transcripts/t1" }] } }),
          entries: { list: async () => ({ data: { transcriptEntries: [
            { participant: "conferenceRecords/c1/participants/p1", text: "Let's begin", startTime: "2031-02-01T10:01:00Z" },
            { participant: "conferenceRecords/c1/participants/p2", text: "Ready", startTime: "2031-02-01T10:01:05Z" },
          ] } }) },
        },
        participants: { get: async ({ name }) => ({ data: { signedinUser: { displayName: name.endsWith("p1") ? "Priya" : "Ravi" } } }) },
      },
    });
    const r = await call("POST", `/api/meetings/${mid}/transcript/google`, { token: T.adminA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.data.transcript.entries.map((e) => `${e.speaker}: ${e.text}`), ["Priya: Let's begin", "Ravi: Ready"]);
    assert.equal(r.data.data.googleRecordingUrl, "https://drive.google.com/rec1");
    app.set("meetClient", undefined);

    const noLink = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "No link", meetingDate: "2031-02-02", meetingType: "Offline" } });
    const r2 = await call("POST", `/api/meetings/${noLink.data.data._id}/transcript/google`, { token: T.adminA });
    assert.equal(r2.status, 400);
    assert.equal(r2.data.code, "NO_MEET_LINK");
  });

  test("generic meeting update cannot overwrite recording/transcript", async () => {
    await call("PUT", `/api/meetings/${mid}`, { token: T.adminA, json: { transcript: { entries: [] }, recordingFile: { filename: "../../x" } } });
    const g = await call("GET", `/api/meetings/${mid}`, { token: T.adminA });
    assert.equal(g.data.data.transcript.entries.length, 2);
  });
});

describe("MoM — Google Meet link + invitation failures are reported clearly", () => {
  test("integration status explains what is wrong", async () => {
    const r = await call("GET", "/api/meetings/integration-status", { token: T.adminA });
    assert.equal(r.status, 200);
    assert.equal(r.data.data.google.ok, false);
    assert.equal(r.data.data.google.code, "GOOGLE_NOT_CONNECTED");
    assert.equal(r.data.data.email.ok, false);
  });

  test("create returns the warning; retry gives a clear 503 instead of a 500", async () => {
    const r = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "Online sync", meetingDate: "2031-03-01", startTime: "10:00" } });
    assert.equal(r.status, 201);
    assert.equal(r.data.integration.googleMeetLink, "");
    assert.match(r.data.integration.warning, /Google is not connected/);
    const retry = await call("POST", `/api/meetings/${r.data.data._id}/send-invitation`, { token: T.adminA });
    assert.equal(retry.status, 503);
    assert.equal(retry.data.code, "GOOGLE_NOT_CONNECTED");
  });

  test("client-supplied (fake) Meet links are ignored", async () => {
    const r = await call("POST", "/api/meetings", {
      token: T.adminA, json: { title: "Fake link", meetingDate: "2031-03-02", meetingType: "Offline", googleMeetLink: "https://meet.google.com/abc-defg-hij" },
    });
    assert.equal(r.data.data.googleMeetLink, "");
  });

  test("expired Google token is explained as 'reconnect Google'", async () => {
    const { explainGoogleCalendarError } = await import("../src/services/googleCalendarService.js");
    const e = explainGoogleCalendarError({ response: { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } });
    assert.equal(e.code, "GOOGLE_RECONNECT");
    assert.equal(e.status, 503);
    assert.match(e.message, /npm run google:token/);
  });
});

describe("MoM — transcript from the recording (local Whisper)", () => {
  const poll = async (id, token, until) => {
    const end = Date.now() + 4000;
    let last;
    while (Date.now() < end) {
      last = (await call("GET", `/api/meetings/${id}/transcript`, { token })).data.data.transcript;
      if (until(last)) return last;
      await new Promise((r) => setTimeout(r, 30));
    }
    return last;
  };
  const upload = (id, token) => {
    const f = new FormData();
    f.append("durationSec", "12");
    f.append("recording", new Blob([Buffer.alloc(4096, 3)], { type: "video/webm" }), "meeting.webm");
    return call("POST", `/api/meetings/${id}/recording`, { token, form: f });
  };

  test("uploading a recording (transcription on) creates the transcript automatically", async () => {
    const { setTranscriber } = await import("../src/services/transcriptionService.js");
    setTranscriber(async () => ({ seconds: 12, segments: [{ text: "Welcome everyone", start: 0 }, { text: "Let's review the sprint", start: 4.2 }] }));
    const m = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "Whisper sync", meetingDate: "2031-06-01", startTime: "10:00", meetingType: "Offline", transcription: true, recording: true } });
    const id = m.data.data._id;
    const up = await upload(id, T.adminA);
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.transcribing, true);
    const t = await poll(id, T.alice, (x) => x?.status === "done");
    assert.equal(t.status, "done");
    assert.equal(t.source, "whisper");
    assert.deepEqual(t.entries.map((e) => [e.text, e.offsetSec]), [["Welcome everyone", 0], ["Let's review the sprint", 4.2]]);
    ID.whisperMeeting = id;
  });

  test("failure is reported on the meeting; manual re-run works; guards", async () => {
    const { setTranscriber } = await import("../src/services/transcriptionService.js");
    setTranscriber(async () => { throw new Error("The recording is silent."); });
    const r = await call("POST", `/api/meetings/${ID.whisperMeeting}/transcript/whisper`, { token: T.adminA });
    assert.equal(r.status, 202);
    const failed = await poll(ID.whisperMeeting, T.adminA, (x) => x?.status === "failed");
    assert.match(failed.error, /silent/);

    setTranscriber(async () => ({ seconds: 3, segments: [{ text: "Second try", start: 0 }] }));
    await call("POST", `/api/meetings/${ID.whisperMeeting}/transcript/whisper`, { token: T.adminA });
    const ok = await poll(ID.whisperMeeting, T.adminA, (x) => x?.status === "done");
    assert.equal(ok.entries[0].text, "Second try");

    const noRec = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "No rec", meetingDate: "2031-06-02", meetingType: "Offline" } });
    assert.equal((await call("POST", `/api/meetings/${noRec.data.data._id}/transcript/whisper`, { token: T.adminA })).status, 400);
    assert.equal((await call("POST", `/api/meetings/${ID.whisperMeeting}/transcript/whisper`, { token: T.adminB })).status, 404);
  });
});

describe("MoM invitation email content", () => {
  test("invitation shows time, attendees, discussion points, action plans and the Meet link", async () => {
    const { sendMeetingInvitation, sendMomEmail, capturedMeetingEmails } = await import("../src/services/meetingEmailService.js");
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: {
        title: "Planning", meetingDate: "2031-05-06", startTime: "14:30", endTime: "15:45", meetingType: "Offline",
        departments: ["Development"],
        attendees: [{ name: "Alice", email: "alice@test.io" }, { name: "Dan", email: "dan@test.io" }],
        points: [{ title: "Budget for Q3" }, { title: "Hiring plan", completed: true }],
        actions: [{ title: "Draft budget", owners: [{ name: "Alice" }, { name: "Dan" }], dueDate: "2031-05-10" }],
      },
    });
    const meeting = await Meeting().findById(r.data.data._id);
    meeting.googleMeetLink = "https://meet.google.com/abc-defg-hij";
    const before = capturedMeetingEmails.length;
    const res = await sendMeetingInvitation(meeting);
    assert.equal(res.sentCount, 2);
    const mail = capturedMeetingEmails.slice(before).find((m) => m.to === "alice@test.io");
    for (const expected of ["2:30 PM – 3:45 PM (1 h 15 min)", "Alice, Dan", "1. Budget for Q3", "2. Hiring plan (done)", "Draft budget — Owner(s): Alice, Dan", "https://meet.google.com/abc-defg-hij"]) {
      assert.ok(mail.text.includes(expected), `text contains "${expected}"\n${mail.text}`);
    }
    for (const expected of ["Discussion points", "Budget for Q3", "Action plans", "Join Google Meet", "Development"]) {
      assert.ok(mail.html.includes(expected), `html contains "${expected}"`);
    }
    await sendMomEmail(meeting);
    const mom = capturedMeetingEmails.find((m) => /^Minutes of Meeting: Planning/.test(m.subject));
    assert.ok(mom.text.includes("1. Budget for Q3") && mom.text.includes("Draft budget"));
  });
});

describe("In-app Google reconnect", () => {
  test("only admins get a sign-in link; it returns to GOOGLE_REDIRECT_URI with a one-time state", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:5000/oauth2callback";
    try {
      assert.equal((await call("POST", "/api/google/connect-url", { token: T.alice })).status, 403);
      const r = await call("POST", "/api/google/connect-url", { token: T.adminA });
      assert.equal(r.status, 200);
      const url = new URL(r.data.data.url);
      assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:5000/oauth2callback");
      assert.match(url.searchParams.get("scope"), /calendar\.events/);
      const state = url.searchParams.get("state");
      assert.ok(state && state.length >= 32);

      // forged / unknown state → back to the app with an error, nothing saved
      const forged = await fetch(`${base}/oauth2callback?state=nope&code=x`, { redirect: "manual" });
      assert.equal(forged.status, 302);
      assert.match(forged.headers.get("location"), /dashboard\/mom\?google=error/);
      // user cancelled at Google
      const cancelled = await fetch(`${base}/oauth2callback?state=${state}&error=access_denied`, { redirect: "manual" });
      assert.match(cancelled.headers.get("location"), /access_denied/);
      // state is single-use
      const reused = await fetch(`${base}/oauth2callback?state=${state}&code=x`, { redirect: "manual" });
      assert.match(decodeURIComponent(reused.headers.get("location")), /expired/);
    } finally {
      process.env.GOOGLE_CLIENT_ID = "";
      process.env.GOOGLE_CLIENT_SECRET = "";
    }
  });
});

describe("Support tickets reach the Super Admin", () => {
  const waitMail = async (to, rx) => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (sentMessages.some((m) => m.to === to && rx.test(m.subject))) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  let tid;

  test("raising a ticket emails the Super Admin; dashboard list shows who/which org", async () => {
    const r = await call("POST", "/api/support/tickets", {
      token: T.dan, json: { subject: "Cannot upload file", category: "Tasks", priority: "High", message: "Upload fails" },
    });
    assert.equal(r.status, 201);
    tid = r.data.data.id;
    assert.ok(await waitMail("root@test.io", /New support ticket TKT-\d+: Cannot upload file/));

    const all = await call("GET", "/api/support/tickets?scope=all", { token: T.super });
    const t = all.data.data.find((x) => x._id === tid);
    assert.equal(t.raisedBy.name, "Dan");
    assert.equal(t.organization, "Company A");

    assert.ok(!(await call("GET", "/api/support/tickets?scope=all", { token: T.adminB })).data.data.some((x) => x._id === tid), "other org can't see it");
    const own = await call("GET", "/api/support/tickets", { token: T.alice });
    assert.ok(!own.data.data.some((x) => x._id === tid), "users only see their own");
    const stats = await call("GET", "/api/support/tickets/stats?scope=all", { token: T.super });
    assert.ok(stats.data.data.open >= 1);
  });

  test("Super Admin replies → In Progress, user emailed and sees the reply", async () => {
    const r = await call("POST", `/api/support/tickets/${tid}/reply`, { token: T.super, json: { message: "Try a file under 10 MB" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.status, "In Progress");
    assert.ok(await waitMail("dan@test.io", /Reply on TKT-\d+/));
    const mine = await call("GET", "/api/support/tickets", { token: T.dan });
    const t = mine.data.data.find((x) => x._id === tid);
    assert.equal(t.responses[0].message, "Try a file under 10 MB");
    assert.equal(t.responses[0].byRole, "SuperAdmin");
  });

  test("status change emails the user; user reply reopens a resolved ticket", async () => {
    const r = await call("PATCH", `/api/support/tickets/${tid}`, { token: T.super, json: { status: "Resolved" } });
    assert.equal(r.status, 200);
    assert.ok(await waitMail("dan@test.io", /is now Resolved/));
    const back = await call("POST", `/api/support/tickets/${tid}/reply`, { token: T.dan, json: { message: "Still failing" } });
    assert.equal(back.data.data.status, "Open");
    assert.equal((await call("POST", `/api/support/tickets/${tid}/reply`, { token: T.alice, json: { message: "x" } })).status, 404, "not my ticket");
    assert.equal((await call("PATCH", `/api/support/tickets/${tid}`, { token: T.alice, json: { status: "Closed" } })).status, 404);
  });
});

describe("Real-time notifications (Socket.IO)", () => {
  test("assigned user receives notification:new instantly; others don't; ticket reaches Super Admin live", async () => {
    const { io: connect } = await import("socket.io-client");
    const open = (token) =>
      new Promise((resolve, reject) => {
        const s = connect(base, { auth: { token }, transports: ["websocket"], forceNew: true });
        s.on("connect", () => resolve(s));
        s.on("connect_error", reject);
      });
    const waitEvent = (sock, event, pred, ms = 3000) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), ms);
        sock.on(event, (p) => {
          if (pred(p)) { clearTimeout(t); resolve(p); }
        });
      });

    const dan = await open(T.dan);
    const bob = await open(T.bob);
    const root = await open(T.super);
    try {
      const gotDan = waitEvent(dan, "notification:new", (n) => n.taskName === "Live task");
      const gotBob = waitEvent(bob, "notification:new", (n) => n.taskName === "Live task", 800);
      await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Live task", assignedUser: ID.dan } });
      const n = await gotDan;
      assert.ok(n, "Dan received it in real time");
      assert.equal(n.type, "task_assigned");
      assert.equal(await gotBob, null, "other organization got nothing");

      const gotRoot = waitEvent(root, "notification:new", (x) => x.type === "support_ticket");
      await call("POST", "/api/support/tickets", { token: T.dan, json: { subject: "Live ticket", message: "help" } });
      const t = await gotRoot;
      assert.ok(t && /Live ticket/.test(t.message), "Super Admin got the ticket live");

      assert.equal(await new Promise((r) => {
        const s = connect(base, { auth: { token: "bad" }, transports: ["websocket"], forceNew: true });
        s.on("connect", () => { s.close(); r("connected"); });
        s.on("connect_error", () => { s.close(); r("refused"); });
      }), "refused", "bad token cannot listen");
    } finally {
      dan.close(); bob.close(); root.close();
    }
  });
});

describe("Companies, per-Admin overview, custom roles", () => {
  test("Admin creation needs a company name; only SuperAdmin creates Admins", async () => {
    const r = await call("POST", "/api/admins", { token: T.super, json: { name: "No Co", email: "noco@test.io", password: "Admin@123" } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /Company name/);
    const admins = await call("GET", "/api/admins", { token: T.super });
    assert.equal(admins.data.data.find((a) => a._id === ID.adminA).companyName, "Company A");
    assert.equal((await call("POST", "/api/users", { token: T.adminA, json: { name: "x", email: "x2@test.io", password: "123456", role: "Admin", companyName: "Y" } })).status, 403);
  });

  test("Super Admin overview of Admin A contains ONLY Admin A's organization", async () => {
    const a = await call("GET", `/api/admins/${ID.adminA}/overview`, { token: T.super });
    assert.equal(a.status, 200);
    const emails = a.data.data.members.map((m) => m.email);
    assert.ok(emails.includes("alice@test.io") && !emails.includes("bob@test.io"));
    const tasksA = await Task.countDocuments({ admin_id: ID.adminA, isTaskBank: { $ne: true } });
    assert.equal(a.data.data.stats.tasks.total, tasksA);
    assert.equal(a.data.data.admin.companyName, "Company A");
    assert.ok(a.data.data.admin.createdAt);
    const b = await call("GET", `/api/admins/${ID.adminB}/overview`, { token: T.super });
    assert.ok(!b.data.data.members.some((m) => m.email === "alice@test.io"));
    assert.equal((await call("GET", `/api/admins/${ID.adminA}/overview`, { token: T.adminA })).status, 403);
  });

  test("custom roles: create, assign to a user, own permissions, isolation, delete guard", async () => {
    const c = await call("POST", "/api/custom-roles", { token: T.adminA, json: { name: "Consultant", baseRole: "User", description: "External" } });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    ID.consultant = c.data.data._id;
    assert.equal((await call("POST", "/api/custom-roles", { token: T.adminA, json: { name: "consultant" } })).status, 409, "case-insensitive duplicate");

    const u = await call("POST", "/api/users", {
      token: T.adminA, json: { name: "Cora", email: "cora@test.io", password: "User@123", department: "Development", customRoleId: ID.consultant },
    });
    assert.equal(u.status, 201, JSON.stringify(u.data));
    ID.cora = u.data.data._id;
    const list = await call("GET", "/api/users", { token: T.adminA });
    assert.equal(list.data.data.find((x) => x.email === "cora@test.io").customRoleName, "Consultant");

    // Admin B cannot use Admin A's role
    assert.equal((await call("POST", "/api/users", { token: T.adminB, json: { name: "Z", email: "z@test.io", password: "User@123", customRoleId: ID.consultant } })).status, 400);
    assert.ok(!(await call("GET", "/api/custom-roles", { token: T.adminB })).data.data.some((r) => r._id === ID.consultant));

    // Own permissions: only task viewing
    const perms = { tasks: ["view"], taskbank: [], users: [], calendar: [], reports: [], communication: [], chat: ["view"], support: [], settings: ["view"] };
    assert.equal((await call("PUT", `/api/permissions/custom-roles/${ID.consultant}`, { token: T.adminA, json: { permissions: perms } })).status, 200);
    T.cora = await activate("cora@test.io", "User@123");
    const me = await call("GET", "/api/auth/me", { token: T.cora });
    assert.deepEqual(me.data.data.permissions.tasks, ["view"]);
    assert.equal((await call("POST", "/api/tasks", { token: T.cora, json: { name: "nope" } })).status, 403);
    const roles = await call("GET", "/api/permissions/roles", { token: T.adminA });
    assert.ok(roles.data.data.roles.some((r) => r.label === "Consultant" && r.users === 1));

    assert.equal((await call("DELETE", `/api/custom-roles/${ID.consultant}`, { token: T.adminA })).status, 409, "in use");
    assert.equal((await call("POST", "/api/custom-roles", { token: T.alice, json: { name: "Hack" } })).status, 403);
  });
});

describe("Imports (Tasks page + Task Bank)", () => {
  test("Task Bank CSV import: preview, duplicates, commit, permission", async () => {
    const csv = "Title,Description,Category,Priority,Tags\nOnboard vendor,Collect docs,Ops,High,a; b\nOnboard vendor,dup,Ops,High,\nNo desc,,Ops,Low,\nBad prio,x,Ops,Urgent,\nCode review,already exists,Dev,Low,\n";
    const pv = await call("POST", "/api/taskbank/import?preview=true", { token: T.adminA, form: csvForm(csv) });
    assert.equal(pv.status, 200, JSON.stringify(pv.data));
    assert.deepEqual(pv.data.summary, { total: 5, valid: 1, invalid: 2, duplicates: 2 });
    const ok = await call("POST", "/api/taskbank/import", { token: T.adminA, form: csvForm(csv) });
    assert.equal(ok.data.imported, 1);
    const items = await call("GET", "/api/taskbank", { token: T.adminA });
    const it = items.data.data.find((x) => x.title === "Onboard vendor");
    assert.deepEqual(it.tags, ["a", "b"]);
    assert.ok(!(await call("GET", "/api/taskbank", { token: T.adminB })).data.data.some((x) => x.title === "Onboard vendor"), "isolated");
    assert.equal((await call("POST", "/api/taskbank/import", { token: T.dan, form: csvForm(csv) })).status, 403);
  });

  test("Tasks page import works with tasks.import (Manager) and is refused without it", async () => {
    const csv = "Title,Date\nManager import,2031-07-01\n";
    assert.equal((await call("POST", "/api/tasks/import?preview=true", { token: T.mia, form: csvForm(csv) })).status, 200);
    assert.equal((await call("POST", "/api/tasks/import?preview=true", { token: T.dan, form: csvForm(csv) })).status, 403);
  });
});

describe("Chat: groups, attachments, permissions", () => {
  test("create group with org members only; members message; outsiders can't read", async () => {
    const g = await call("POST", "/api/chat/groups", { token: T.adminA, json: { name: "Dev Team", memberIds: [ID.alice, ID.dan, ID.bob] } });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    ID.group = g.data.conversation._id;
    const memberEmails = g.data.conversation.participants.map((p) => p.email);
    assert.ok(memberEmails.includes("alice@test.io") && !memberEmails.includes("bob@test.io"), "other org dropped");

    const m = await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, json: { text: "Hello group 👋" } });
    assert.equal(m.status, 201);
    const read = await call("GET", `/api/chat/${ID.group}/messages`, { token: T.dan });
    assert.ok(read.data.messages.some((x) => x.text === "Hello group 👋"), "emoji saved");
    assert.equal((await call("GET", `/api/chat/${ID.group}/messages`, { token: T.bob })).status, 403);
    assert.equal((await call("GET", `/api/chat/${ID.group}/messages`, { token: T.mia })).status, 403, "same org, not a member");
    const convs = await call("GET", "/api/chat/conversations", { token: T.dan });
    assert.ok(convs.data.conversations.some((c) => c._id === ID.group && c.name === "Dev Team"));
  });

  test("group management: admin adds/removes; plain member cannot; leave", async () => {
    const add = await call("PATCH", `/api/chat/groups/${ID.group}`, { token: T.adminA, json: { addMemberIds: [ID.mia], removeMemberIds: [ID.dan] } });
    assert.equal(add.status, 200);
    const ids = add.data.conversation.participants.map((p) => p._id);
    assert.ok(ids.includes(ID.mia) && !ids.includes(ID.dan));
    assert.equal((await call("GET", `/api/chat/${ID.group}/messages`, { token: T.dan })).status, 403, "removed member loses access");
    // Team Members don't have chat.manage_members by default
    assert.equal((await call("PATCH", `/api/chat/groups/${ID.group}`, { token: T.alice, json: { name: "x" } })).status, 403);
    // Team Members can't create groups by default
    assert.equal((await call("POST", "/api/chat/groups", { token: T.alice, json: { name: "x", memberIds: [ID.mia] } })).status, 403);
    assert.equal((await call("POST", `/api/chat/groups/${ID.group}/leave`, { token: T.mia })).status, 200);
  });

  test("attachments: upload, member download, outsider blocked, type/size checks, permission", async () => {
    const f = new FormData();
    f.append("text", "see file");
    f.append("files", new Blob(["%PDF-1.4 hi"], { type: "application/pdf" }), "plan.pdf");
    const m = await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, form: f });
    assert.equal(m.status, 201, JSON.stringify(m.data));
    const file = m.data.message.attachments[0];
    assert.equal(file.name, "plan.pdf");
    const dl = await call("GET", `/api/chat/attachments/${file.filename}`, { token: T.adminA });
    assert.equal(dl.status, 200);
    assert.equal((await call("GET", `/api/chat/attachments/${file.filename}`, { token: T.bob })).status, 404);
    assert.equal((await call("GET", `/api/chat/attachments/${file.filename}`, { token: T.dan })).status, 404, "left the group");

    const bad = new FormData();
    bad.append("files", new Blob(["MZ"]), "x.exe");
    assert.equal((await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, form: bad })).status, 400);

    // revoke chat.upload for Team Members → file messages refused, text still works
    const cfg = await call("GET", "/api/permissions/roles", { token: T.adminA });
    const userPerms = cfg.data.data.roles.find((r) => r.role === "User").permissions;
    await call("PUT", "/api/permissions/roles/User", { token: T.adminA, json: { permissions: { ...userPerms, chat: ["view", "send", "download"] } } });
    const f2 = new FormData();
    f2.append("files", new Blob(["x"], { type: "text/plain" }), "a.txt");
    assert.equal((await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, form: f2 })).status, 403);
    assert.equal((await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, json: { text: "text ok" } })).status, 201);
    await call("PUT", "/api/permissions/roles/User", { token: T.adminA, json: { permissions: userPerms } });

    const { CHAT_UPLOAD_DIR } = await import("../src/controllers/chatGroupController.js");
    fs.rmSync(path.join(CHAT_UPLOAD_DIR, file.filename), { force: true });
  });
});

describe("Individual reports", () => {
  test("per-person counts, filters and isolation", async () => {
    const r = await call("GET", "/api/reports/individual", { token: T.adminA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const people = r.data.data.people;
    assert.ok(people.some((p) => p.email === "alice@test.io") && !people.some((p) => p.email === "bob@test.io"));
    const dan = people.find((p) => p.email === "dan@test.io");
    const danTasks = await Task.find({ assignedTo: ID.dan, isTaskBank: { $ne: true } }).lean();
    assert.equal(dan.assigned, danTasks.length);
    assert.equal(dan.completed, danTasks.filter((t) => t.status === "Completed").length);
    assert.equal(dan.inProgress, danTasks.filter((t) => t.status === "In Progress").length);

    const one = await call("GET", `/api/reports/individual?userId=${ID.dan}`, { token: T.adminA });
    assert.equal(one.data.data.people.length, 1);
    assert.equal(one.data.data.tasks.length, danTasks.length);
    const role = await call("GET", "/api/reports/individual?role=Manager", { token: T.adminA });
    assert.ok(role.data.data.people.every((p) => p.role === "Manager"));
    const cons = await call("GET", `/api/reports/individual?role=custom:${ID.consultant}`, { token: T.adminA });
    assert.deepEqual(cons.data.data.people.map((p) => p.roleLabel), ["Consultant"]);
    assert.equal((await call("GET", `/api/reports/individual?userId=${ID.bob}`, { token: T.adminA })).data.data.people.length, 0, "other org user hidden");
    assert.equal((await call("GET", "/api/reports/individual", { token: T.alice })).status, 403);
  });
});

describe("Individual access (per person)", () => {
  test("Admin sees each member with role and effective permissions; outsiders are hidden", async () => {
    const r = await call("GET", "/api/permissions/users", { token: T.adminA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const cora = r.data.data.users.find((u) => u._id === ID.cora);
    assert.equal(cora.roleLabel, "Consultant");
    assert.equal(cora.hasOverride, false);
    assert.deepEqual(cora.permissions.tasks, ["view"]);
    assert.ok(!r.data.data.users.some((u) => u.email === "bob@test.io" || u.role === "Admin"));
    assert.equal((await call("GET", "/api/permissions/users", { token: T.alice })).status, 403);
  });

  test("override grants and revokes for one person only; reset returns to the role", async () => {
    const before = (await call("GET", "/api/auth/me", { token: T.cora })).data.data.permissions;
    const perms = { ...before, tasks: ["view", "create"], chat: [] };
    const r = await call("PUT", `/api/permissions/users/${ID.cora}`, { token: T.adminA, json: { permissions: perms } });
    assert.equal(r.status, 200, JSON.stringify(r.data));

    const me = (await call("GET", "/api/auth/me", { token: T.cora })).data.data.permissions;
    assert.deepEqual(me.tasks.sort(), ["create", "view"]);
    assert.deepEqual(me.chat, []);
    assert.equal((await call("GET", "/api/chat/conversations", { token: T.cora })).status, 403, "chat revoked");
    const list = (await call("GET", "/api/permissions/users", { token: T.adminA })).data.data.users;
    assert.equal(list.find((u) => u._id === ID.cora).hasOverride, true);
    assert.deepEqual(list.find((u) => u._id === ID.cora).rolePermissions.tasks, ["view"], "role itself unchanged");

    // Other people with the same base role are not affected
    assert.ok((await call("GET", "/api/auth/me", { token: T.dan })).data.data.permissions.chat.includes("view"));

    const reset = await call("PUT", `/api/permissions/users/${ID.cora}`, { token: T.adminA, json: { reset: true } });
    assert.equal(reset.status, 200);
    assert.deepEqual((await call("GET", "/api/auth/me", { token: T.cora })).data.data.permissions.tasks, ["view"]);
  });

  test("cannot exceed the Admin's own access, target other orgs or Admins", async () => {
    const all = (await call("GET", "/api/permissions/admins", { token: T.super })).data.data.find((a) => a._id === ID.adminA).permissions;
    await call("PUT", `/api/permissions/admins/${ID.adminA}`, { token: T.super, json: { permissions: { ...all, reports: [] } } });
    try {
      const over = await call("PUT", `/api/permissions/users/${ID.cora}`, { token: T.adminA, json: { permissions: { ...all, reports: ["view"] } } });
      assert.equal(over.status, 403);
    } finally {
      await call("PUT", `/api/permissions/admins/${ID.adminA}`, { token: T.super, json: { permissions: all } });
    }
    assert.equal((await call("PUT", `/api/permissions/users/${ID.bob}`, { token: T.adminA, json: { permissions: {} } })).status, 404, "other org");
    assert.equal((await call("PUT", `/api/permissions/users/${ID.adminA}`, { token: T.adminA, json: { permissions: {} } })).status, 404, "admins excluded");
    assert.equal((await call("PUT", "/api/permissions/users/nope", { token: T.adminA, json: { reset: true } })).status, 400);
  });
});

describe("Regression — MoM and charts", () => {
  test("meetings list still works for members and admins", async () => {
    assert.equal((await call("GET", "/api/meetings", { token: T.alice })).status, 200);
    assert.equal((await call("GET", "/api/meetings", { token: T.adminA })).status, 200);
  });

  test("report summary (charts) still loads", async () => {
    const r = await call("GET", "/api/reports/summary", { token: T.adminA });
    assert.equal(r.status, 200);
    assert.equal(r.data.success, true);
  });

  test("task stats still load", async () => {
    const r = await call("GET", "/api/tasks/stats", { token: T.adminA });
    assert.equal(r.status, 200);
    assert.ok(r.data.data.total >= 1);
  });
});
