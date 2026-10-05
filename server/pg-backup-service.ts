import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BACKUP_TABLES,
  type BackupSnapshot,
  type IBackupProvider,
  type AutomaticBackupStatus,
  type AutomaticBackupResult,
  type AutomaticBackupData,
} from "./backup-service";
import { ensureStorageBucket } from "./supabase";

export interface PostgresBackupProviderOptions {
  retention?: number;
  bucketName?: string;
}

const NUMERIC_COLUMNS = new Set([
  "tender_value",
  "submitted_value",
  "size_bytes",
  "purchase_amount",
  "line_order",
  "amount",
  "value",
  "quoted_amount",
  "rank",
  "contract_value",
]);

const filePattern = /^tender-tracker-auto-(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Cloud-compatible backup provider for PostgreSQL / Supabase mode.
 *
 * - Performs application-level logical export across all 18 foundation tables.
 * - Stores retained automatic backups in private Supabase Storage (public: false).
 * - Never executes SQLite commands, PRAGMA statements, or local filesystem snapshots.
 * - Disables in-process setInterval timers in cloud/serverless environments.
 * - Leaves destructive database restore to Supabase Platform managed backups / PITR.
 */
export class PostgresBackupProvider implements IBackupProvider {
  readonly mode = "postgres" as const;
  readonly retention: number;
  readonly bucketName: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly supabaseClient?: SupabaseClient | null,
    options: PostgresBackupProviderOptions = {}
  ) {
    this.retention = Math.max(1, Number(options.retention ?? process.env.TENDER_BACKUP_RETENTION ?? 7) || 7);
    this.bucketName = options.bucketName ?? "backups";
  }

  isRestoreSupported(): boolean {
    return false;
  }

  /**
   * Logical export of all 18 foundation tables from PostgreSQL.
   * Produces the canonical BackupSnapshot format without depending on SQLite.
   */
  async exportBackup(): Promise<BackupSnapshot> {
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    const allowed = new Set<string>(BACKUP_TABLES);

    for (const table of BACKUP_TABLES) {
      if (!allowed.has(table)) {
        throw new Error(`Invalid table name for backup export: ${table}`);
      }

      // Query table safely using validated identifier
      const result = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM "${table}" ORDER BY "id" ASC`
      );

      tables[table] = result.rows.map((row) => {
        const normalized: Record<string, unknown> = {};
        for (const [col, val] of Object.entries(row)) {
          if (val instanceof Date) {
            normalized[col] = val.toISOString();
          } else if (typeof val === "bigint") {
            normalized[col] = Number(val);
          } else if (typeof val === "string" && NUMERIC_COLUMNS.has(col) && /^-?\d+$/.test(val)) {
            normalized[col] = Number(val);
          } else if (val === null || val === undefined) {
            normalized[col] = null;
          } else {
            normalized[col] = val;
          }
        }
        return normalized;
      });
    }

    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables,
    };
  }

  /**
   * Destructive restore is explicitly rejected in PostgreSQL mode.
   * Full database restoration must be handled via Supabase Platform (PITR/backups)
   * or dedicated platform CLI tooling to maintain relational and storage integrity.
   */
  async restoreBackup(_raw: unknown): Promise<never> {
    throw new Error(
      "Database restore in PostgreSQL mode is managed via Supabase Platform (PITR/backups) to prevent destructive cloud data loss."
    );
  }

  /**
   * Retrieves automatic backup status from private Supabase Storage.
   */
  async getStatus(): Promise<AutomaticBackupStatus> {
    if (!this.supabaseClient) {
      return {
        directory: "supabase-storage://unconfigured",
        retention: this.retention,
        files: [],
        latest: undefined,
        provider: "postgres",
      };
    }

    try {
      const { data: list, error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .list();

      if (error) {
        console.warn("[PostgreSQL Backup] Failed to list storage backups:", error.message);
        return {
          directory: `supabase-storage://${this.bucketName}`,
          retention: this.retention,
          files: [],
          latest: undefined,
          provider: "postgres",
        };
      }

      const files = (list || [])
        .map((f) => f.name)
        .filter((name) => filePattern.test(name))
        .sort()
        .reverse();

      return {
        directory: `supabase-storage://${this.bucketName}`,
        retention: this.retention,
        files,
        latest: files[0],
        provider: "postgres",
      };
    } catch (err: any) {
      console.warn("[PostgreSQL Backup] Unexpected error retrieving backup status:", err.message);
      return {
        directory: `supabase-storage://${this.bucketName}`,
        retention: this.retention,
        files: [],
        latest: undefined,
        provider: "postgres",
      };
    }
  }

  /**
   * Writes an automatic backup snapshot to private Supabase Storage and applies retention pruning.
   */
  async writeAutomaticBackup(now = new Date()): Promise<AutomaticBackupResult> {
    if (!this.supabaseClient) {
      throw new Error("Supabase Storage client is not configured for PostgreSQL automatic cloud backups.");
    }

    await ensureStorageBucket(this.supabaseClient, this.bucketName, { isPublic: false });

    const snapshot = await this.exportBackup();
    const date = now.toISOString().slice(0, 10);
    const fileName = `tender-tracker-auto-${date}.json`;
    const content = Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8");

    const { error: uploadError } = await this.supabaseClient.storage
      .from(this.bucketName)
      .upload(fileName, content, {
        contentType: "application/json",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload backup to Supabase Storage: ${uploadError.message}`);
    }

    // Apply cloud backup retention pruning
    try {
      const { data: list } = await this.supabaseClient.storage
        .from(this.bucketName)
        .list();

      const existingFiles = (list || [])
        .map((f) => f.name)
        .filter((name) => filePattern.test(name))
        .sort()
        .reverse();

      const staleFiles = existingFiles.slice(this.retention);
      if (staleFiles.length > 0) {
        await this.supabaseClient.storage.from(this.bucketName).remove(staleFiles);
      }
    } catch (pruneErr: any) {
      console.warn("[PostgreSQL Backup] Retention pruning warning:", pruneErr.message);
    }

    return {
      path: `${this.bucketName}/${fileName}`,
      fileName,
      exportedAt: snapshot.exportedAt,
    };
  }

  /**
   * Reads an automatic backup payload from private Supabase Storage.
   */
  async readAutomaticBackup(fileName: string): Promise<AutomaticBackupData> {
    if (!filePattern.test(fileName) || fileName.includes("/") || fileName.includes("\\")) {
      throw new Error("Invalid automatic backup name");
    }

    if (!this.supabaseClient) {
      throw new Error("Supabase Storage client is not configured for PostgreSQL automatic cloud backups.");
    }

    const { data, error } = await this.supabaseClient.storage
      .from(this.bucketName)
      .download(fileName);

    if (error || !data) {
      throw new Error(`Backup file '${fileName}' not found in Supabase Storage`);
    }

    const content = await data.text();
    return {
      path: `${this.bucketName}/${fileName}`,
      data: content,
    };
  }

  /**
   * In PostgreSQL/serverless cloud mode, process-local timers (setInterval) must NOT be started.
   * Scheduled backups should be triggered via platform schedulers (e.g. Vercel Cron or external triggers).
   */
  startScheduler(): NodeJS.Timeout | null {
    console.log(
      "[PostgreSQL Backup] Process-local timer disabled in PostgreSQL/serverless mode. Cloud backups rely on external scheduler or manual trigger."
    );
    return null;
  }
}
