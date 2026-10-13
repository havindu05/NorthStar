import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { closeDatabase, dbAll, dbGet, dbRun, initializeDatabase, usesPostgres, withTransaction } from "./database.mjs";

const scrypt = promisify(scryptCallback);
const root = dirname(new URL(import.meta.url).pathname);
const port = Number(process.env.PORT || 3000);
const maxRequestBytes = 12_000;
const secureCookie = process.env.NODE_ENV === "production";
const passwordSaltBytes = 16;
const passwordHashBytes = 64;
const freeTaskLimit = 25;
const freeActivityLimit = 5;
const loginThrottle = new Map();
const loginWindow = 15 * 60 * 1000;
const maxLoginAttempts = 10;
const maxSignupAttempts = 5;
const adminEmails = new Set((process.env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
const businessCountry = (process.env.BUSINESS_COUNTRY || "LK").trim().toUpperCase();
const configuredBaseURL = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
let publicBaseURL;
try {
  publicBaseURL = new URL(configuredBaseURL);
  if (!["http:", "https:"].includes(publicBaseURL.protocol) || publicBaseURL.username || publicBaseURL.password ||
      publicBaseURL.search || publicBaseURL.hash || (secureCookie && publicBaseURL.protocol !== "https:")) {
    throw new Error();
  }
  publicBaseURL = publicBaseURL.origin;
} catch {
  throw new Error("PUBLIC_BASE_URL must be an absolute public URL (use HTTPS in production).");
}

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
process.umask(0o077);
await initializeDatabase();

const dummySalt = Buffer.from("8d06f7461c4fce86b25893f6d1593e29", "hex");
const dummyHash = await scrypt("not-a-real-password", dummySalt, passwordHashBytes);
const stripePriceCache = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const staticFiles = new Map([
  ["/", "home.html"],
  ["/index.html", "home.html"],
  ["/login", "index.html"],
  ["/signup", "index.html"],
  ["/dashboard", "dashboard.html"],
  ["/owner", "owner.html"],
  ["/admin", "owner.html"],
  ["/home.css", "home.css"],
  ["/home.js", "home.js"],
  ["/dashboard.css", "dashboard.css"],
  ["/dashboard.js", "dashboard.js"],
  ["/owner.css", "owner.css"],
  ["/owner.js", "owner.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/icon.svg", "icon.svg"],
  ["/offline.html", "offline.html"],
  ["/sw.js", "sw.js"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/pwa.css", "pwa.css"],
  ["/pwa.js", "pwa.js"],
  ["/icon-192.png", "icon-192.png"],
  ["/icon-512.png", "icon-512.png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png"],
]);

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    ...(secureCookie ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit = maxRequestBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }
  try {
    const parsed = JSON.parse((await readBody(request)).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    const invalid = new Error("Please send a valid JSON request.");
    invalid.status = 400;
    throw invalid;
  }
}

function validateCredentials(input, isSignup) {
  const fieldErrors = {};
  const email = input.email;
  const password = input.password;
  const name = input.name;

  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,63}$/.test(email.trim())) {
    fieldErrors.email = "Enter a valid email address.";
  }
  if (typeof password !== "string" || Buffer.byteLength(password, "utf8") > 128) {
    fieldErrors.password = "Password must be no more than 128 bytes.";
  } else if (isSignup) {
    if (password.length < 10) fieldErrors.password = "Use at least 10 characters.";
    else if (!/[A-Z]/.test(password)) fieldErrors.password = "Add at least one uppercase letter.";
    else if (!/[a-z]/.test(password)) fieldErrors.password = "Add at least one lowercase letter.";
    else if (!/\d/.test(password)) fieldErrors.password = "Add at least one number.";
    else if (!/[^A-Za-z0-9]/.test(password)) fieldErrors.password = "Add at least one special character.";
  } else if (!password) {
    fieldErrors.password = "Enter your password.";
  }
  if (isSignup && (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(name))) {
    fieldErrors.name = "Name must be between 2 and 60 characters.";
  }
  return fieldErrors;
}

function validateMutationOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) {
    const error = new Error("A same-origin request is required.");
    error.status = 403;
    throw error;
  }
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    const error = new Error("Invalid request origin.");
    error.status = 403;
    throw error;
  }
  const expectedProtocol = secureCookie ? "https:" : "http:";
  if (originUrl.host !== host || originUrl.protocol !== expectedProtocol) {
    const error = new Error("Cross-origin requests are not allowed.");
    error.status = 403;
    throw error;
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function cookieHeader(token, maxAge) {
  const parts = [`northstar_session=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${maxAge}`);
  if (secureCookie) parts.push("Secure");
  return parts.join("; ");
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || "";
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return "";
}

async function getUserFromSession(request) {
  const token = getCookie(request, "northstar_session");
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const now = Date.now();
  await dbRun("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  return await dbGet(`
    SELECT id, name, email, plan, subscription_status, subscription_period_end, stripe_customer_id, paddle_customer_id
    FROM users
    WHERE id = (SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?)
  `, [hashToken(token), now]) || null;
}

async function requireUser(request, response) {
  const user = await getUserFromSession(request);
  if (!user) {
    json(response, 401, { error: "Please sign in to continue." });
    return null;
  }
  return user;
}

function isAdmin(user) {
  return Boolean(user && adminEmails.has(user.email.toLowerCase()));
}

async function requireAdmin(request, response) {
  const user = await getUserFromSession(request);
  if (!user) {
    json(response, 401, { error: "Please sign in to continue." });
    return null;
  }
  if (!isAdmin(user)) {
    json(response, 403, { error: "This area is only available to the site owner." });
    return null;
  }
  return user;
}

async function createSession(userId, response, remember = false) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const lifetime = remember ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  await dbRun("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [
    hashToken(token),
    userId,
    now + lifetime,
    now,
  ]);
  response.setHeader("Set-Cookie", cookieHeader(token, remember ? lifetime / 1000 : undefined));
}

function isThrottled(request, response, action, limit) {
  const now = Date.now();
  const address = request.socket.remoteAddress || "unknown";
  const key = `${action}:${address}`;
  let record = loginThrottle.get(key);
  if (!record || now - record.startedAt >= loginWindow) {
    record = { startedAt: now, count: 0 };
    loginThrottle.set(key, record);
  }
  record.count += 1;
  if (loginThrottle.size > 10_000) {
    for (const [entry, value] of loginThrottle) {
      if (now - value.startedAt >= loginWindow) loginThrottle.delete(entry);
    }
  }
  if (record.count <= limit) return false;
  const retryAfter = Math.ceil((record.startedAt + loginWindow - now) / 1000);
  json(response, 429, { error: "Too many attempts. Please wait a little before trying again." }, { "Retry-After": String(retryAfter) });
  return true;
}

async function signup(request, response) {
  if (isThrottled(request, response, "signup", maxSignupAttempts)) return;
  const input = await readJson(request);
  const fieldErrors = validateCredentials(input, true);
  if (Object.keys(fieldErrors).length) {
    json(response, 400, { error: "Please check the highlighted fields.", fieldErrors });
    return;
  }
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim().normalize("NFC");
  const salt = randomBytes(passwordSaltBytes);
  const passwordHash = await scrypt(input.password, salt, passwordHashBytes);
  try {
    const result = await dbRun("INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id", [
      name,
      email,
      `scrypt$${salt.toString("hex")}$${passwordHash.toString("hex")}`,
      Date.now(),
    ]);
    await createSession(Number(result.lastInsertRowid), response);
    json(response, 201, { message: "Your account is ready. Welcome to Northstar!", user: { name, email, plan: "free" } });
  } catch (error) {
    if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") {
      json(response, 409, { error: "An account with that email already exists.", fieldErrors: { email: "This email is already registered." } });
      return;
    }
    throw error;
  }
}

async function login(request, response) {
  if (isThrottled(request, response, "login", maxLoginAttempts)) return;
  const input = await readJson(request);
  const fieldErrors = validateCredentials(input, false);
  if (Object.keys(fieldErrors).length) {
    json(response, 400, { error: "Please check the highlighted fields.", fieldErrors });
    return;
  }
  const email = input.email.trim().toLowerCase();
  const user = await dbGet("SELECT id, name, email, password_hash, plan FROM users WHERE lower(email) = lower(?)", [email]);
  const [scheme, saltHex, hashHex] = user?.password_hash.split("$") || [];
  const salt = scheme === "scrypt" && /^[a-f0-9]{32}$/.test(saltHex) ? Buffer.from(saltHex, "hex") : dummySalt;
  const expected = scheme === "scrypt" && /^[a-f0-9]{128}$/.test(hashHex) ? Buffer.from(hashHex, "hex") : dummyHash;
  const actual = await scrypt(input.password, salt, passwordHashBytes);
  if (!user || !timingSafeEqual(actual, expected)) {
    json(response, 401, { error: "We couldn’t sign you in with those details. Check your email and password and try again." });
    return;
  }
  await createSession(user.id, response, input.remember === true);
  json(response, 200, { message: "You’re signed in. Welcome back!", user: { name: user.name, email: user.email, plan: user.plan } });
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateTask(input) {
  const errors = {};
  if (typeof input.title !== "string" || input.title.trim().length < 2 || input.title.trim().length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.title)) {
    errors.title = "Task title must be between 2 and 120 characters.";
  }
  if (input.dueDate !== null && input.dueDate !== undefined && input.dueDate !== "" && !validDate(input.dueDate)) {
    errors.dueDate = "Choose a valid due date.";
  }
  if (input.priority !== undefined && !["low", "normal", "high"].includes(input.priority)) {
    errors.priority = "Choose a valid priority.";
  }
  return errors;
}

function validateActivity(input) {
  const errors = {};
  if (typeof input.title !== "string" || input.title.trim().length < 2 || input.title.trim().length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.title)) {
    errors.title = "Activity title must be between 2 and 120 characters.";
  }
  if (!["class", "club", "sport", "study", "break", "other"].includes(input.kind)) errors.kind = "Choose a valid activity type.";
  if (!Number.isSafeInteger(input.startsAt) || !Number.isSafeInteger(input.endsAt) ||
      input.startsAt < Date.now() - 365 * 24 * 60 * 60 * 1000 ||
      input.endsAt <= input.startsAt || input.endsAt - input.startsAt > 12 * 60 * 60 * 1000 ||
      input.endsAt > Date.now() + 5 * 365 * 24 * 60 * 60 * 1000) {
    errors.startsAt = "Choose a valid time and duration (up to 12 hours).";
  }
  return errors;
}

function apiTask(row) {
  return {
    id: row.id,
    title: row.title,
    dueDate: row.due_date,
    priority: row.priority,
    completed: row.completed_at !== null,
    createdAt: Number(row.created_at),
  };
}

function apiActivity(row) {
  return { id: row.id, title: row.title, kind: row.kind, startsAt: Number(row.starts_at), endsAt: Number(row.ends_at) };
}

async function studentData(user, taskFilter, taskOffset) {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const start = startOfToday.getTime();
  const end = start + 7 * 24 * 60 * 60 * 1000;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime();
  const localDate = `${startOfToday.getFullYear()}-${String(startOfToday.getMonth() + 1).padStart(2, "0")}-${String(startOfToday.getDate()).padStart(2, "0")}`;
  const taskState = taskFilter === "completed" ? "completed_at IS NOT NULL" : "completed_at IS NULL";
  const taskOrder = taskFilter === "completed" ? "completed_at DESC" : "due_date IS NULL, due_date, created_at DESC";
  const tasks = await dbAll(`SELECT * FROM tasks WHERE user_id = ? AND ${taskState} ORDER BY ${taskOrder} LIMIT 51 OFFSET ?`, [user.id, taskOffset]);
  const activities = await dbAll("SELECT * FROM activities WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at LIMIT 100", [user.id, start, end]);
  const activeCount = Number((await dbGet("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND completed_at IS NULL", [user.id])).count);
  const completedCount = Number((await dbGet("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND completed_at IS NOT NULL", [user.id])).count);
  const activitiesThisMonth = Number((await dbGet(`
    SELECT COUNT(*) AS count FROM activities
    WHERE user_id = ? AND kind IN ('club', 'sport', 'other') AND starts_at >= ? AND starts_at < ?
  `, [user.id, monthStart, monthEnd])).count);
  return {
    user: { id: user.id, name: user.name, email: user.email, plan: user.plan, subscriptionStatus: user.subscription_status, periodEnd: user.subscription_period_end === null ? null : Number(user.subscription_period_end), hasPaymentProfile: Boolean(user.stripe_customer_id || user.paddle_customer_id), isAdmin: isAdmin(user) },
    tasks: tasks.slice(0, 50).map(apiTask),
    taskCounts: { active: activeCount, completed: completedCount },
    taskHasMore: tasks.length > 50,
    activities: activities.map(apiActivity),
    usage: { activeTasks: activeCount, taskLimit: user.plan === "plus" ? null : freeTaskLimit, monthlyActivities: activitiesThisMonth, activityLimit: user.plan === "plus" ? null : freeActivityLimit },
    summary: {
      completedThisWeek: Number((await dbGet("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND completed_at >= ?", [user.id, start])).count),
      dueToday: Number((await dbGet("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND completed_at IS NULL AND due_date = ?", [user.id, localDate])).count),
      upcomingThisWeek: activities.filter((activity) => Number(activity.starts_at) >= now).length,
    },
  };
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function stripeConfigured() {
  return stripeMerchantEligible() && Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_MONTHLY && process.env.STRIPE_PRICE_YEARLY && process.env.STRIPE_WEBHOOK_SECRET);
}

function stripeMerchantEligible() {
  return businessCountry !== "LK";
}

function paddleEnvironment() {
  return process.env.PADDLE_ENV === "production" ? "production" : "sandbox";
}

function paddleApiBase() {
  return paddleEnvironment() === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
}

function paddleConfigured() {
  return Boolean(
    process.env.PADDLE_API_KEY &&
    process.env.PADDLE_WEBHOOK_SECRET &&
    process.env.PADDLE_PRICE_MONTHLY &&
    process.env.PADDLE_PRICE_YEARLY,
  );
}

function paddleLiveApproved() {
  return process.env.PADDLE_MERCHANT_APPROVED === "true";
}

function paddleReadyForBilling() {
  return paddleConfigured() && (paddleEnvironment() === "sandbox" || paddleLiveApproved());
}

async function paddleRequest(path, body, idempotencyKey) {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey || !/^pdl_(sdbx|live)_/.test(apiKey)) {
    const error = new Error("Paddle isn’t configured yet. Add your Paddle sandbox API key and price IDs on the server.");
    error.status = 503;
    throw error;
  }
  const liveKey = apiKey.startsWith("pdl_live_");
  if ((paddleEnvironment() === "production") !== liveKey || (liveKey && !paddleLiveApproved())) {
    const error = new Error("Paddle live payments are disabled until your seller account is approved and the production environment is verified.");
    error.status = 503;
    throw error;
  }
  const result = await fetch(`${paddleApiBase()}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12_000),
  });
  let response;
  try {
    response = await result.json();
  } catch {
    throw new Error("Paddle returned an invalid response.");
  }
  if (!result.ok) {
    console.error("Paddle API error:", response.error?.code || result.status);
    const error = new Error("Paddle couldn’t complete this request. Please try again or contact support.");
    error.status = result.status === 429 ? 429 : 502;
    throw error;
  }
  return response.data;
}

