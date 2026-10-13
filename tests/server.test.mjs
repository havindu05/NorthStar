import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = new URL("../", import.meta.url).pathname;
let baseURL;
let origin;
let dataDirectory;
let processHandle;
let serverOutput = "";
let studentCookie;
let secondCookie;
let firstTaskId;

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Server exited during startup:\n${serverOutput}`);
    try {
      const response = await fetch(baseURL);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Server did not start:\n${serverOutput}`);
}

function sameOriginHeaders(cookie) {
  return { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) };
}

async function request(path, { cookie, ...options } = {}) {
  return fetch(`${baseURL}${path}`, {
    ...options,
    headers: { ...sameOriginHeaders(cookie), ...(options.headers || {}) },
  });
}

async function signup(email, name) {
  const response = await request("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "StrongPass123!" }),
  });
  const body = await response.json();
  return { response, body, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

async function createTask(title, cookie = studentCookie) {
  return request("/api/tasks", {
    method: "POST",
    cookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, dueDate: null, priority: "normal" }),
  });
}

before(async () => {
  const port = await getFreePort();
  baseURL = `http://127.0.0.1:${port}`;
  origin = baseURL;
  dataDirectory = await mkdtemp(join(tmpdir(), "northstar-tests-"));
  processHandle = spawn(process.execPath, ["server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: baseURL,
      DATABASE_PATH: join(dataDirectory, "northstar.sqlite"),
      NODE_ENV: "test",
      ADMIN_EMAILS: "founder@example.test",
      BUSINESS_COUNTRY: "LK",
      STRIPE_SECRET_KEY: "sk_test_disabled_for_sri_lanka",
      STRIPE_PRICE_MONTHLY: "price_test_monthly",
      STRIPE_PRICE_YEARLY: "price_test_yearly",
      STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
      PADDLE_ENV: "sandbox",
      PADDLE_MERCHANT_APPROVED: "false",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "pdl_whsec_test_secret",
      PADDLE_PRICE_MONTHLY: "",
      PADDLE_PRICE_YEARLY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processHandle.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
  processHandle.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
  await waitForServer();
});

after(async () => {
  if (processHandle && processHandle.exitCode === null) {
    processHandle.kill("SIGTERM");
    await new Promise((resolve) => processHandle.once("exit", resolve));
  }
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

test("serves the homepage with security headers and protects the dashboard", async () => {
  const health = await request("/healthz");
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");
  const home = await request("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await request("/dashboard")).status, 200);
  assert.equal((await request("/api/dashboard")).status, 401);
  assert.equal((await request("/login")).status, 200);
  assert.equal((await fetch(`${baseURL}/owner`, { redirect: "manual" })).status, 302);
  const manifest = await request("/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  const appManifest = await manifest.json();
  assert.equal(appManifest.start_url, "/dashboard");
  assert.ok(appManifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(appManifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.equal((await request("/sw.js")).status, 200);
  assert.equal((await request("/pwa.js")).status, 200);
  assert.equal((await request("/pwa.css")).status, 200);
  for (const icon of ["/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"]) {
    assert.equal((await request(icon)).status, 200);
  }
});

test("requires a same-origin request for mutations and validates signup on the server", async () => {
  const csrf = await fetch(`${baseURL}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(csrf.status, 403);

  const invalid = await request("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "A", email: "not-an-email", password: "weak" }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(Object.keys((await invalid.json()).fieldErrors).sort(), ["email", "name", "password"]);
});

test("creates an account with a private database file and a usable session", async () => {
  const { response, body, cookie } = await signup("student@example.test", "Sam Student");
  assert.equal(response.status, 201);
  assert.equal(body.user.plan, "free");
  assert.ok(cookie);
  assert.doesNotMatch(response.headers.get("set-cookie"), /Max-Age=/);
  studentCookie = cookie;

  const databasePath = join(dataDirectory, "northstar.sqlite");
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  const session = await request("/api/dashboard", { cookie });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.name, "Sam Student");
});

test("keeps Stripe checkout disabled for the configured Sri Lanka business", async () => {
  const prices = await request("/api/billing/prices", { cookie: studentCookie });
  assert.equal(prices.status, 200);
  assert.equal((await prices.json()).configured, false);

  const checkout = await request("/api/billing/checkout", {
    method: "POST",
    cookie: studentCookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cadence: "monthly" }),
  });
  assert.equal(checkout.status, 503);
  assert.match((await checkout.json()).error, /Paddle seller approval/);
  assert.equal((await request("/api/pricing")).status, 200);
});

test("keeps tasks isolated between student accounts", async () => {
  const ownTask = await createTask("Prepare biology notes");
  assert.equal(ownTask.status, 201);
  firstTaskId = (await ownTask.json()).task.id;

  const second = await signup("another@example.test", "Another Student");
  assert.equal(second.response.status, 201);
  secondCookie = second.cookie;
  const readDashboard = await request("/api/dashboard", { cookie: secondCookie });
  assert.deepEqual((await readDashboard.json()).tasks, []);

  const crossAccountDelete = await request(`/api/tasks/${firstTaskId}`, {
    method: "DELETE",
    cookie: secondCookie,
  });
  assert.equal(crossAccountDelete.status, 404);
});

test("enforces free task and extracurricular limits on the server", async () => {
  for (let index = 1; index < 25; index += 1) {
    const response = await createTask(`Study step ${index}`);
    assert.equal(response.status, 201);
  }
  const blockedTask = await createTask("One task too many");
  assert.equal(blockedTask.status, 403);
  assert.equal((await blockedTask.json()).code, "FREE_TASK_LIMIT");
  const concurrentTaskAttempts = await Promise.all([
    createTask("Concurrent task one"),
    createTask("Concurrent task two"),
    createTask("Concurrent task three"),
  ]);
  assert.deepEqual(concurrentTaskAttempts.map((response) => response.status), [403, 403, 403]);

  const start = Date.now() + 60_000;
  for (let index = 0; index < 5; index += 1) {
    const response = await request("/api/activities", {
      method: "POST",
      cookie: studentCookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Club meetup ${index}`,
        kind: "club",
        startsAt: start + index * 60_000,
        endsAt: start + index * 60_000 + 30 * 60_000,
      }),
    });
    assert.equal(response.status, 201);
  }
  const blockedActivity = await request("/api/activities", {
    method: "POST",
    cookie: studentCookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Another club", kind: "club", startsAt: start, endsAt: start + 60_000 }),
  });
  assert.equal(blockedActivity.status, 403);
  assert.equal((await blockedActivity.json()).code, "FREE_ACTIVITY_LIMIT");
  const concurrentActivityAttempts = await Promise.all([0, 1, 2].map((index) => request("/api/activities", {
    method: "POST",
    cookie: studentCookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `Concurrent club ${index}`, kind: "club", startsAt: start, endsAt: start + 60_000 }),
  })));
  assert.deepEqual(concurrentActivityAttempts.map((response) => response.status), [403, 403, 403]);
});

test("only a correctly signed Stripe webhook grants Plus; event delivery is idempotent", async () => {
  const payload = Buffer.from(JSON.stringify({
    id: "evt_northstar_test",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_northstar_test",
        customer: "cus_northstar_test",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        metadata: { userId: "1" },
      },
    },
  }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "whsec_test_secret").update(`${timestamp}.`).update(payload).digest("hex");
  const invalidSignature = await request("/api/stripe/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${"0".repeat(64)}` },
    body: payload,
  });
  assert.equal(invalidSignature.status, 400);

  const sendEvent = () => request("/api/stripe/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${signature}` },
    body: payload,
  });
  assert.equal((await sendEvent()).status, 200);
  assert.equal((await sendEvent()).status, 200);
  const dashboard = await request("/api/dashboard", { cookie: studentCookie });
  assert.equal((await dashboard.json()).user.plan, "plus");
  assert.equal((await createTask("Unlimited task after webhook")).status, 201);
});

