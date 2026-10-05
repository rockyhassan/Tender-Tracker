import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;

export const SUPABASE_TRANSACTION_POOLER_PORT = 6543;
export const DIRECT_POSTGRES_PORT = 5432;

// Simple zero-dependency .env loader for server environments and scripts
let envLoaded = false;
export function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envFiles = process.env.NODE_ENV === "production" ? [".env"] : [".env.local", ".env"];

  for (const filename of envFiles) {
    const envPath = resolve(process.cwd(), filename);
    if (!existsSync(envPath)) continue;

    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

export interface PgPoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export interface SanitizedPgConfig {
  connectionMode: "connectionString" | "discreteParameters" | "unconfigured";
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl: boolean | string;
  maxConnections: number;
  isSupabase: boolean;
  isTransactionPoolerPort: boolean;
  warning?: string;
}

let activePool: pg.Pool | null = null;

/**
 * Parses and returns the Postgres connection configuration from environment variables.
 * Prioritizes DATABASE_URL / SUPABASE_DB_URL / POSTGRES_URL, falling back to discrete PG* variables.
 */
export function getPgConfig(): PgPoolConfig {
  loadEnvFile();
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL;

  const max = Number(process.env.PG_POOL_MAX || process.env.PG_MAX_CONNECTIONS || 10);
  const idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS || 30000);
  const connectionTimeoutMillis = Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000);

  if (connectionString) {
    let ssl: boolean | { rejectUnauthorized: boolean } | undefined;
    const isExplicitlyDisabled =
      process.env.PGSSLMODE === "disable" ||
      process.env.PG_SSL === "false" ||
      connectionString.includes("sslmode=disable");

    if (isExplicitlyDisabled) {
      ssl = false;
    } else {
      // Supabase & remote PostgreSQL require SSL with permissive CA verification in Node.js
      ssl = { rejectUnauthorized: false };
    }

    return {
      connectionString,
      ssl,
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
    };
  }

  const host =
    process.env.PGHOST ||
    process.env.POSTGRES_HOST ||
    process.env.SUPABASE_DB_HOST;

  const rawPort =
    process.env.PGPORT ||
    process.env.POSTGRES_PORT ||
    process.env.SUPABASE_DB_PORT;

  const isSupabaseHost = Boolean(host && (host.includes("supabase.co") || host.includes("pooler.supabase.com")));
  const port = rawPort ? Number(rawPort) : (isSupabaseHost ? SUPABASE_TRANSACTION_POOLER_PORT : DIRECT_POSTGRES_PORT);

  const database =
    process.env.PGDATABASE ||
    process.env.POSTGRES_DATABASE ||
    process.env.SUPABASE_DB_DATABASE ||
    "postgres";

  const user =
    process.env.PGUSER ||
    process.env.POSTGRES_USER ||
    process.env.SUPABASE_DB_USER;

  const password =
    process.env.PGPASSWORD ||
    process.env.POSTGRES_PASSWORD ||
    process.env.SUPABASE_DB_PASSWORD;

  let ssl: boolean | { rejectUnauthorized: boolean } | undefined;
  if (process.env.PGSSLMODE === "disable" || process.env.PG_SSL === "false") {
    ssl = false;
  } else if (isSupabaseHost || process.env.PGSSLMODE === "require" || process.env.NODE_ENV === "production") {
    ssl = { rejectUnauthorized: false };
  }

  return {
    host,
    port,
    database,
    user,
    password,
    ssl,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
  };
}

/**
 * Returns a sanitized configuration summary that is safe to log or inspect.
 * Never exposes passwords or secret connection strings.
 */