async function getPaddlePrice(priceId, expectedInterval) {
  if (!/^pri_[a-z0-9]{26}$/.test(priceId || "")) {
    const error = new Error("Configure an active Paddle recurring price ID before enabling subscriptions.");
    error.status = 503;
    throw error;
  }
  const price = await paddleRequest(`/prices/${encodeURIComponent(priceId)}`);
  if (
    price.status !== "active" ||
    !price.billing_cycle ||
    !/^\d+$/.test(price.unit_price?.amount || "") ||
    !/^[A-Z]{3}$/.test(price.unit_price?.currency_code || "") ||
    price.billing_cycle.interval !== expectedInterval ||
    price.billing_cycle.frequency !== 1
  ) {
    const error = new Error(`Configure an active Paddle price with a ${expectedInterval} billing interval.`);
    error.status = 503;
    throw error;
  }
  return {
    amount: Number(price.unit_price.amount),
    currency: price.unit_price.currency_code.toLowerCase(),
    interval: expectedInterval,
  };
}

async function paddleBillingPrices(response, user) {
  if (!paddleReadyForBilling()) {
    json(response, 200, {
      configured: false,
      provider: "paddle",
      environment: paddleEnvironment(),
      prices: null,
      hasPaymentProfile: Boolean(user.paddle_customer_id),
    });
    return;
  }
  const [monthly, yearly] = await Promise.all([
    getPaddlePrice(process.env.PADDLE_PRICE_MONTHLY, "month"),
    getPaddlePrice(process.env.PADDLE_PRICE_YEARLY, "year"),
  ]);
  json(response, 200, {
    configured: true,
    provider: "paddle",
    environment: paddleEnvironment(),
    prices: { monthly, yearly },
    hasPaymentProfile: Boolean(user.paddle_customer_id),
  });
}

