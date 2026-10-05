import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

export const DEFAULT_DATABASE_PATH = resolve(process.cwd(), "data/tender-tracker.sqlite");

/**
 * The SQL below mirrors drizzle/schema.ts. Keeping initialization in one place
 * makes the local server self-contained while Drizzle remains the model source
 * of truth for future migrations and lifecycle tables.
 */
const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT,
    contact TEXT,
    notes TEXT,
    archived_at TEXT,
    tender_username TEXT,
    tender_username_ciphertext TEXT,
    tender_password_ciphertext TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_security (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    recovery_email TEXT,
    recovery_reset_requested_at TEXT,
    recovery_reset_request_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bank_profiles (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_name TEXT NOT NULL,
    account_number_ciphertext TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_templates (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('purchase-sheet-bank', 'company-noa')),
    name TEXT NOT NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    email_to TEXT NOT NULL,
    email_cc TEXT,
    subject TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS authorities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, zone TEXT, contact TEXT, reference_notes TEXT,
    etender_portal TEXT, etender_reference TEXT, etender_notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, tender_id TEXT REFERENCES tenders(id) ON DELETE CASCADE, authority_id TEXT REFERENCES authorities(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
    CHECK ((tender_id IS NOT NULL AND authority_id IS NULL) OR (tender_id IS NULL AND authority_id IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS issue_batches (
    id TEXT PRIMARY KEY,
    company_id TEXT REFERENCES companies(id),
    authority_id TEXT REFERENCES authorities(id) ON DELETE SET NULL,
    issue_date TEXT NOT NULL,
    authority_zone TEXT NOT NULL,
    reference TEXT,
    notes TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tenders (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL,
    reference_no TEXT,
    company_id TEXT REFERENCES companies(id),
    issue_batch_id TEXT REFERENCES issue_batches(id),
    authority TEXT NOT NULL,
    authority_zone TEXT,
    package_name TEXT NOT NULL,
    closing_at TEXT NOT NULL,
    submission_at TEXT,
    tender_value INTEGER,
    submitted_value INTEGER,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tender_submissions (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    submitted_at TEXT NOT NULL,
    submitted_value INTEGER NOT NULL,
    submission_reference TEXT,
    status TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchase_sheets (
    id TEXT PRIMARY KEY,
    issue_batch_id TEXT NOT NULL REFERENCES issue_batches(id) ON DELETE CASCADE,
    sheet_number TEXT,
    purchased_at TEXT,
    purchase_amount INTEGER,
    payment_method TEXT,
    status TEXT NOT NULL,
    view_mode TEXT NOT NULL,
    bank_email_to TEXT,
    bank_email_cc TEXT,
    bank_email_subject TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchase_sheet_lines (
    id TEXT PRIMARY KEY,
    purchase_sheet_id TEXT NOT NULL REFERENCES purchase_sheets(id) ON DELETE CASCADE,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    line_order INTEGER NOT NULL,
    UNIQUE(purchase_sheet_id, tender_id)
  );

  CREATE TABLE IF NOT EXISTS charges (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    purchase_sheet_id TEXT REFERENCES purchase_sheets(id),
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    charged_at TEXT NOT NULL,
    reference TEXT,
    remarks TEXT,
    description TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pay_orders (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    purchase_sheet_id TEXT REFERENCES purchase_sheets(id),
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    order_number TEXT NOT NULL,
    amount INTEGER NOT NULL,
    payee TEXT NOT NULL DEFAULT '',
    issued_at TEXT NOT NULL,
    expires_at TEXT,
    bank TEXT,
    return_status TEXT,
    return_due_at TEXT,
    returned_at TEXT,
    status TEXT NOT NULL,
    remarks TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credit_commitment_certificates (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    certificate_number TEXT NOT NULL,
    amount INTEGER NOT NULL,
    value INTEGER,
    issued_at TEXT NOT NULL,
    expires_at TEXT,
    return_date TEXT,
    issuing_bank TEXT,
    status TEXT NOT NULL,
    remarks TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL,
    announced_at TEXT,
    result_date TEXT,
    quoted_amount INTEGER,
    rank INTEGER,
    awarded_company TEXT,
    remarks TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tender_id)
  );

  CREATE TABLE IF NOT EXISTS noa (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    noa_number TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    acceptance_deadline TEXT,
    contract_value INTEGER,
    status TEXT NOT NULL,
    remarks TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tender_id)
  );

  CREATE TABLE IF NOT EXISTS performance_securities (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    security_number TEXT NOT NULL,
    amount INTEGER NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    return_date TEXT,
    return_status TEXT,
    return_remarks TEXT,
    provider TEXT,
    status TEXT NOT NULL,
    remarks TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tender_id)
  );

  CREATE TABLE IF NOT EXISTS contract_agreements (
    id TEXT PRIMARY KEY,
    tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    contract_number TEXT NOT NULL,
    signed_at TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    contract_value INTEGER NOT NULL,
    status TEXT NOT NULL,
    remarks TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tender_id)
  );

  CREATE INDEX IF NOT EXISTS authorities_name_idx ON authorities(name);
  CREATE INDEX IF NOT EXISTS documents_tender_id_idx ON documents(tender_id);
  CREATE INDEX IF NOT EXISTS documents_authority_id_idx ON documents(authority_id);
  CREATE INDEX IF NOT EXISTS tenders_company_id_idx ON tenders(company_id);
  CREATE INDEX IF NOT EXISTS tenders_status_idx ON tenders(status);
  CREATE INDEX IF NOT EXISTS tenders_stage_idx ON tenders(stage);
  CREATE INDEX IF NOT EXISTS tenders_closing_at_idx ON tenders(closing_at);
  CREATE INDEX IF NOT EXISTS issue_batches_issue_date_idx ON issue_batches(issue_date);
  CREATE INDEX IF NOT EXISTS purchase_sheets_issue_batch_id_idx ON purchase_sheets(issue_batch_id);
  CREATE INDEX IF NOT EXISTS purchase_sheet_lines_sheet_id_idx ON purchase_sheet_lines(purchase_sheet_id);
  CREATE INDEX IF NOT EXISTS email_templates_type_company_idx ON email_templates(type, company_id);
  CREATE UNIQUE INDEX IF NOT EXISTS results_tender_id_idx ON results(tender_id);
  CREATE UNIQUE INDEX IF NOT EXISTS noa_tender_id_idx ON noa(tender_id);
  CREATE UNIQUE INDEX IF NOT EXISTS performance_securities_tender_id_idx ON performance_securities(tender_id);
  CREATE UNIQUE INDEX IF NOT EXISTS contract_agreements_tender_id_idx ON contract_agreements(tender_id);
`;

export interface SeedTender {
  id: string;
  tenderId: string;
  referenceNo?: string | null;
  company: string;
  companyId: string;
  authority: string;
  authorityZone?: string;
  packageName: string;
  closingAt: string;
  tenderValue: number;
  submittedValue?: number;
  stage: string;
  status: string;
}

export interface SeedCompany {
  id: string;
  name: string;
}

export const defaultSeedCompanies: SeedCompany[] = [
  { id: "seed-company-semu-enterprise", name: "Semu Enterprise" },
  { id: "seed-company-kashfia-jerin-enterprise", name: "Kashfia Jerin Enterprise" },
  { id: "seed-company-weply", name: "Weply" },
];

export const defaultSeedTenders: SeedTender[] = [
  {
    id: "seed-tender-2026-001",
    tenderId: "e-GP/2026/114",
    company: "Delta Infrastructure Ltd.",
    companyId: "seed-company-delta",
    authority: "LGED · Dhaka",
    authorityZone: "Dhaka",
    packageName: "Road rehabilitation package 04",
    closingAt: "2026-10-04T08:00:00.000Z",
    tenderValue: 8_420_000,
    stage: "New",
    status: "Active",
  },
];

export interface OpenDatabaseOptions {
  path?: string;
  seed?: boolean;
  seedTenders?: SeedTender[];
  seedCompanies?: SeedCompany[];
}

export function openTenderDatabase(options: OpenDatabaseOptions = {}): DatabaseSync {
  const databasePath = options.path ?? process.env.TENDER_DB_PATH ?? DEFAULT_DATABASE_PATH;
  if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });

  const { DatabaseSync: DatabaseSyncClass } =
    require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

  const database = new DatabaseSyncClass(databasePath);
  database.exec(SCHEMA_SQL);
  migrateLifecycleColumns(database);
  if (options.seed) seedDatabase(database, options.seedTenders ?? defaultSeedTenders, options.seedCompanies ?? defaultSeedCompanies);
  return database;
}

/** Add milestone columns to databases created by the previous schema version. */
function migrateLifecycleColumns(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS bank_profiles (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account_name TEXT NOT NULL,
      account_number_ciphertext TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_templates (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      email_to TEXT NOT NULL,
      email_cc TEXT,
      subject TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_templates_type_company_idx ON email_templates(type, company_id);
  `);
  database.exec(`CREATE TABLE IF NOT EXISTS authorities (id TEXT PRIMARY KEY, name TEXT NOT NULL, zone TEXT, contact TEXT, reference_notes TEXT, etender_portal TEXT, etender_reference TEXT, etender_notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, tender_id TEXT REFERENCES tenders(id) ON DELETE CASCADE, authority_id TEXT REFERENCES authorities(id) ON DELETE CASCADE, file_name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, CHECK ((tender_id IS NOT NULL AND authority_id IS NULL) OR (tender_id IS NULL AND authority_id IS NOT NULL))); CREATE INDEX IF NOT EXISTS authorities_name_idx ON authorities(name); CREATE INDEX IF NOT EXISTS documents_tender_id_idx ON documents(tender_id); CREATE INDEX IF NOT EXISTS documents_authority_id_idx ON documents(authority_id);`);
  const companyColumns = new Set((database.prepare("PRAGMA table_info(companies)").all() as Array<{ name: string }>).map((column) => column.name));
  const companyAdditions: Record<string, string> = { contact: "TEXT", notes: "TEXT", archived_at: "TEXT", tender_username_ciphertext: "TEXT" };
  for (const [name, definition] of Object.entries(companyAdditions)) if (!companyColumns.has(name)) database.exec(`ALTER TABLE companies ADD COLUMN ${name} ${definition}`);
  // The legacy column was never part of the public API. Clear any legacy plaintext
  // values so new versions only retain encrypted credentials.
  database.exec("UPDATE companies SET tender_username = NULL WHERE tender_username IS NOT NULL");
  const tenderInfo = database.prepare("PRAGMA table_info(tenders)").all() as Array<{ name: string; notnull: number }>;
  const tenderColumns = new Set(tenderInfo.map((column) => column.name));
  if (!tenderColumns.has("submission_at")) database.exec("ALTER TABLE tenders ADD COLUMN submission_at TEXT");
  if (!tenderColumns.has("reference_no")) database.exec("ALTER TABLE tenders ADD COLUMN reference_no TEXT");
  migrateNullableTenderValues(database, tenderInfo);
  migrateNullableTenderCompany(database);
  const additions: Record<string, Array<[string, string]>> = {
    charges: [["reference", "TEXT"], ["remarks", "TEXT"]],
    pay_orders: [["payee", "TEXT NOT NULL DEFAULT ''"], ["expires_at", "TEXT"], ["bank", "TEXT"], ["return_status", "TEXT"], ["remarks", "TEXT"], ["company_id", "TEXT REFERENCES companies(id) ON DELETE SET NULL"]],
    credit_commitment_certificates: [["value", "INTEGER"], ["return_date", "TEXT"], ["remarks", "TEXT"]],
    results: [["result_date", "TEXT"], ["awarded_company", "TEXT"], ["remarks", "TEXT"]],
    noa: [["remarks", "TEXT"]],
    performance_securities: [["return_date", "TEXT"], ["return_status", "TEXT"], ["return_remarks", "TEXT"], ["remarks", "TEXT"]],
    contract_agreements: [["remarks", "TEXT"]],
    purchase_sheet_lines: [["company_id", "TEXT REFERENCES companies(id) ON DELETE SET NULL"]],
    issue_batches: [["authority_id", "TEXT REFERENCES authorities(id) ON DELETE SET NULL"]],
  };
  for (const [table, columns] of Object.entries(additions)) {
    const present = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, definition] of columns) if (!present.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  database.exec("CREATE INDEX IF NOT EXISTS issue_batches_authority_id_idx ON issue_batches(authority_id); CREATE INDEX IF NOT EXISTS pay_orders_company_id_idx ON pay_orders(company_id);");
  database.exec(`
    DELETE FROM results WHERE rowid NOT IN (SELECT r.rowid FROM (SELECT rowid, MAX(updated_at) FROM results GROUP BY tender_id) r);
    DELETE FROM noa WHERE rowid NOT IN (SELECT r.rowid FROM (SELECT rowid, MAX(updated_at) FROM noa GROUP BY tender_id) r);
    DELETE FROM performance_securities WHERE rowid NOT IN (SELECT r.rowid FROM (SELECT rowid, MAX(updated_at) FROM performance_securities GROUP BY tender_id) r);
    DELETE FROM contract_agreements WHERE rowid NOT IN (SELECT r.rowid FROM (SELECT rowid, MAX(updated_at) FROM contract_agreements GROUP BY tender_id) r);
    CREATE UNIQUE INDEX IF NOT EXISTS results_tender_id_idx ON results(tender_id);
    CREATE UNIQUE INDEX IF NOT EXISTS noa_tender_id_idx ON noa(tender_id);
    CREATE UNIQUE INDEX IF NOT EXISTS performance_securities_tender_id_idx ON performance_securities(tender_id);
    CREATE UNIQUE INDEX IF NOT EXISTS contract_agreements_tender_id_idx ON contract_agreements(tender_id);
  `);
  repairLegacyTenderForeignKeys(database);
}

/** Older SQLite rebuilds renamed tenders before dropping the temporary table, leaving dependent FKs stale. */
function repairLegacyTenderForeignKeys(database: DatabaseSync): void {
  const legacyNames = ["tenders_legacy_nullable_values", "tenders_legacy_nullable_company"];
  const rows = database.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND (sql LIKE '%tenders_legacy_nullable_values%' OR sql LIKE '%tenders_legacy_nullable_company%')").all() as Array<{ name: string; sql: string }>;
  if (!rows.length) return;
  database.exec("PRAGMA writable_schema = ON");
  try {
    const update = database.prepare("UPDATE sqlite_master SET sql = replace(replace(sql, ?, 'tenders'), ?, 'tenders') WHERE name = ?");
    for (const row of rows) update.run(legacyNames[0], legacyNames[1], row.name);
    const version = Number((database.prepare("PRAGMA schema_version").get() as { schema_version?: number }).schema_version ?? 0);
    database.exec(`PRAGMA schema_version = ${version + 1}`);
  } finally {
    database.exec("PRAGMA writable_schema = OFF");
  }
}

/** Rebuild legacy tenders tables whose tender_value was NOT NULL, preserving every row and NULL as NULL. */
function migrateNullableTenderValues(database: DatabaseSync, tenderInfo: Array<{ name: string; notnull: number }>): void {
  if (!tenderInfo.some((column) => column.name === "tender_value" && column.notnull === 1)) return;
  database.exec("PRAGMA foreign_keys = OFF; BEGIN;");
  try {
    database.exec(`ALTER TABLE tenders RENAME TO tenders_legacy_nullable_values;
      CREATE TABLE tenders (
        id TEXT PRIMARY KEY, tender_id TEXT NOT NULL, company_id TEXT REFERENCES companies(id),
        issue_batch_id TEXT REFERENCES issue_batches(id), authority TEXT NOT NULL, authority_zone TEXT, package_name TEXT NOT NULL,
        closing_at TEXT NOT NULL, submission_at TEXT, tender_value INTEGER, submitted_value INTEGER, stage TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tenders (id,tender_id,company_id,issue_batch_id,authority,authority_zone,package_name,closing_at,submission_at,tender_value,submitted_value,stage,status,created_at,updated_at)
        SELECT id,tender_id,company_id,issue_batch_id,authority,authority_zone,package_name,closing_at,submission_at,tender_value,submitted_value,stage,status,created_at,updated_at FROM tenders_legacy_nullable_values;
      DROP TABLE tenders_legacy_nullable_values;
      CREATE INDEX IF NOT EXISTS tenders_company_id_idx ON tenders(company_id);
      CREATE INDEX IF NOT EXISTS tenders_status_idx ON tenders(status);
      CREATE INDEX IF NOT EXISTS tenders_stage_idx ON tenders(stage);
      CREATE INDEX IF NOT EXISTS tenders_closing_at_idx ON tenders(closing_at);`);
    database.exec("COMMIT; PRAGMA foreign_keys = ON;");
  } catch (error) {
    database.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
    throw error;
  }
}

/** Rebuild legacy tenders tables whose company_id was NOT NULL, preserving legacy rows. */
function migrateNullableTenderCompany(database: DatabaseSync): void {
  const info = database.prepare("PRAGMA table_info(tenders)").all() as Array<{ name: string; notnull: number }>;
  if (!info.some((column) => column.name === "company_id" && column.notnull === 1)) return;
  database.exec("PRAGMA foreign_keys = OFF; BEGIN;");
  try {
    database.exec(`ALTER TABLE tenders RENAME TO tenders_legacy_nullable_company;
      CREATE TABLE tenders (
        id TEXT PRIMARY KEY, tender_id TEXT NOT NULL, company_id TEXT REFERENCES companies(id),
        issue_batch_id TEXT REFERENCES issue_batches(id), authority TEXT NOT NULL, authority_zone TEXT, package_name TEXT NOT NULL,
        closing_at TEXT NOT NULL, submission_at TEXT, tender_value INTEGER, submitted_value INTEGER, stage TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tenders SELECT id,tender_id,company_id,issue_batch_id,authority,authority_zone,package_name,closing_at,submission_at,tender_value,submitted_value,stage,status,created_at,updated_at FROM tenders_legacy_nullable_company;
      DROP TABLE tenders_legacy_nullable_company;
      CREATE INDEX IF NOT EXISTS tenders_company_id_idx ON tenders(company_id);
      CREATE INDEX IF NOT EXISTS tenders_status_idx ON tenders(status);
      CREATE INDEX IF NOT EXISTS tenders_stage_idx ON tenders(stage);
      CREATE INDEX IF NOT EXISTS tenders_closing_at_idx ON tenders(closing_at);`);
    database.exec("COMMIT; PRAGMA foreign_keys = ON;");
  } catch (error) { database.exec("ROLLBACK; PRAGMA foreign_keys = ON;"); throw error; }
}
export function seedDatabase(database: DatabaseSync, tenders: SeedTender[] = defaultSeedTenders, companies: SeedCompany[] = defaultSeedCompanies): void {
  const now = new Date().toISOString();
  database.exec("BEGIN");
  try {
    const companyProfile = database.prepare(`
      INSERT OR IGNORE INTO companies (id, name, created_at, updated_at)
      SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM companies WHERE name = ? COLLATE NOCASE
      )
    `);
    const company = database.prepare(`
      INSERT OR IGNORE INTO companies (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const tender = database.prepare(`
      INSERT OR IGNORE INTO tenders
        (id, tender_id, company_id, authority, authority_zone, package_name,
         closing_at, tender_value, submitted_value, stage, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of companies) companyProfile.run(item.id, item.name, now, now, item.name);

    const count = database.prepare("SELECT COUNT(*) AS count FROM tenders").get() as { count: number };
    if (Number(count.count) === 0) for (const item of tenders) {
      company.run(item.companyId, item.company, now, now);
      tender.run(
        item.id,
        item.tenderId,
        item.companyId,
        item.authority,
        item.authorityZone ?? null,
        item.packageName,
        item.closingAt,
        item.tenderValue,
        item.submittedValue ?? null,
        item.stage,
        item.status,
        now,
        now,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
