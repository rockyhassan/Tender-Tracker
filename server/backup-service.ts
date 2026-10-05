import { mkdirSync, readdirSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export const BACKUP_FORMAT = "tender-tracker-backup" as const;
export const BACKUP_VERSION = 1 as const;

export const BACKUP_TABLES = [
  "companies",
  "authorities",
  "documents",
  "app_security",
  "bank_profiles",
  "email_templates",
  "issue_batches",
  "tenders",
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

export interface BackupSnapshot<T = unknown> {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  tables: Record<string, Array<Record<string, T>>>;
}

export interface AutomaticBackupStatus {
  directory: string;
  retention: number;
  files: string[];
  latest?: string;
  provider?: "sqlite" | "postgres";
}

export interface AutomaticBackupResult {
  path: string;
  fileName: string;
  exportedAt: string;
}

export interface AutomaticBackupData {
  path: string;
  data: string;
}

/**
 * Universal backup provider abstraction.
 * Enables clean decoupling of SQLite and PostgreSQL cloud backup architectures.
 */
export interface IBackupProvider {
  readonly mode: "sqlite" | "postgres";
  exportBackup(): Promise<BackupSnapshot> | BackupSnapshot;
  restoreBackup(raw: unknown): Promise<{ restoredAt: string; tables: Record<string, number> }> | { restoredAt: string; tables: Record<string, number> };
  isRestoreSupported(): boolean;
  getStatus(): Promise<AutomaticBackupStatus> | AutomaticBackupStatus;
  writeAutomaticBackup(now?: Date): Promise<AutomaticBackupResult> | AutomaticBackupResult;
  readAutomaticBackup(fileName: string): Promise<AutomaticBackupData> | AutomaticBackupData;
  startScheduler(): NodeJS.Timeout | null;
}

const MAX_ROWS_PER_TABLE = 50_000;
const MAX_TOTAL_ROWS = 200_000;
const filePattern = /^tender-tracker-auto-(\d{4}-\d{2}-\d{2})\.json$/;

export function exportBackup(database: DatabaseSync): BackupSnapshot<SQLOutputValue> {
  const tables: Record<string, Array<Record<string, SQLOutputValue>>> = {};
  for (const table of BACKUP_TABLES) {
    tables[table] = database.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, SQLOutputValue>>;
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables };
}

export function validateSnapshot(raw: unknown): BackupSnapshot<SQLOutputValue> {
  if (!raw || typeof raw !== "object") throw new Error("Backup must be a JSON object");
  const candidate = raw as Partial<BackupSnapshot>;
  if (candidate.format !== BACKUP_FORMAT || candidate.version !== BACKUP_VERSION) throw new Error("Unsupported backup format or version");
  if (!candidate.tables || typeof candidate.tables !== "object" || Array.isArray(candidate.tables)) throw new Error("Backup tables are missing");
  const allowed = new Set<string>(BACKUP_TABLES);
  const tables: Record<string, Array<Record<string, SQLOutputValue>>> = {};
  let totalRows = 0;
  for (const [name, rows] of Object.entries(candidate.tables)) {
    if (!allowed.has(name)) throw new Error(`Unknown backup table: ${name}`);
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_TABLE) throw new Error(`Invalid rows for ${name}`);
    totalRows += rows.length;
    if (totalRows > MAX_TOTAL_ROWS) throw new Error("Backup contains too many rows");
    tables[name] = rows.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Invalid row ${index + 1} in ${name}`);
      const normalized: Record<string, SQLOutputValue> = {};
      for (const [column, value] of Object.entries(row)) {
        if (!["string", "number", "bigint", "boolean"].includes(typeof value) && value !== null) throw new Error(`Invalid value in ${name}.${column}`);
        if (typeof value === "boolean") normalized[column] = value ? 1 : 0;
        else if (typeof value === "bigint") normalized[column] = Number(value);
        else normalized[column] = value as SQLOutputValue;
      }
      return normalized;
    });
  }
  for (const table of BACKUP_TABLES) if (!tables[table]) tables[table] = [];
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: typeof candidate.exportedAt === "string" ? candidate.exportedAt : new Date().toISOString(), tables };
}

export function restoreBackup(database: DatabaseSync, raw: unknown): { restoredAt: string; tables: Record<string, number> } {
  const snapshot = validateSnapshot(raw);
  const columnsByTable = new Map<string, Set<string>>();
  for (const table of BACKUP_TABLES) {
    columnsByTable.set(table, new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)));
  }

  database.exec("PRAGMA foreign_keys = OFF; BEGIN");
  try {
    for (const table of [...BACKUP_TABLES].reverse()) database.exec(`DELETE FROM ${table}`);
    const restored: Record<string, number> = {};
    for (const table of BACKUP_TABLES) {
      const rows = snapshot.tables[table];
      const allowedColumns = columnsByTable.get(table)!;
      for (const row of rows) {
        const columns = Object.keys(row);
        if (!columns.length || columns.some((column) => !allowedColumns.has(column))) throw new Error(`Unknown column in ${table}`);
        const placeholders = columns.map(() => "?").join(", ");
        database.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`).run(...columns.map((column) => row[column] as SQLOutputValue));
      }
      restored[table] = rows.length;
    }
    database.exec("COMMIT; PRAGMA foreign_keys = ON;");
    return { restoredAt: new Date().toISOString(), tables: restored };
  } catch (error) {
    database.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
    throw error;
  }
}

