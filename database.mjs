import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const { Pool } = pg;
const databaseURL = process.env.DATABASE_URL?.trim();
const dataDirectory = resolve(process.env.DATA_DIRECTORY || join(dirname(new URL(import.meta.url).pathname), "data"));
const databasePath = resolve(process.env.DATABASE_PATH || join(dataDirectory, "auth.sqlite"));
let sqlite;
let pool;
let sqliteQueue = Promise.resolve();
const sqliteTransactionContext = new AsyncLocalStorage();

function serializeSQLite(operation) {
  const result = sqliteQueue.then(operation);
  sqliteQueue = result.then(() => undefined, () => undefined);
  return result;
}

function runSQLiteQuery(operation) {
  return sqliteTransactionContext.getStore() ? operation() : serializeSQLite(operation);
}

const sqliteSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    subscription_status TEXT NOT NULL DEFAULT 'inactive',
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT UNIQUE,
    paddle_customer_id TEXT UNIQUE,
    paddle_subscription_id TEXT UNIQUE,
    subscription_period_end INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    due_date TEXT,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high')),
    completed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_user_due_idx ON tasks(user_id, due_date, completed_at);
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('class', 'club', 'sport', 'study', 'break', 'other')),
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activities_user_time_idx ON activities(user_id, starts_at);
  CREATE TABLE IF NOT EXISTS stripe_events (event_id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS paddle_events (event_id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL);
`;

const postgresSchema = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    subscription_status TEXT NOT NULL DEFAULT 'inactive',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    paddle_customer_id TEXT,
    paddle_subscription_id TEXT,
    subscription_period_end BIGINT,
    paddle_subscription_updated_at BIGINT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))",
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL DEFAULT 0
  )`,
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)",
  `CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    due_date TEXT,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high')),
    completed_at BIGINT,
    created_at BIGINT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS tasks_user_due_idx ON tasks(user_id, due_date, completed_at)",
  `CREATE TABLE IF NOT EXISTS activities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('class', 'club', 'sport', 'study', 'break', 'other')),
    starts_at BIGINT NOT NULL,
    ends_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS activities_user_time_idx ON activities(user_id, starts_at)",
  "CREATE TABLE IF NOT EXISTS stripe_events (event_id TEXT PRIMARY KEY, processed_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS paddle_events (event_id TEXT PRIMARY KEY, processed_at BIGINT NOT NULL)",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'inactive'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_period_end BIGINT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_subscription_updated_at BIGINT",
  "CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_idx ON users(stripe_customer_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_subscription_idx ON users(stripe_subscription_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_customer_idx ON users(paddle_customer_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_subscription_idx ON users(paddle_subscription_id)",
];

function postgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export async function initializeDatabase() {
  if (databaseURL) {
    let parsed;
    try {
      parsed = new URL(databaseURL);
    } catch {
      throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new Error("DATABASE_URL must use the postgres:// or postgresql:// protocol.");
    }
    if (!["require", "verify-ca", "verify-full"].includes(parsed.searchParams.get("sslmode"))) {
      throw new Error("Set sslmode=require in DATABASE_URL to encrypt the database connection.");
    }
    pool = new Pool({ connectionString: databaseURL, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    try {
      await pool.query("SELECT 1");
    } catch {
      await pool.end();
      pool = null;
      throw new Error("Could not connect to PostgreSQL. Check DATABASE_URL and verify the database is available.");
    }
    for (const statement of postgresSchema) await pool.query(statement);
    return;
  }

  mkdirSync(dirname(databasePath), { recursive: true });
  sqlite = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  sqlite.exec(sqliteSchema);
  const ensureColumn = (table, column, definition) => {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  ensureColumn("users", "plan", "TEXT NOT NULL DEFAULT 'free'");
  ensureColumn("users", "subscription_status", "TEXT NOT NULL DEFAULT 'inactive'");
  ensureColumn("users", "stripe_customer_id", "TEXT");
  ensureColumn("users", "stripe_subscription_id", "TEXT");
  ensureColumn("users", "paddle_customer_id", "TEXT");
  ensureColumn("users", "paddle_subscription_id", "TEXT");
  ensureColumn("users", "subscription_period_end", "INTEGER");
  ensureColumn("users", "paddle_subscription_updated_at", "INTEGER");
  ensureColumn("sessions", "created_at", "INTEGER NOT NULL DEFAULT 0");
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_idx ON users(stripe_customer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_subscription_idx ON users(stripe_subscription_id);
    CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_customer_idx ON users(paddle_customer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_subscription_idx ON users(paddle_subscription_id);
  `);
}

export async function dbGet(sql, params = [], client = pool) {
  if (pool) return (await client.query(postgresPlaceholders(sql), params)).rows[0];
  return runSQLiteQuery(() => sqlite.prepare(sql).get(...params));
}

export async function dbAll(sql, params = [], client = pool) {
  if (pool) return (await client.query(postgresPlaceholders(sql), params)).rows;
  return runSQLiteQuery(() => sqlite.prepare(sql).all(...params));
}

export async function dbRun(sql, params = [], client = pool) {
  if (pool) {
    const result = await client.query(postgresPlaceholders(sql), params);
    return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
  }
  return runSQLiteQuery(() => {
    const statement = sqlite.prepare(sql);
    if (/\bRETURNING\b/i.test(sql)) {
      const rows = statement.all(...params);
      return { changes: rows.length, lastInsertRowid: rows[0]?.id };
    }
    const result = statement.run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  });
}

export async function withTransaction(callback) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return serializeSQLite(async () => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = await sqliteTransactionContext.run(true, () => callback(null));
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  });
}

export async function closeDatabase() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

export const usesPostgres = Boolean(databaseURL);
