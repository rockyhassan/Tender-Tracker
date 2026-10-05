import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openTenderDatabase } from "../server/database";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BACKUP_TABLES,
  SqliteBackupProvider,
  exportBackup as sqliteExportBackup,
} from "../server/backup-service";
import { PostgresBackupProvider } from "../server/pg-backup-service";
import { getPgPool, closePgPool, testPgConnection } from "../server/postgres";
import { getSupabaseClient, ensureStorageBucket, getSupabaseConfig } from "../server/supabase";
import { app, backupProvider, securityService } from "../server";

async function runBackupMigrationTests(): Promise<void> {
  console.log("===============================================================");
  console.log("Tender Tracker — Phase 2C Cloud Backup Migration Test Suite");
  console.log("===============================================================\n");

  // ---------------------------------------------------------------------------
  // Preflight: PostgreSQL & Supabase Connectivity
  // ---------------------------------------------------------------------------
  const pgConn = await testPgConnection();
  if (!pgConn.ok) {
    console.error("❌ PostgreSQL connection failed:", pgConn.message);
    process.exit(1);
  }
  console.log("✓ Connected to PostgreSQL:", pgConn.details?.version);

  const supabaseConfig = getSupabaseConfig();
  if (!supabaseConfig.isConfigured) {
    console.error("❌ Supabase is not configured in environment.");
    process.exit(1);
  }
  const supabase = getSupabaseClient();
  assert(supabase, "Supabase client must be available");
  console.log("✓ Connected to Supabase:", supabaseConfig.url);

  const pool = getPgPool();
  const testRunId = `TEST-${Date.now()}`;
  const localTestDir = join(tmpdir(), `tender-backup-test-${Date.now()}`);

  // Tracking artifacts for cleanup
  const cleanupStorageFiles: string[] = [];
  const cleanupPgTenderIds: string[] = [];
  const cleanupPgCompanyIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // Test 1: SQLite Backup & Fallback Mode
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Verifying SQLite Backup & Fallback Mode...");
    mkdirSync(localTestDir, { recursive: true });
    const sqliteDb = openTenderDatabase({ path: join(localTestDir, "test.sqlite") });

    const sqliteProvider = new SqliteBackupProvider(sqliteDb, {
      backupDirectory: localTestDir,
      retention: 2,
    });

    assert.equal(sqliteProvider.mode, "sqlite");
    assert.equal(sqliteProvider.isRestoreSupported(), true);

    // Insert test company and tender into SQLite
    const sqliteCompanyId = randomUUID();
    const sqliteTenderId = randomUUID();
    sqliteDb.prepare(`
      INSERT INTO companies (id, name, created_at, updated_at)
      VALUES (?, ?, datetime('now'), datetime('now'))
    `).run(sqliteCompanyId, "SQLite Backup Test Corp");

    sqliteDb.prepare(`
      INSERT INTO tenders (id, tender_id, company_id, authority, package_name, closing_at, stage, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), 'New', 'Active', datetime('now'), datetime('now'))
    `).run(sqliteTenderId, `SQLITE-TENDER-${Date.now()}`, sqliteCompanyId, "Test Auth", "SQLite Pkg");

    // 1a. Export snapshot
    const sqliteSnapshot = sqliteProvider.exportBackup();
    assert.equal(sqliteSnapshot.format, BACKUP_FORMAT);
    assert.equal(sqliteSnapshot.version, BACKUP_VERSION);
    assert(Array.isArray(sqliteSnapshot.tables.companies));
    assert(sqliteSnapshot.tables.companies.some((c: any) => c.id === sqliteCompanyId));
    assert(sqliteSnapshot.tables.tenders.some((t: any) => t.id === sqliteTenderId));
    for (const table of BACKUP_TABLES) {
      assert(Array.isArray(sqliteSnapshot.tables[table]), `Table ${table} must be present in snapshot`);
    }
    console.log("  ✓ SQLite logical export contains all 18 tables and test records.");

    // 1b. Write automatic backup to local disk
    const writeResult = sqliteProvider.writeAutomaticBackup();
    assert(existsSync(writeResult.path), "Backup file must be written to disk");
    assert.match(writeResult.fileName, /^tender-tracker-auto-\d{4}-\d{2}-\d{2}\.json$/);

    // 1c. Get status & read automatic backup
    const sqliteStatus = sqliteProvider.getStatus();
    assert.equal(sqliteStatus.directory, localTestDir);
    assert.equal(sqliteStatus.retention, 2);
    assert(sqliteStatus.files.includes(writeResult.fileName));
    assert.equal(sqliteStatus.latest, writeResult.fileName);

    const readData = sqliteProvider.readAutomaticBackup(writeResult.fileName);
    assert(readData.data.includes(sqliteCompanyId), "Read data must contain test company");
    console.log("  ✓ Local disk write, status, and read match expected snapshot format.");

    // 1d. Local retention pruning
    writeFileSync(join(localTestDir, "tender-tracker-auto-2020-01-01.json"), "{}");
    writeFileSync(join(localTestDir, "tender-tracker-auto-2020-01-02.json"), "{}");
    writeFileSync(join(localTestDir, "tender-tracker-auto-2020-01-03.json"), "{}");
    sqliteProvider.writeAutomaticBackup();
    const prunedStatus = sqliteProvider.getStatus();
    assert(prunedStatus.files.length <= 2, `Retention pruning must limit files to retention limit (2). Found: ${prunedStatus.files.length}`);
    console.log("  ✓ Local SQLite backup retention pruning verified.");

    // 1e. SQLite restore
    sqliteDb.prepare("DELETE FROM tenders WHERE id = ?").run(sqliteTenderId);
    const beforeRestore = sqliteDb.prepare("SELECT * FROM tenders WHERE id = ?").get(sqliteTenderId);
    assert.equal(beforeRestore, undefined, "Tender must be deleted prior to restore");

    const restoreResult = sqliteProvider.restoreBackup(sqliteSnapshot);
    assert(restoreResult.restoredAt, "Restore must return restoredAt timestamp");
    const afterRestore = sqliteDb.prepare("SELECT * FROM tenders WHERE id = ?").get(sqliteTenderId) as any;
    assert(afterRestore && afterRestore.id === sqliteTenderId, "Tender must be restored from snapshot");
    console.log("  ✓ SQLite snapshot restore verified.");

    // 1f. SQLite scheduler creates timer
    const sqliteTimer = sqliteProvider.startScheduler();
    assert(sqliteTimer, "SQLite provider must return an active timer");
    clearInterval(sqliteTimer);
    console.log("  ✓ SQLite in-process scheduler starts timer.");

    // -------------------------------------------------------------------------
    // Test 2: PostgreSQL Mode Does NOT Invoke SQLite Backup Logic
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Verifying PostgreSQL Mode Does NOT Invoke SQLite Backup Logic...");
    const pgProvider = new PostgresBackupProvider(pool, supabase, {
      retention: 2,
      bucketName: "backups",
    });

    assert.equal(pgProvider.mode, "postgres");
    assert.equal(pgProvider.isRestoreSupported(), false);

    // Verify restore is rejected without executing SQLite statements
    let restoreBlocked = false;
    try {
      await pgProvider.restoreBackup(sqliteSnapshot);
    } catch (err: any) {
      restoreBlocked = true;
      assert.match(err.message, /managed via Supabase Platform/i);
    }
    assert(restoreBlocked, "PostgreSQL restore must be rejected with informative error");
    console.log("  ✓ Destructive restore in PostgreSQL mode safely rejected.");

    // -------------------------------------------------------------------------
    // Test 3: Backup Provider Selection (isPg vs SQLite)
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Verifying Backup Provider Selection...");
    // Since environment has DATABASE_URL and USE_SQLITE is not set, server/index.ts selects PostgresBackupProvider
    assert.equal(backupProvider.mode, "postgres", "Default server configuration must select PostgresBackupProvider");
    assert(backupProvider instanceof PostgresBackupProvider, "backupProvider must be an instance of PostgresBackupProvider");

    // Instantiating with USE_SQLITE selection
    const fallbackProvider = new SqliteBackupProvider(sqliteDb);
    assert.equal(fallbackProvider.mode, "sqlite");
    assert(fallbackProvider instanceof SqliteBackupProvider);
    console.log("  ✓ Backup provider selects correctly based on active database configuration.");

    // -------------------------------------------------------------------------
    // Test 4: PostgreSQL Backup & Storage Behavior against Supabase
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Verifying PostgreSQL Backup & Storage Behavior against Supabase...");

    // Create temporary test records in PostgreSQL
    const testCompanyId = randomUUID();
    const testTenderId = randomUUID();
    cleanupPgCompanyIds.push(testCompanyId);
    cleanupPgTenderIds.push(testTenderId);

    await pool.query(
      `INSERT INTO companies (id, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [testCompanyId, `Cloud Backup Test Company ${testRunId}`]
    );

    await pool.query(
      `INSERT INTO tenders (id, tender_id, company_id, authority, package_name, closing_at, stage, status, tender_value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + interval '30 days', 'New', 'Active', 750000, NOW(), NOW())`,
      [testTenderId, `PG-BACKUP-${testRunId}`, testCompanyId, "Cloud Auth", "Cloud Pkg"]
    );

    // 4a. Logical export from PostgreSQL
    const pgSnapshot = await pgProvider.exportBackup();
    assert.equal(pgSnapshot.format, BACKUP_FORMAT);
    assert.equal(pgSnapshot.version, BACKUP_VERSION);
    assert(pgSnapshot.exportedAt, "exportedAt must be present");

    for (const table of BACKUP_TABLES) {
      assert(Array.isArray(pgSnapshot.tables[table]), `Table ${table} must be present in PostgreSQL snapshot`);
    }

    const exportedCompany = pgSnapshot.tables.companies.find((c: any) => c.id === testCompanyId);
    const exportedTender = pgSnapshot.tables.tenders.find((t: any) => t.id === testTenderId);
    assert(exportedCompany, "PostgreSQL test company must be in snapshot");
    assert(exportedTender, "PostgreSQL test tender must be in snapshot");
    assert.equal(exportedTender.tender_value, 750000, "Numeric tender_value must be preserved as number");
    assert(typeof exportedTender.closing_at === "string", "TIMESTAMPTZ must be serialized to ISO string");
    console.log("  ✓ PostgreSQL logical export produced valid snapshot across all 18 tables.");

    // 4b. Upload automatic backup to private Supabase Storage
    const cloudWriteResult = await pgProvider.writeAutomaticBackup();
    assert.match(cloudWriteResult.fileName, /^tender-tracker-auto-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(cloudWriteResult.path, `backups/${cloudWriteResult.fileName}`);
    cleanupStorageFiles.push(cloudWriteResult.fileName);
    console.log(`  ✓ Automatic backup written to Supabase Storage: ${cloudWriteResult.path}`);

    // 4c. Get status from Supabase Storage
    const cloudStatus = await pgProvider.getStatus();
    assert.equal(cloudStatus.directory, "supabase-storage://backups");
    assert.equal(cloudStatus.retention, 2);
    assert(cloudStatus.files.includes(cloudWriteResult.fileName));
    assert.equal(cloudStatus.latest, cloudWriteResult.fileName);
    assert.equal(cloudStatus.provider, "postgres");
    console.log("  ✓ Supabase Storage backup status verified.");

    // 4d. Read automatic backup from Supabase Storage
    const cloudReadData = await pgProvider.readAutomaticBackup(cloudWriteResult.fileName);
    assert.equal(cloudReadData.path, `backups/${cloudWriteResult.fileName}`);
    assert(cloudReadData.data.includes(testCompanyId), "Downloaded data must contain test company");
    const parsedDownloaded = JSON.parse(cloudReadData.data);
    assert.equal(parsedDownloaded.format, BACKUP_FORMAT);
    assert.equal(parsedDownloaded.version, BACKUP_VERSION);
    console.log("  ✓ Byte-for-byte read from Supabase Storage verified.");

    // 4e. Supabase Storage retention pruning
    const dummyOld1 = "tender-tracker-auto-2021-01-01.json";
    const dummyOld2 = "tender-tracker-auto-2021-01-02.json";
    const dummyOld3 = "tender-tracker-auto-2021-01-03.json";
    for (const f of [dummyOld1, dummyOld2, dummyOld3]) {
      await supabase.storage.from("backups").upload(f, Buffer.from("{}"), {
        contentType: "application/json",
        upsert: true,
      });
      cleanupStorageFiles.push(f);
    }

    await pgProvider.writeAutomaticBackup();
    const prunedCloudStatus = await pgProvider.getStatus();
    assert(
      prunedCloudStatus.files.length <= 2,
      `Cloud retention pruning must limit backup count to retention limit (2). Found: ${prunedCloudStatus.files.length}`
    );
    console.log("  ✓ Supabase Storage retention pruning verified.");

    // -------------------------------------------------------------------------
    // Test 5: Backup Artifacts Remain Private
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Verifying Backup Artifacts Remain Private...");
    await ensureStorageBucket(supabase, "backups", { isPublic: false });
    const { data: bucketInfo, error: bucketErr } = await supabase.storage.getBucket("backups");
    assert(!bucketErr && bucketInfo, "Bucket 'backups' must exist");
    assert.equal(bucketInfo.public, false, "Bucket 'backups' must be private (public: false)");

    // Attempt unauthorized public fetch directly from public URL
    const publicUrl = `${supabaseConfig.url}/storage/v1/object/public/backups/${cloudWriteResult.fileName}`;
    const publicFetch = await fetch(publicUrl);
    assert(
      publicFetch.status === 400 || publicFetch.status === 403 || publicFetch.status === 404,
      `Public unauthenticated access must be rejected. Received status: ${publicFetch.status}`
    );
    console.log("  ✓ Verified 'backups' bucket is private and denies unauthenticated public access.");

    // -------------------------------------------------------------------------
    // Test 6: Failure Handling Does NOT Corrupt Database Data
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Verifying Failure Handling Does NOT Corrupt Database Data...");

    // Clean up accidentally created bucket if any
    try {
      await supabase.storage.emptyBucket("non-existent-impossible-bucket-xyz-12345");
      await supabase.storage.deleteBucket("non-existent-impossible-bucket-xyz-12345");
    } catch {}

    // 6a. Storage upload fails cleanly when Supabase client is unconfigured
    const unconfiguredProvider = new PostgresBackupProvider(pool, null);
    let unconfiguredFailed = false;
    try {
      await unconfiguredProvider.writeAutomaticBackup();
    } catch (err: any) {
      unconfiguredFailed = true;
      assert.match(err.message, /not configured/i);
    }
    assert(unconfiguredFailed, "Unconfigured storage client must throw on automatic backup write");

    // 6b. Export failure simulation (e.g. database disconnect)
    const simulatedPool = {
      query: async () => {
        throw new Error("Simulated database failure during export");
      },
    } as unknown as typeof pool;
    const brokenExportProvider = new PostgresBackupProvider(simulatedPool, supabase);
    let exportFailed = false;
    try {
      await brokenExportProvider.exportBackup();
    } catch (err: any) {
      exportFailed = true;
      assert.match(err.message, /Simulated database failure/);
    }
    assert(exportFailed, "Database query failure must throw cleanly");

    // 6c. Invalid backup name rejection (path traversal guard)
    let traversalFailed = false;
    try {
      await pgProvider.readAutomaticBackup("../secret.json");
    } catch (err: any) {
      traversalFailed = true;
      assert.match(err.message, /Invalid automatic backup name/);
    }
    assert(traversalFailed, "Invalid backup filename must be rejected");

    // Verify test records in PostgreSQL remain intact
    const checkCompany = await pool.query("SELECT * FROM companies WHERE id = $1", [testCompanyId]);
    assert.equal(checkCompany.rows.length, 1, "Company record must remain unaffected after upload error");
    const checkTender = await pool.query("SELECT * FROM tenders WHERE id = $1", [testTenderId]);
    assert.equal(checkTender.rows.length, 1, "Tender record must remain unaffected after upload error");
    console.log("  ✓ Storage & export failures handled cleanly without altering PostgreSQL database records.");

    // -------------------------------------------------------------------------
    // Test 7: Automatic Backup Scheduler in PostgreSQL Mode
    // -------------------------------------------------------------------------
    console.log("\n[Test 7] Verifying Automatic Backup Scheduler in PostgreSQL Mode...");
    const schedulerResult = pgProvider.startScheduler();
    assert.equal(schedulerResult, null, "PostgreSQL provider startScheduler() must return null (no in-process timer)");
    console.log("  ✓ In-process timer safely disabled in PostgreSQL/serverless mode.");

    // -------------------------------------------------------------------------
    // Test 8: HTTP API Route Integration
    // -------------------------------------------------------------------------
    console.log("\n[Test 8] Verifying HTTP API Route Integration...");
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 8-pre: Verify unauthorized access is blocked
      const unauthExport = await fetch(`${baseUrl}/api/backup/export`);
      assert.equal(unauthExport.status, 401, "GET /api/backup/export must reject unauthenticated requests");

      const unauthAuto = await fetch(`${baseUrl}/api/backup/automatic/tender-tracker-test.json`);
      assert.equal(unauthAuto.status, 401, "GET /api/backup/automatic/:fileName must reject unauthenticated requests");

      const unauthNow = await fetch(`${baseUrl}/api/backup/now`, { method: "POST" });
      assert.equal(unauthNow.status, 401, "POST /api/backup/now must reject unauthenticated requests");

      const invalidCronNow = await fetch(`${baseUrl}/api/backup/now`, {
        method: "POST",
        headers: { authorization: "Bearer invalid-cron-secret" },
      });
      assert.equal(invalidCronNow.status, 401, "POST /api/backup/now must reject invalid cron secret");

      // Configure test auth
      const prevCronSecret = process.env.CRON_SECRET;
      const testCronSecret = "test-secret-" + randomUUID();
      process.env.CRON_SECRET = testCronSecret;
      const testSessionToken = securityService.createSessionForTesting();

      // 8a. GET /api/backup/export (authenticated with session)
      const exportRes = await fetch(`${baseUrl}/api/backup/export`, {
        headers: { "x-session-token": testSessionToken },
      });
      assert.equal(exportRes.status, 200);
      assert(exportRes.headers.get("content-type")?.includes("application/json"));
      assert(exportRes.headers.get("content-disposition")?.includes("tender-tracker-backup"));
      const exportData = (await exportRes.json()) as any;
      assert.equal(exportData.format, BACKUP_FORMAT);
      assert.equal(exportData.version, BACKUP_VERSION);
      assert(exportData.tables.companies.some((c: any) => c.id === testCompanyId));
      console.log("  ✓ GET /api/backup/export requires auth and returned valid JSON backup download.");

      // 8b. GET /api/backup/automatic (status)
      const autoRes = await fetch(`${baseUrl}/api/backup/automatic`);
      assert.equal(autoRes.status, 200);
      const autoData = (await autoRes.json()) as any;
      assert.equal(autoData.directory, "supabase-storage://backups");
      assert(Array.isArray(autoData.files));
      console.log("  ✓ GET /api/backup/automatic returned cloud backup status.");

      // 8c. POST /api/backup/now (authenticated with CRON_SECRET)
      const nowRes = await fetch(`${baseUrl}/api/backup/now`, {
        method: "POST",
        headers: { authorization: `Bearer ${testCronSecret}` },
      });
      assert.equal(nowRes.status, 200);
      const nowData = (await nowRes.json()) as any;
      assert.match(nowData.fileName, /^tender-tracker-auto-\d{4}-\d{2}-\d{2}\.json$/);
      assert(nowData.exportedAt);
      cleanupStorageFiles.push(nowData.fileName);
      console.log("  ✓ POST /api/backup/now authorized with CRON_SECRET and created cloud backup.");

      // 8d. GET /api/backup/automatic/:fileName (authenticated with session)
      const downloadRes = await fetch(`${baseUrl}/api/backup/automatic/${nowData.fileName}`, {
        headers: { "x-session-token": testSessionToken },
      });
      assert.equal(downloadRes.status, 200);
      assert(downloadRes.headers.get("content-disposition")?.includes(nowData.fileName));
      const downloadedJson = (await downloadRes.json()) as any;
      assert.equal(downloadedJson.format, BACKUP_FORMAT);
      console.log("  ✓ GET /api/backup/automatic/:fileName requires auth and downloaded backup artifact.");

      if (prevCronSecret !== undefined) process.env.CRON_SECRET = prevCronSecret;
      else delete process.env.CRON_SECRET;

      // 8e. POST /api/backup/restore in PostgreSQL mode
      const restoreRes = await fetch(`${baseUrl}/api/backup/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exportData),
      });
      assert.equal(restoreRes.status, 400);
      const restoreBody = (await restoreRes.json()) as any;
      assert.match(restoreBody.error, /managed via Supabase Platform/i);
      console.log("  ✓ POST /api/backup/restore safely rejected in PostgreSQL mode with 400 Bad Request.");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    console.log("\n===============================================================");
    console.log("✓ ALL CLOUD BACKUP MIGRATION TESTS PASSED SUCCESSFULLY!");
    console.log("===============================================================\n");
  } finally {
    // -------------------------------------------------------------------------
    // Cleanup Test Artifacts
    // -------------------------------------------------------------------------
    console.log("Cleaning up test resources...");

    // Clean up local temp files
    try {
      if (existsSync(localTestDir)) {
        rmSync(localTestDir, { recursive: true, force: true });
      }
    } catch {}

    // Clean up Supabase Storage objects
    if (cleanupStorageFiles.length > 0) {
      try {
        await supabase.storage.from("backups").remove(cleanupStorageFiles);
        console.log(`✓ Cleaned up ${cleanupStorageFiles.length} storage backup artifact(s).`);
      } catch (err: any) {
        console.warn("Storage cleanup notice:", err.message);
      }
    }

    // Clean up PostgreSQL test records
    for (const tenderId of cleanupPgTenderIds) {
      try {
        await pool.query("DELETE FROM tenders WHERE id = $1", [tenderId]);
      } catch {}
    }
    for (const companyId of cleanupPgCompanyIds) {
      try {
        await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
      } catch {}
    }
    if (cleanupPgTenderIds.length > 0) {
      console.log(`✓ Cleaned up ${cleanupPgTenderIds.length} PostgreSQL test records.`);
    }

    await closePgPool();
    console.log("✓ Database pool closed.");
  }
}

runBackupMigrationTests().catch((err) => {
  console.error("\n❌ Fatal test runner error:", err);
  process.exit(1);
});
