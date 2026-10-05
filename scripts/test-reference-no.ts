import assert from "node:assert/strict";
import { openTenderDatabase } from "../server/database";
import { SqliteTenderRepository } from "../server/repository";
import { testPgConnection, getPgPool, closePgPool } from "../server/postgres";
import { PgTenderRepository } from "../server/pg-repository";
import { applyPostgresSchema } from "../server/pg-schema";

async function runReferenceNoTests() {
  console.log("=================================================");
  console.log("Running Reference No. Verification Tests");
  console.log("=================================================");

  // ---------------------------------------------------------------------------
  // 1. SQLite In-Memory & Local Path Persistence Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- [Section 1] SQLite Repository Tests ---");
  const sqliteDb = openTenderDatabase({ path: ":memory:" });
  const sqliteRepo = new SqliteTenderRepository({ database: sqliteDb });

  // 1a. Create tender with Reference No.
  console.log("1a. Creating tender with Reference No. in SQLite...");
  const t1 = sqliteRepo.create({
    tenderId: "SQLITE-REF-001",
    referenceNo: "EGP-REF-2026-9999",
    company: "Test Co 1",
    authority: "RHD",
    packageName: "Test Package 1",
    closingAt: new Date(Date.now() + 86400000).toISOString(),
    stage: "New",
    status: "Active",
  });
  assert(t1.id, "t1 has id");
  assert.equal(t1.tenderId, "SQLITE-REF-001");
  assert.equal(t1.referenceNo, "EGP-REF-2026-9999", "referenceNo is preserved on create");

  // Read back from SQLite
  const readT1 = sqliteRepo.findById(t1.id);
  assert(readT1, "readT1 exists");
  assert.equal(readT1.referenceNo, "EGP-REF-2026-9999", "referenceNo persisted in SQLite");

  // 1b. Create tender without Reference No.
  console.log("1b. Creating tender without Reference No. in SQLite...");
  const t2 = sqliteRepo.create({
    tenderId: "SQLITE-REF-002",
    company: "Test Co 2",
    authority: "LGED",
    packageName: "Test Package 2",
    closingAt: new Date(Date.now() + 86400000).toISOString(),
    stage: "New",
    status: "Active",
  });
  assert(t2.id, "t2 has id");
  assert.equal(t2.tenderId, "SQLITE-REF-002");
  assert.equal(t2.referenceNo, null, "referenceNo defaults to null when not provided");

  const readT2 = sqliteRepo.findById(t2.id);
  assert(readT2, "readT2 exists");
  assert.equal(readT2.referenceNo, null, "referenceNo read back as null");

  // 1c. Update Reference No. (set, update, clear)
  console.log("1c. Updating Reference No. in SQLite...");
  const updatedT2 = sqliteRepo.update(t2.id, { referenceNo: "EGP-REF-ADDED-22" });
  assert(updatedT2, "updatedT2 is defined");
  assert.equal(updatedT2.referenceNo, "EGP-REF-ADDED-22", "referenceNo can be added via update");

  const readUpdatedT2 = sqliteRepo.findById(t2.id);
  assert(readUpdatedT2, "readUpdatedT2 exists");
  assert.equal(readUpdatedT2.referenceNo, "EGP-REF-ADDED-22", "updated referenceNo persisted");

  // Clear back to null
  const clearedT2 = sqliteRepo.update(t2.id, { referenceNo: null });
  assert(clearedT2, "clearedT2 is defined");
  assert.equal(clearedT2.referenceNo, null, "referenceNo can be cleared to null");

  const readClearedT2 = sqliteRepo.findById(t2.id);
  assert(readClearedT2, "readClearedT2 exists");
  assert.equal(readClearedT2.referenceNo, null, "cleared referenceNo persisted as null");

  // 1d. Query & Filter by referenceNo and q
  console.log("1d. Query & filtering by referenceNo in SQLite...");
  const listByRef = sqliteRepo.list({ referenceNo: "EGP-REF-2026-9999" });
  assert.equal(listByRef.length, 1);
  assert.equal(listByRef[0].id, t1.id);

  const listByQ = sqliteRepo.list({ q: "2026-9999" });
  assert(listByQ.some((t) => t.id === t1.id), "q search finds tender by referenceNo in SQLite");

  // 1e. Bulk create with and without referenceNo
  console.log("1e. Bulk create with and without referenceNo in SQLite...");
  const bulkResult = sqliteRepo.createBulk([
    { tenderId: "BULK-1", referenceNo: "REF-B1", company: "C1", authority: "A1", packageName: "P1", closingAt: new Date().toISOString(), stage: "New", status: "Active" },
    { tenderId: "BULK-2", referenceNo: null, company: "C2", authority: "A2", packageName: "P2", closingAt: new Date().toISOString(), stage: "New", status: "Active" },
    { tenderId: "BULK-3", company: "C3", authority: "A3", packageName: "P3", closingAt: new Date().toISOString(), stage: "New", status: "Active" },
  ]);
  assert.equal(bulkResult[0].referenceNo, "REF-B1");
  assert.equal(bulkResult[1].referenceNo, null);
  assert.equal(bulkResult[2].referenceNo, null);

  console.log("✓ SQLite repository tests passed.");

  // ---------------------------------------------------------------------------
  // 2. PostgreSQL Repository Persistence Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- [Section 2] PostgreSQL Repository Tests ---");
  const pgConn = await testPgConnection();
  if (!pgConn.ok) {
    console.warn("⚠️ PostgreSQL not connected; skipping PostgreSQL repository tests.");
    return;
  }
  console.log("Connected to PostgreSQL:", pgConn.details?.version);

  const pool = getPgPool();
  // Ensure schema has reference_no column
  await applyPostgresSchema(pool);
  const pgRepo = new PgTenderRepository(pool);

  const testTag = `PG-REF-${Date.now()}`;
  const createdIds: string[] = [];

  try {
    // 2a. Create tender with Reference No. in PostgreSQL
    console.log("2a. Creating tender with Reference No. in PostgreSQL...");
    const pgT1 = await pgRepo.create({
      tenderId: `${testTag}-T1`,
      referenceNo: "EGP-PG-REF-1001",
      company: "PG Test Co 1",
      authority: "RHD",
      packageName: "PG Package 1",
      closingAt: new Date(Date.now() + 86400000).toISOString(),
      stage: "New",
      status: "Active",
    });
    createdIds.push(pgT1.id);
    assert(pgT1.id, "pgT1 has id");
    assert.equal(pgT1.tenderId, `${testTag}-T1`);
    assert.equal(pgT1.referenceNo, "EGP-PG-REF-1001", "PostgreSQL returns referenceNo on create");

    const readPgT1 = await pgRepo.findById(pgT1.id);
    assert(readPgT1, "readPgT1 found");
    assert.equal(readPgT1.referenceNo, "EGP-PG-REF-1001", "PostgreSQL persists referenceNo");

    // 2b. Create tender without Reference No. in PostgreSQL
    console.log("2b. Creating tender without Reference No. in PostgreSQL...");
    const pgT2 = await pgRepo.create({
      tenderId: `${testTag}-T2`,
      company: "PG Test Co 2",
      authority: "LGED",
      packageName: "PG Package 2",
      closingAt: new Date(Date.now() + 86400000).toISOString(),
      stage: "New",
      status: "Active",
    });
    createdIds.push(pgT2.id);
    assert(pgT2.id, "pgT2 has id");
    assert.equal(pgT2.tenderId, `${testTag}-T2`);
    assert.equal(pgT2.referenceNo, null, "PostgreSQL returns null for omitted referenceNo");

    const readPgT2 = await pgRepo.findById(pgT2.id);
    assert(readPgT2, "readPgT2 found");
    assert.equal(readPgT2.referenceNo, null, "PostgreSQL persists null referenceNo");

    // 2c. Update Reference No. in PostgreSQL
    console.log("2c. Updating Reference No. in PostgreSQL...");
    const updatedPgT2 = await pgRepo.update(pgT2.id, { referenceNo: "EGP-PG-REF-ADDED" });
    assert(updatedPgT2, "updatedPgT2 is defined");
    assert.equal(updatedPgT2.referenceNo, "EGP-PG-REF-ADDED", "PostgreSQL updates referenceNo");

    const readUpdatedPgT2 = await pgRepo.findById(pgT2.id);
    assert(readUpdatedPgT2, "readUpdatedPgT2 exists");
    assert.equal(readUpdatedPgT2.referenceNo, "EGP-PG-REF-ADDED", "PostgreSQL persisted updated referenceNo");

    // Clear referenceNo to null in PostgreSQL
    const clearedPgT2 = await pgRepo.update(pgT2.id, { referenceNo: null });
    assert(clearedPgT2, "clearedPgT2 is defined");
    assert.equal(clearedPgT2.referenceNo, null, "PostgreSQL clears referenceNo to null");

    const readClearedPgT2 = await pgRepo.findById(pgT2.id);
    assert(readClearedPgT2, "readClearedPgT2 exists");
    assert.equal(readClearedPgT2.referenceNo, null, "PostgreSQL persists cleared null referenceNo");

    // 2d. Filter and Search by referenceNo in PostgreSQL
    console.log("2d. Query & filtering by referenceNo in PostgreSQL...");
    const listPgByRef = await pgRepo.list({ referenceNo: "EGP-PG-REF-1001" });
    assert.equal(listPgByRef.length, 1);
    assert.equal(listPgByRef[0].id, pgT1.id);

    const listPgByQ = await pgRepo.list({ q: "REF-1001" });
    assert(listPgByQ.some((t) => t.id === pgT1.id), "PostgreSQL q search matches referenceNo");

    // 2e. Bulk create in PostgreSQL
    console.log("2e. Bulk create in PostgreSQL with and without referenceNo...");
    const pgBulk = await pgRepo.createBulk([
      { tenderId: `${testTag}-B1`, referenceNo: "PG-BULK-REF-1", company: "C1", authority: "A1", packageName: "P1", closingAt: new Date().toISOString(), stage: "New", status: "Active" },
      { tenderId: `${testTag}-B2`, company: "C2", authority: "A2", packageName: "P2", closingAt: new Date().toISOString(), stage: "New", status: "Active" },
    ]);
    for (const b of pgBulk) createdIds.push(b.id);
    assert.equal(pgBulk[0].referenceNo, "PG-BULK-REF-1");
    assert.equal(pgBulk[1].referenceNo, null);

    console.log("✓ PostgreSQL repository tests passed.");
  } finally {
    // Cleanup PostgreSQL test records
    for (const id of createdIds) {
      try { await pgRepo.delete(id); } catch { /* ignore */ }
    }
    await closePgPool();
    console.log("✓ PostgreSQL cleanup complete.");
  }

  console.log("\n=================================================");
  console.log("ALL REFERENCE NO. TESTS PASSED SUCCESSFULLY");
  console.log("=================================================");
}

runReferenceNoTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