async function createPaddleCheckout(user, cadence, response) {
  if (!paddleConfigured()) {
    json(response, 503, {
      error: "Northstar Plus checkout isn’t set up yet. Paddle seller approval and a Sri Lanka payout route must be confirmed first. Your free plan still works.",
      code: "PAYMENTS_NOT_CONFIGURED",
    });
    return;
  }
  if (paddleEnvironment() === "production" && !paddleLiveApproved()) {
    json(response, 503, {
      error: "Live checkout is paused until Paddle confirms your seller account and payout route. Keep using the free plan meanwhile.",
      code: "MERCHANT_NOT_APPROVED",
    });
    return;
  }
  if (user.plan === "plus" && ["active", "trialing"].includes(user.subscription_status)) {
    json(response, 409, { error: "Your Northstar Plus subscription is already active." });
    return;
  }
  const priceId = cadence === "monthly" ? process.env.PADDLE_PRICE_MONTHLY : process.env.PADDLE_PRICE_YEARLY;
  await getPaddlePrice(priceId, cadence === "monthly" ? "month" : "year");
  const data = await paddleRequest("/transactions", {
    items: [{ price_id: priceId, quantity: 1 }],
    customer_email: user.email,
    custom_data: { northstar_user_id: String(user.id) },
    collection_mode: "automatic",
    checkout: { url: `${publicBaseURL}/dashboard?billing=success` },
  }, randomBytes(24).toString("hex"));
  const checkoutURL = data?.checkout?.url;
  let parsedURL;
  try {
    parsedURL = new URL(checkoutURL);
  } catch {
    throw new Error("Paddle did not return a valid checkout URL.");
  }
  if (parsedURL.protocol !== "https:" || !(parsedURL.hostname === "paddle.com" || parsedURL.hostname.endsWith(".paddle.com"))) {
    throw new Error("Paddle returned an unexpected checkout URL.");
  }
  json(response, 200, { url: parsedURL.toString() });
}