export interface SqliteBackupProviderOptions {
  backupDirectory?: string;
  retention?: number;
}

/**
 * Local SQLite backup provider for offline / local-development operation.
 * Preserves disk-based snapshots and in-process timer scheduling.
 */
export class SqliteBackupProvider implements IBackupProvider {
  readonly mode = "sqlite" as const;
  readonly backupDirectory: string;
  readonly retention: number;

  constructor(
    private readonly database: DatabaseSync,
    options: SqliteBackupProviderOptions = {}
  ) {
    this.backupDirectory = resolve(
      options.backupDirectory ?? process.env.TENDER_BACKUP_DIR ?? join(process.cwd(), "data/backups")
    );
    this.retention = Math.max(1, Number(options.retention ?? process.env.TENDER_BACKUP_RETENTION ?? 7) || 7);
  }

  isRestoreSupported(): boolean {
    return true;
  }

  exportBackup(): BackupSnapshot {
    return exportBackup(this.database);
  }

  restoreBackup(raw: unknown): { restoredAt: string; tables: Record<string, number> } {
    return restoreBackup(this.database, raw);
  }

  getStatus(): AutomaticBackupStatus {
    const files = this.listFiles();
    return {
      directory: this.backupDirectory,
      retention: this.retention,
      files,
      latest: files[0],
      provider: "sqlite",
    };
  }

  writeAutomaticBackup(now = new Date()): AutomaticBackupResult {
    mkdirSync(this.backupDirectory, { recursive: true });
    const snapshot = this.exportBackup();
    const date = now.toISOString().slice(0, 10);
    const fileName = `tender-tracker-auto-${date}.json`;
    const path = join(this.backupDirectory, fileName);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    renameSync(temp, path);
    const files = this.listFiles();
    for (const old of files.slice(this.retention)) {
      rmSync(join(this.backupDirectory, old), { force: true });
    }
    return { path, fileName, exportedAt: snapshot.exportedAt };
  }

  readAutomaticBackup(fileName: string): AutomaticBackupData {
    if (!filePattern.test(fileName) || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
      throw new Error("Invalid automatic backup name");
    }
    const path = join(this.backupDirectory, fileName);
    return { path, data: readFileSync(path, "utf8") };
  }

  startScheduler(): NodeJS.Timeout {
    try {
      this.writeAutomaticBackup();
    } catch (error) {
      console.error("Automatic local backup failed on startup", error);
    }
    let lastDay = new Date().toISOString().slice(0, 10);
    const timer = setInterval(() => {
      const day = new Date().toISOString().slice(0, 10);
      if (day !== lastDay) {
        lastDay = day;
        try {
          this.writeAutomaticBackup();
        } catch (error) {
          console.error("Automatic local backup failed", error);
        }
      }
    }, 60_000);
    timer.unref();
    return timer;
  }

  private listFiles(): string[] {
    mkdirSync(this.backupDirectory, { recursive: true });
    return readdirSync(this.backupDirectory)
      .filter((name) => filePattern.test(name))
      .sort()
      .reverse();
  }
}
