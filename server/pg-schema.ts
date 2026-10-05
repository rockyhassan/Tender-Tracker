import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";

export const POSTGRES_TABLES = [
  "companies",
  "app_security",
  "bank_profiles",
  "email_templates",
  "authorities",
  "issue_batches",
  "tenders",
  "documents",
  "tender_submissions",
  "purchase_sheets",
  "purchase_sheet_lines",
  "charges",
  "pay_orders",
  "credit_commitment_certificates",
  "results",
  "noa",
  "performance_securities",
  "contract_agreements",
] as const;

export type PostgresTable = (typeof POSTGRES_TABLES)[number];

const schemaSqlPath = resolve(process.cwd(), "server/pg-schema.sql");
export const POSTGRES_SCHEMA_SQL = readFileSync(schemaSqlPath, "utf-8");

/**
 * Applies the Tender Tracker PostgreSQL foundation schema.
 * Executes all DDL safely (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
 */
export async function applyPostgresSchema(pool: pg.Pool): Promise<{
  tablesChecked: string[];
  existingTables: string[];
  missingTables: string[];
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(POSTGRES_SCHEMA_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return verifyPostgresSchema(pool);
}

/**
 * Checks which of the 18 required tables currently exist in PostgreSQL.
 */
export async function verifyPostgresSchema(pool: pg.Pool): Promise<{
  tablesChecked: string[];
  existingTables: string[];
  missingTables: string[];
}> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [[...POSTGRES_TABLES]]
  );

  const existingTables = result.rows.map((r) => r.table_name);
  const existingSet = new Set(existingTables);
  const missingTables = POSTGRES_TABLES.filter((name) => !existingSet.has(name));

  return {
    tablesChecked: [...POSTGRES_TABLES],
    existingTables,
    missingTables,
  };
}