async function createPaddlePortal(user, response) {
  if (!user.paddle_customer_id) {
    json(response, 409, { error: "There is no Paddle customer profile to manage yet." });
    return;
  }
  const data = await paddleRequest(`/customers/${encodeURIComponent(user.paddle_customer_id)}/portal-sessions`, {});
  const portalURL = data?.urls?.general?.overview;
  let parsedURL;
  try {
    parsedURL = new URL(portalURL);
  } catch {
    throw new Error("Paddle did not return a valid customer portal URL.");
  }
  if (parsedURL.protocol !== "https:" || !(parsedURL.hostname === "paddle.com" || parsedURL.hostname.endsWith(".paddle.com"))) {
    throw new Error("Paddle returned an unexpected customer portal URL.");
  }
  json(response, 200, { url: parsedURL.toString() });
}

async function stripeRequest(path, parameters, method = "POST") {
  if (!stripeMerchantEligible()) {
    const error = new Error("Stripe direct payments are disabled for a Sri Lanka-based business. Confirm a payout-eligible provider before accepting payments.");
    error.status = 503;
    throw error;
  }
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || !/^sk_(test|live)_/.test(secret)) {
    const error = new Error("Payments are not configured yet. Add your Stripe settings to the server environment.");
    error.status = 503;
    throw error;
  }
  if (secret.startsWith("sk_live_") && process.env.NODE_ENV !== "production") {
    const error = new Error("Live Stripe keys are disabled outside production. Use Stripe test mode while developing.");
    error.status = 503;
    throw error;
  }
  const options = {
    method,
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(12_000),
  };
  if (parameters) {
    options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(parameters);
  }
  const result = await fetch(`https://api.stripe.com/v1${path}`, options);
  const body = await result.json();
  if (!result.ok) {
    console.error("Stripe API error:", body.error?.type || result.status);
    const error = new Error("The payment provider could not complete this request. Please try again.");
    error.status = result.status === 429 ? 429 : 502;
    throw error;
  }
  return body;
}