export function getSanitizedPgConfig(): SanitizedPgConfig {
  const config = getPgConfig();

  if (config.connectionString) {
    try {
      const parsed = new URL(config.connectionString);
      const host = parsed.hostname;
      const port = parsed.port ? Number(parsed.port) : DIRECT_POSTGRES_PORT;
      const database = parsed.pathname.replace(/^\//, "");
      const user = parsed.username || undefined;
      const isSupabase = host.includes("supabase.co") || host.includes("pooler.supabase.com");
      const isTransactionPoolerPort = port === SUPABASE_TRANSACTION_POOLER_PORT;

      let warning: string | undefined;
      if (isSupabase && port === DIRECT_POSTGRES_PORT) {
        warning = "Supabase connection is using direct port 5432. Production/serverless environments must use Transaction Pooler port 6543 to avoid connection exhaustion.";
      }

      return {
        connectionMode: "connectionString",
        host,
        port,
        database,
        user,
        ssl: typeof config.ssl === "object" ? "enabled (rejectUnauthorized: false)" : Boolean(config.ssl),
        maxConnections: config.max ?? 10,
        isSupabase,
        isTransactionPoolerPort,
        warning,
      };
    } catch {
      return {
        connectionMode: "connectionString",
        ssl: Boolean(config.ssl),
        maxConnections: config.max ?? 10,
        isSupabase: false,
        isTransactionPoolerPort: false,
        warning: "Could not parse connectionString URL structure.",
      };
    }
  }

  if (config.host) {
    const isSupabase = config.host.includes("supabase.co") || config.host.includes("pooler.supabase.com");
    const port = config.port ?? (isSupabase ? SUPABASE_TRANSACTION_POOLER_PORT : DIRECT_POSTGRES_PORT);
    const isTransactionPoolerPort = port === SUPABASE_TRANSACTION_POOLER_PORT;

    let warning: string | undefined;
    if (isSupabase && port === DIRECT_POSTGRES_PORT) {
      warning = "Supabase host is configured with direct port 5432. Production/serverless environments must use Transaction Pooler port 6543.";
    }

    return {
      connectionMode: "discreteParameters",
      host: config.host,
      port,
      database: config.database,
      user: config.user,
      ssl: typeof config.ssl === "object" ? "enabled (rejectUnauthorized: false)" : Boolean(config.ssl),
      maxConnections: config.max ?? 10,
      isSupabase,
      isTransactionPoolerPort,
      warning,
    };
  }

  return {
    connectionMode: "unconfigured",
    ssl: false,
    maxConnections: config.max ?? 10,
    isSupabase: false,
    isTransactionPoolerPort: false,
    warning: "No PostgreSQL connection variables found (DATABASE_URL or PGHOST).",
  };
}

/**
 * Creates a new pg.Pool instance with the provided or environment configuration.
 */
export function createPgPool(overrideConfig?: Partial<PgPoolConfig>): pg.Pool {
  const baseConfig = getPgConfig();
  const poolConfig = { ...baseConfig, ...overrideConfig };

  const pool = new Pool(poolConfig);

  pool.on("error", (err) => {
    console.error("[PostgreSQL Pool Error]", err.message);
  });

  return pool;
}

/**
 * Returns the singleton pg.Pool instance, initializing it if not already active.
 */
export function getPgPool(): pg.Pool {
  if (!activePool) {
    activePool = createPgPool();
  }
  return activePool;
}

/**
 * Closes the active pg.Pool cleanly.
 */
export async function closePgPool(): Promise<void> {
  if (activePool) {
    const pool = activePool;
    activePool = null;
    await pool.end();
  }
}

/**
 * Tests PostgreSQL connectivity by executing SELECT 1.
 */
export async function testPgConnection(pool: pg.Pool = getPgPool()): Promise<{
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}> {
  const sanitized = getSanitizedPgConfig();
  if (sanitized.connectionMode === "unconfigured") {
    return {
      ok: false,
      message: "PostgreSQL credentials are not configured in environment.",
      details: { config: sanitized },
    };
  }

  try {
    const start = Date.now();
    const result = await pool.query<{
      connected: number;
      server_time: string;
      pg_version: string;
    }>("SELECT 1 AS connected, NOW() AS server_time, version() AS pg_version");
    const durationMs = Date.now() - start;

    const row = result.rows[0];
    return {
      ok: Boolean(row && row.connected === 1),
      message: "Successfully connected to PostgreSQL database.",
      details: {
        durationMs,
        serverTime: row?.server_time,
        version: row?.pg_version,
        config: sanitized,
      },
    };
  } catch (error: any) {
    return {
      ok: false,
      message: `Failed to connect to PostgreSQL: ${error.message}`,
      details: {
        code: error.code,
        config: sanitized,
      },
    };
  }
}