test("verifies Paddle webhooks, grants Plus only from active signed subscriptions, and ignores replay/stale events", async () => {
  const customerId = `ctm_${"c".repeat(26)}`;
  const subscriptionId = `sub_${"s".repeat(26)}`;
  const activeEvent = {
    event_id: "evt_paddle_active_test",
    event_type: "subscription.updated",
    occurred_at: new Date(Date.now() - 1000).toISOString(),
    data: {
      id: subscriptionId,
      customer_id: customerId,
      status: "active",
      current_billing_period: { ends_at: new Date(Date.now() + 30 * 86400_000).toISOString() },
      custom_data: { northstar_user_id: "2" },
    },
  };
  const sendPaddleEvent = async (event, valid = true) => {
    const body = Buffer.from(JSON.stringify(event));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac("sha256", "pdl_whsec_test_secret")
      .update(`${timestamp}:`)
      .update(body)
      .digest("hex");
    return request("/api/paddle/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Paddle-Signature": `ts=${timestamp};h1=${valid ? digest : "0".repeat(64)}`,
      },
      body,
    });
  };

  assert.equal((await sendPaddleEvent(activeEvent, false)).status, 400);
  assert.equal((await sendPaddleEvent(activeEvent)).status, 200);
  assert.equal((await sendPaddleEvent(activeEvent)).status, 200);
  let response = await request("/api/dashboard", { cookie: secondCookie });
  let body = await response.json();
  assert.equal(body.user.plan, "plus");
  assert.equal(body.user.hasPaymentProfile, true);
  assert.equal((await createTask("Paddle Plus task", secondCookie)).status, 201);

  const staleCanceledEvent = {
    ...activeEvent,
    event_id: "evt_paddle_stale_test",
    occurred_at: new Date(Date.now() - 60_000).toISOString(),
    data: { ...activeEvent.data, status: "canceled" },
  };
  assert.equal((await sendPaddleEvent(staleCanceledEvent)).status, 200);
  response = await request("/api/dashboard", { cookie: secondCookie });
  body = await response.json();
  assert.equal(body.user.plan, "plus");

  const canceledEvent = {
    ...activeEvent,
    event_id: "evt_paddle_canceled_test",
    occurred_at: new Date(Date.now() + 1000).toISOString(),
    data: { ...activeEvent.data, status: "canceled" },
  };
  assert.equal((await sendPaddleEvent(canceledEvent)).status, 200);
  response = await request("/api/dashboard", { cookie: secondCookie });
  assert.equal((await response.json()).user.plan, "free");
});