async function getStripePrice(priceId, expectedInterval) {
  const cached = stripePriceCache.get(priceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const price = await stripeRequest(`/prices/${encodeURIComponent(priceId)}`, null, "GET");
  if (!price.active || !price.recurring || !Number.isSafeInteger(price.unit_amount) || typeof price.currency !== "string" ||
      price.recurring.interval !== expectedInterval || price.recurring.interval_count !== 1) {
    throw new Error(`Configure an active recurring Stripe price with a ${expectedInterval} billing interval.`);
  }
  const value = { amount: price.unit_amount, currency: price.currency, interval: price.recurring.interval, intervalCount: price.recurring.interval_count };
  stripePriceCache.set(priceId, { value, expiresAt: Date.now() + 10 * 60 * 1000 });
  return value;
}

async function billingPrices(user, response) {
  if (!stripeMerchantEligible() || !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_MONTHLY || !process.env.STRIPE_PRICE_YEARLY) {
    json(response, 200, { configured: false, prices: null, hasPaymentProfile: Boolean(user.stripe_customer_id) });
    return;
  }
  const [monthly, yearly] = await Promise.all([
    getStripePrice(process.env.STRIPE_PRICE_MONTHLY, "month"),
    getStripePrice(process.env.STRIPE_PRICE_YEARLY, "year"),
  ]);
  json(response, 200, { configured: stripeConfigured(), prices: { monthly, yearly }, hasPaymentProfile: Boolean(user.stripe_customer_id) });
}

async function listStripeRecurringRevenue() {
  const northstarPrices = new Set([process.env.STRIPE_PRICE_MONTHLY, process.env.STRIPE_PRICE_YEARLY].filter(Boolean));
  if (!stripeMerchantEligible() || !process.env.STRIPE_SECRET_KEY || !northstarPrices.size) return { configured: false, activeSubscriptions: 0, monthlyRecurring: [] };
  const totals = new Map();
  let activeSubscriptions = 0;
  let startingAfter;
  let truncated = false;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ status: "active", limit: "100", "expand[]": "data.items.data.price" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const result = await stripeRequest(`/subscriptions?${params.toString()}`, null, "GET");
    for (const subscription of result.data || []) {
      let hasNorthstarPrice = false;
      for (const item of subscription.items?.data || []) {
        const price = item.price;
        if (!price || !northstarPrices.has(price.id) || !Number.isSafeInteger(price.unit_amount) || !price.currency || !price.recurring) continue;
        hasNorthstarPrice = true;
        const interval = price.recurring.interval;
        const count = Number(price.recurring.interval_count) || 1;
        const monthly = interval === "month" ? price.unit_amount / count : interval === "year" ? price.unit_amount / (12 * count) : null;
        if (monthly === null) continue;
        const key = price.currency.toLowerCase();
        totals.set(key, (totals.get(key) || 0) + monthly * (item.quantity || 1));
      }
      if (hasNorthstarPrice) activeSubscriptions += 1;
    }
    if (!result.has_more || !result.data?.length) break;
    startingAfter = result.data.at(-1).id;
    if (page === 19) truncated = true;
  }
  return {
    configured: true,
    activeSubscriptions,
    truncated,
    monthlyRecurring: [...totals].map(([currency, amount]) => ({ currency, amountMinor: Math.round(amount) })),
  };
}

async function ownerDashboard(admin, response) {
  const userCounts = await dbGet(`
    SELECT CAST(COUNT(*) AS INTEGER) AS total,
      CAST(SUM(CASE WHEN plan = 'free' THEN 1 ELSE 0 END) AS INTEGER) AS free,
      CAST(SUM(CASE WHEN plan = 'plus' THEN 1 ELSE 0 END) AS INTEGER) AS plus,
      CAST(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS INTEGER) AS "newThisMonth"
    FROM users
  `, [new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()]);
  const contentCounts = await dbGet(`
    SELECT
      (SELECT CAST(COUNT(*) AS INTEGER) FROM tasks) AS tasks,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM activities) AS activities,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM sessions WHERE expires_at > ?) AS "liveSessions"
  `, [Date.now()]);
  const recentUsers = await dbAll(`
    SELECT id, name, email, plan, subscription_status, created_at
    FROM users ORDER BY created_at DESC LIMIT 10
  `);
  const stripe = businessCountry === "LK"
    ? {
      configured: paddleReadyForBilling(),
      provider: "paddle",
      activeSubscriptions: userCounts.plus || 0,
      monthlyRecurring: [],
      note: "Check Paddle for sales, fees, refunds, and payouts.",
    }
    : { ...await listStripeRecurringRevenue(), provider: "stripe" };
  json(response, 200, {
    admin: { name: admin.name, email: admin.email },
    users: {
      total: Number(userCounts.total || 0),
      free: Number(userCounts.free || 0),
      plus: Number(userCounts.plus || 0),
      newThisMonth: Number(userCounts.newThisMonth || 0),
    },
    product: { tasks: Number(contentCounts.tasks), activities: Number(contentCounts.activities), liveSessions: Number(contentCounts.liveSessions) },
    billing: stripe,
    recentUsers: recentUsers.map((user) => ({ ...user, created_at: Number(user.created_at) })),
    generatedAt: Date.now(),
  });
}

async function createCheckout(user, request, response, input) {
  const cadence = input.cadence;
  if (cadence !== "monthly" && cadence !== "yearly") {
    json(response, 400, { error: "Choose monthly or yearly billing." });
    return;
  }
  if (!stripeMerchantEligible()) {
    json(response, 503, { error: "This business country cannot use direct Stripe checkout. Configure an approved local provider instead." });
    return;
  }
  if (!stripeConfigured()) {
    json(response, 503, { error: "Subscriptions are not configured yet. Add Stripe test keys and price IDs to the server environment." });
    return;
  }
  if (user.plan === "plus" && ["active", "trialing"].includes(user.subscription_status)) {
    json(response, 409, { error: "Your Plus subscription is already active." });
    return;
  }
  const priceId = cadence === "monthly" ? process.env.STRIPE_PRICE_MONTHLY : process.env.STRIPE_PRICE_YEARLY;
  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "subscription_data[metadata][userId]": String(user.id),
    client_reference_id: String(user.id),
    success_url: `${publicBaseURL}/dashboard?billing=success`,
    cancel_url: `${publicBaseURL}/dashboard?billing=cancelled`,
    "metadata[userId]": String(user.id),
  });
  if (user.stripe_customer_id) params.set("customer", user.stripe_customer_id);
  else params.set("customer_email", user.email);
  const session = await stripeRequest("/checkout/sessions", params);
  if (!session.url || new URL(session.url).protocol !== "https:" || new URL(session.url).hostname !== "checkout.stripe.com") {
    throw new Error("Stripe returned an invalid checkout URL.");
  }
  json(response, 200, { url: session.url });
}