test("supports Plus task growth and paginates active and completed task history", async () => {
  for (let index = 0; index < 26; index += 1) {
    const response = await createTask(`Plus task ${index}`);
    assert.equal(response.status, 201);
  }
  const complete = await request(`/api/tasks/${firstTaskId}`, {
    method: "PATCH",
    cookie: studentCookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  assert.equal(complete.status, 200);

  const firstPage = await request("/api/dashboard?taskFilter=open&taskOffset=0", { cookie: studentCookie });
  const openTasks = await firstPage.json();
  assert.equal(openTasks.tasks.length, 50);
  assert.equal(openTasks.taskHasMore, true);
  assert.equal(openTasks.taskCounts.active, 51);

  const secondPage = await request("/api/dashboard?taskFilter=open&taskOffset=50", { cookie: studentCookie });
  const remainingTasks = await secondPage.json();
  assert.equal(remainingTasks.tasks.length, 1);
  assert.equal(remainingTasks.taskHasMore, false);

  const completed = await request("/api/dashboard?taskFilter=completed&taskOffset=0", { cookie: studentCookie });
  const completedTasks = await completed.json();
  assert.equal(completedTasks.tasks.length, 1);
  assert.equal(completedTasks.tasks[0].completed, true);
});

test("locks the owner dashboard to the configured owner email", async () => {
  assert.equal((await request("/api/owner", { cookie: studentCookie })).status, 403);
  assert.equal((await request("/owner", { cookie: studentCookie })).status, 403);

  const founder = await signup("founder@example.test", "Northstar Founder");
  assert.equal(founder.response.status, 201);
  const founderSession = await request("/api/session", { cookie: founder.cookie });
  assert.equal((await founderSession.json()).user.isAdmin, true);

  const ownerPage = await request("/owner", { cookie: founder.cookie });
  assert.equal(ownerPage.status, 200);
  assert.equal(ownerPage.headers.get("cache-control"), "no-store");
  const ownerData = await request("/api/owner", { cookie: founder.cookie });
  assert.equal(ownerData.status, 200);
  const overview = await ownerData.json();
  assert.equal(overview.admin.name, "Northstar Founder");
  assert.equal(overview.users.total, 3);
  assert.equal(overview.billing.configured, false);
});

test("supports sign-in, persistent-session selection, and sign-out", async () => {
  const login = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "student@example.test", password: "StrongPass123!", remember: true }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /Max-Age=2592000/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const logout = await request("/api/logout", { method: "POST", cookie });
  assert.equal(logout.status, 200);
  assert.equal((await request("/api/dashboard", { cookie })).status, 401);
});