async function createPortal(user, response) {
  if (!user.stripe_customer_id) {
    json(response, 409, { error: "There is no payment method to manage yet." });
    return;
  }
  const params = new URLSearchParams({
    customer: user.stripe_customer_id,
    return_url: `${publicBaseURL}/dashboard`,
  });
  const session = await stripeRequest("/billing_portal/sessions", params);
  if (!session.url || new URL(session.url).protocol !== "https:" || new URL(session.url).hostname !== "billing.stripe.com") {
    throw new Error("Stripe returned an invalid billing portal URL.");
  }
  json(response, 200, { url: session.url });
}

function verifyStripeSignature(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const parts = signatureHeader.split(",").map((part) => part.split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    return timingSafeEqual(expected, Buffer.from(signature, "hex"));
  });
}

function verifyPaddleSignature(rawBody, signatureHeader) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  let timestamp;
  const signatures = [];
  for (const part of signatureHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "ts") timestamp = value;
    if (key === "h1" && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0 ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(timestamp).update(":").update(rawBody).digest();
  return signatures.some((signature) => timingSafeEqual(expected, Buffer.from(signature, "hex")));
}

function paddleUserId(customData) {
  const userId = Number(customData?.northstar_user_id);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

async function handlePaddleEvent(event, client) {
  const data = event.data;
  const occurredAt = Date.parse(event.occurred_at);
  if (event.event_type === "transaction.completed") {
    const userId = paddleUserId(data.custom_data);
    if (!userId || !/^ctm_[a-z\d]{26}$/.test(data.customer_id || "")) return;
    await dbRun(`
      UPDATE users
      SET paddle_customer_id = ?,
          paddle_subscription_id = COALESCE(?, paddle_subscription_id)
      WHERE id = ?
    `, [
      data.customer_id,
      /^sub_[a-z\d]{26}$/.test(data.subscription_id || "") ? data.subscription_id : null,
      userId,
    ], client);
    return;
  }

  if (!event.event_type.startsWith("subscription.")) return;
  const userId = paddleUserId(data.custom_data);
  const customerId = /^ctm_[a-z\d]{26}$/.test(data.customer_id || "") ? data.customer_id : null;
  const existing = customerId
    ? await dbGet("SELECT id FROM users WHERE paddle_customer_id = ?", [customerId], client)
    : null;
  const ownerId = existing?.id || userId;
  if (!ownerId) return;

  const status = typeof data.status === "string" ? data.status : "canceled";
  const grantsAccess = status === "active" || status === "trialing";
  const subscriptionId = /^sub_[a-z\d]{26}$/.test(data.id || "") ? data.id : null;
  const periodEnd = data.current_billing_period?.ends_at ? Date.parse(data.current_billing_period.ends_at) : null;
  await dbRun(`
    UPDATE users
    SET paddle_customer_id = COALESCE(?, paddle_customer_id),
        paddle_subscription_id = ?,
        subscription_status = ?,
        subscription_period_end = ?,
        plan = ?,
        paddle_subscription_updated_at = ?
    WHERE id = ? AND COALESCE(paddle_subscription_updated_at, 0) <= ?
  `, [
    customerId,
    status === "canceled" ? null : subscriptionId,
    status,
    Number.isFinite(periodEnd) ? periodEnd : null,
    grantsAccess ? "plus" : "free",
    occurredAt,
    ownerId,
    occurredAt,
  ], client);
}

async function paddleWebhook(request, response) {
  const rawBody = await readBody(request, 256_000);
  if (!verifyPaddleSignature(rawBody, request.headers["paddle-signature"])) {
    json(response, 400, { error: "Invalid Paddle webhook signature." });
    return;
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    json(response, 400, { error: "Invalid Paddle webhook payload." });
    return;
  }
  if (
    typeof event.event_id !== "string" ||
    typeof event.event_type !== "string" ||
    !event.data ||
    typeof event.data !== "object" ||
    !Number.isFinite(Date.parse(event.occurred_at))
  ) {
    json(response, 400, { error: "Invalid Paddle webhook event." });
    return;
  }
  await withTransaction(async (client) => {
    const inserted = await dbRun("INSERT INTO paddle_events (event_id, processed_at) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING", [
      event.event_id, Date.now(),
    ], client);
    if (!inserted.changes) return;
    await handlePaddleEvent(event, client);
  });
  json(response, 200, { received: true });
}

async function handleStripeEvent(event, client) {
  const object = event.data.object;
  const eventType = event.type;
  let customerId = typeof object.customer === "string" ? object.customer : object.customer?.id;
  if (eventType === "checkout.session.completed") {
    const userId = Number(object.client_reference_id || object.metadata?.userId);
    if (!Number.isSafeInteger(userId) || userId < 1 || !customerId) return;
    await dbRun("UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ? WHERE id = ?", [
      customerId,
      typeof object.subscription === "string" ? object.subscription : null,
      "incomplete",
      userId,
    ], client);
    return;
  }
  if (eventType.startsWith("customer.subscription.")) {
    const metadataUserId = Number(object.metadata?.userId);
    const existing = customerId
      ? await dbGet("SELECT id FROM users WHERE stripe_customer_id = ?", [customerId], client)
      : null;
    const userId = existing?.id || (Number.isSafeInteger(metadataUserId) ? metadataUserId : null);
    if (!userId) return;
    const status = eventType === "customer.subscription.deleted" ? "canceled" : String(object.status || "inactive");
    const hasAccess = status === "active" || status === "trialing";
    await dbRun(`
      UPDATE users
      SET stripe_customer_id = COALESCE(?, stripe_customer_id),
          stripe_subscription_id = ?,
          subscription_status = ?,
          subscription_period_end = ?,
          plan = ?
      WHERE id = ?
    `, [
      customerId || null,
      eventType === "customer.subscription.deleted" ? null : object.id,
      status,
      Number.isSafeInteger(object.current_period_end) ? object.current_period_end * 1000 : null,
      hasAccess ? "plus" : "free",
      userId,
    ], client);
    return;
  }
  if (eventType === "invoice.payment_failed" && customerId) {
    await dbRun("UPDATE users SET subscription_status = 'past_due', plan = 'free' WHERE stripe_customer_id = ?", [customerId], client);
  }
}

async function stripeWebhook(request, response) {
  const rawBody = await readBody(request, 256_000);
  if (!verifyStripeSignature(rawBody, request.headers["stripe-signature"])) {
    json(response, 400, { error: "Invalid Stripe webhook signature." });
    return;
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    json(response, 400, { error: "Invalid webhook payload." });
    return;
  }
  if (typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) {
    json(response, 400, { error: "Invalid webhook event." });
    return;
  }
  await withTransaction(async (client) => {
    const inserted = await dbRun("INSERT INTO stripe_events (event_id, processed_at) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING", [
      event.id, Date.now(),
    ], client);
    if (!inserted.changes) return;
    await handleStripeEvent(event, client);
  });
  json(response, 200, { received: true });
}

async function handleApi(request, response, pathname) {
  if (request.method === "POST" && pathname === "/api/paddle/webhook") {
    await paddleWebhook(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/stripe/webhook") {
    await stripeWebhook(request, response);
    return;
  }
  if (request.method === "POST") validateMutationOrigin(request);
  if (request.method === "POST" && pathname === "/api/signup") {
    await signup(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/login") {
    await login(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/session") {
    const user = await getUserFromSession(request);
    json(response, 200, { user: user ? { name: user.name, email: user.email, plan: user.plan, isAdmin: isAdmin(user) } : null });
    return;
  }
  if (request.method === "GET" && pathname === "/api/pricing") {
    if (businessCountry === "LK" && paddleReadyForBilling()) {
      const [monthly, yearly] = await Promise.all([
        getPaddlePrice(process.env.PADDLE_PRICE_MONTHLY, "month"),
        getPaddlePrice(process.env.PADDLE_PRICE_YEARLY, "year"),
      ]);
      json(response, 200, { configured: true, provider: "paddle", prices: { monthly, yearly } });
    } else {
      json(response, 200, { configured: false, provider: businessCountry === "LK" ? "paddle" : "stripe" });
    }
    return;
  }
  if (request.method === "POST" && pathname === "/api/logout") {
    const token = getCookie(request, "northstar_session");
    if (/^[a-f0-9]{64}$/.test(token)) await dbRun("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
    json(response, 200, { message: "You’re signed out." }, { "Set-Cookie": cookieHeader("", 0) });
    return;
  }
  if (request.method === "GET" && pathname === "/api/owner") {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    await ownerDashboard(admin, response);
    return;
  }
  const user = await requireUser(request, response);
  if (!user) return;
  if (request.method === "GET" && pathname === "/api/dashboard") {
    const query = new URL(request.url, publicBaseURL).searchParams;
    const taskFilter = query.get("taskFilter") || "open";
    const taskOffset = Number(query.get("taskOffset") || 0);
    if (!["open", "completed"].includes(taskFilter) || !Number.isSafeInteger(taskOffset) || taskOffset < 0 || taskOffset > 100_000) {
      json(response, 400, { error: "Invalid task list selection." });
      return;
    }
    json(response, 200, await studentData(user, taskFilter, taskOffset));
    return;
  }
  if (request.method === "GET" && pathname === "/api/billing/prices") {
    if (businessCountry === "LK") {
      await paddleBillingPrices(response, user);
    } else {
      await billingPrices(user, response);
    }
    return;
  }
  if (request.method === "POST" && pathname === "/api/tasks") {
    const input = await readJson(request);
    const errors = validateTask(input);
    if (Object.keys(errors).length) {
      json(response, 400, { error: "Please check the task details.", fieldErrors: errors });
      return;
    }
    const task = await withTransaction(async (client) => {
      const lock = usesPostgres ? " FOR UPDATE" : "";
      const currentUser = await dbGet(`SELECT plan FROM users WHERE id = ?${lock}`, [user.id], client);
      const activeCount = Number((await dbGet("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND completed_at IS NULL", [user.id], client)).count);
      if (currentUser?.plan !== "plus" && activeCount >= freeTaskLimit) return null;
      return dbGet("INSERT INTO tasks (user_id, title, due_date, priority, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *", [
        user.id, input.title.trim().normalize("NFC"), input.dueDate || null, input.priority || "normal", Date.now(),
      ], client);
    });
    if (!task) {
      json(response, 403, { code: "FREE_TASK_LIMIT", error: `Your free plan includes up to ${freeTaskLimit} active tasks. Upgrade to Plus for unlimited tasks.` });
      return;
    }
    json(response, 201, { task: apiTask(task) });
    return;
  }
  const taskRoute = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (request.method === "PATCH" && taskRoute) {
    const id = parseId(taskRoute[1]);
    if (!id) {
      json(response, 400, { error: "Invalid task ID." });
      return;
    }
    const input = await readJson(request);
    const existing = await dbGet("SELECT * FROM tasks WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!existing) {
      json(response, 404, { error: "Task not found." });
      return;
    }
    if (Object.hasOwn(input, "completed")) {
      if (typeof input.completed !== "boolean") {
        json(response, 400, { error: "Completion must be true or false." });
        return;
      }
      await dbRun("UPDATE tasks SET completed_at = ? WHERE id = ? AND user_id = ?", [input.completed ? Date.now() : null, id, user.id]);
    } else {
      const errors = validateTask(input);
      if (Object.keys(errors).length) {
        json(response, 400, { error: "Please check the task details.", fieldErrors: errors });
        return;
      }
      await dbRun("UPDATE tasks SET title = ?, due_date = ?, priority = ? WHERE id = ? AND user_id = ?", [
        input.title.trim().normalize("NFC"), input.dueDate || null, input.priority || "normal", id, user.id,
      ]);
    }
    json(response, 200, { task: apiTask(await dbGet("SELECT * FROM tasks WHERE id = ? AND user_id = ?", [id, user.id])) });
    return;
  }
  if (request.method === "DELETE" && taskRoute) {
    const id = parseId(taskRoute[1]);
    if (!id) {
      json(response, 400, { error: "Invalid task ID." });
      return;
    }
    const result = await dbRun("DELETE FROM tasks WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!result.changes) {
      json(response, 404, { error: "Task not found." });
      return;
    }
    json(response, 200, { deleted: true });
    return;
  }
  if (request.method === "POST" && pathname === "/api/activities") {
    const input = await readJson(request);
    const errors = validateActivity(input);
    if (Object.keys(errors).length) {
      json(response, 400, { error: "Please check the activity details.", fieldErrors: errors });
      return;
    }
    const activity = await withTransaction(async (client) => {
      const lock = usesPostgres ? " FOR UPDATE" : "";
      const currentUser = await dbGet(`SELECT plan FROM users WHERE id = ?${lock}`, [user.id], client);
      const isLimitedActivity = ["club", "sport", "other"].includes(input.kind);
      const activityCount = isLimitedActivity ? Number((await dbGet(`
        SELECT COUNT(*) AS count FROM activities
        WHERE user_id = ? AND kind IN ('club', 'sport', 'other')
        AND starts_at >= ? AND starts_at < ?
      `, [user.id, new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(), new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime()], client)).count) : 0;
      if (currentUser?.plan !== "plus" && isLimitedActivity && activityCount >= freeActivityLimit) return null;
      return dbGet("INSERT INTO activities (user_id, title, kind, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *", [
        user.id, input.title.trim().normalize("NFC"), input.kind, input.startsAt, input.endsAt, Date.now(),
      ], client);
    });
    if (!activity) {
      json(response, 403, { code: "FREE_ACTIVITY_LIMIT", error: `Your free plan includes ${freeActivityLimit} extracurricular activities each month. Upgrade to Plus for more.` });
      return;
    }
    json(response, 201, { activity: apiActivity(activity) });
    return;
  }
  const activityRoute = pathname.match(/^\/api\/activities\/(\d+)$/);
  if (request.method === "DELETE" && activityRoute) {
    const id = parseId(activityRoute[1]);
    if (!id) {
      json(response, 400, { error: "Invalid activity ID." });
      return;
    }
    const result = await dbRun("DELETE FROM activities WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!result.changes) {
      json(response, 404, { error: "Activity not found." });
      return;
    }
    json(response, 200, { deleted: true });
    return;
  }
  if (request.method === "POST" && pathname === "/api/billing/checkout") {
    const input = await readJson(request);
    if (input.cadence !== "monthly" && input.cadence !== "yearly") {
      json(response, 400, { error: "Choose monthly or yearly billing." });
      return;
    }
    if (businessCountry === "LK") {
      await createPaddleCheckout(user, input.cadence, response);
    } else {
      await createCheckout(user, request, response, input);
    }
    return;
  }
  if (request.method === "POST" && pathname === "/api/billing/portal") {
    if (businessCountry === "LK") {
      await createPaddlePortal(user, response);
    } else {
      await createPortal(user, response);
    }
    return;
  }
  json(response, 404, { error: "Not found." });
}

function serveStatic(response, pathname) {
  const filename = staticFiles.get(pathname);
  if (!filename) {
    response.writeHead(404, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const filePath = join(root, filename);
  if (!existsSync(filePath)) {
    response.writeHead(404, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  response.end(readFileSync(filePath));
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
      response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : "ok");
      return;
    }
    if (pathname.startsWith("/api/")) {
      await handleApi(request, response, pathname);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...securityHeaders(), Allow: "GET, HEAD" });
      response.end();
      return;
    }
    if (pathname === "/owner" || pathname === "/admin") {
      const user = await getUserFromSession(request);
      if (!user) {
        response.writeHead(302, { ...securityHeaders(), Location: "/login?next=%2Fowner", "Cache-Control": "no-store" });
        response.end();
        return;
      }
      if (!isAdmin(user)) {
        response.writeHead(403, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("Forbidden");
        return;
      }
      response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(readFileSync(join(root, "owner.html")));
      return;
    }
    serveStatic(response, pathname);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    if (error.status) {
      json(response, error.status, { error: error.message });
      return;
    }
    console.error("Request failed:", error);
    json(response, 500, { error: "Something went wrong. Please try again." });
  }
});

server.listen(port, () => {
  console.log(`Northstar is listening on port ${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
  });
}
