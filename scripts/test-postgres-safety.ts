import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPgPool, closePgPool, testPgConnection } from "../server/postgres";
import { PgTenderRepository } from "../server/pg-repository";
import { PgCompanyRepository } from "../server/company-repository";
import { PgLifecycleRepository } from "../server/pg-lifecycle-repository";
import { PgIssueBatchRepository, PgPurchaseSheetRepository } from "../server/pg-workflow-repository";
import { TenderService } from "../server/service";
import { LifecycleService } from "../server/lifecycle-service";
import { WorkflowService } from "../server/workflow-service";
import { PgAuthorityRepository } from "../server/pg-authority-repository";

async function runPgTests() {
  console.log("=== Starting Comprehensive PostgreSQL Repository & Safety Tests ===");

  const connTest = await testPgConnection();
  if (!connTest.ok) {
    console.error("PostgreSQL connection failed:", connTest.message);
    process.exit(1);
  }
  console.log("✓ Connected to PostgreSQL (Supabase):", connTest.details?.version);

  const pool = getPgPool();
  const tenderRepo = new PgTenderRepository(pool);
  const companyRepo = new PgCompanyRepository(pool);
  const lifecycleRepo = new PgLifecycleRepository(pool, tenderRepo);
  const batchRepo = new PgIssueBatchRepository(pool);
  const sheetRepo = new PgPurchaseSheetRepository(pool);
  const authorityRepo = new PgAuthorityRepository(pool);

  const lifecycleService = new LifecycleService(lifecycleRepo);
  const tenderService = new TenderService(tenderRepo, lifecycleService, batchRepo);
  const workflowService = new WorkflowService(batchRepo, sheetRepo, tenderRepo, authorityRepo);

  const testTag = `PGTEST-${Date.now()}`;
  const createdTenderIds: string[] = [];
  const createdBatchIds: string[] = [];
  const createdSheetIds: string[] = [];
  const createdAuthorityIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // 1. Normal Tender CRUD
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Verifying Normal Tender CRUD on PostgreSQL...");
    const t1 = await tenderRepo.create({
      tenderId: `${testTag}-T1`,
      company: "Apex Engineering Ltd.",
      authority: "RHD",
      packageName: "PG CRUD Test Package",
      closingAt: new Date(Date.now() + 86400000).toISOString(),
      tenderValue: 1250000,
      stage: "New",
      status: "Active",
    });
    createdTenderIds.push(t1.id);

    assert(t1.id, "Created tender must have an id");
    assert.equal(t1.tenderId, `${testTag}-T1`);
    assert.equal(t1.tenderValue, 1250000);
    assert.equal(t1.company, "Apex Engineering Ltd.");

    // Read by id
    const fetched = await tenderRepo.findById(t1.id);
    assert(fetched, "Tender must be found by id");
    assert.equal(fetched.tenderId, `${testTag}-T1`);
    assert.equal(fetched.tenderValue, 1250000);

    // Update
    const updated = await tenderRepo.update(t1.id, {
      packageName: "Updated PG CRUD Package",
      tenderValue: 1350000,
      stage: "Purchased",
    });
    assert(updated, "Update must succeed");
    assert.equal(updated.packageName, "Updated PG CRUD Package");
    assert.equal(updated.tenderValue, 1350000);
    assert.equal(updated.stage, "Purchased");

    // List includes t1
    const list = await tenderRepo.list();
    assert(list.some((item) => item.id === t1.id), "List must contain newly created tender");
    console.log("✓ Test 1 passed: Normal Tender CRUD functions correctly on PostgreSQL.");

    // -------------------------------------------------------------------------
    // 2. Company Case-Insensitive Reuse (A-2)
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Verifying Company Case-Insensitive Reuse (A-2)...");
    const t2 = await tenderRepo.create({
      tenderId: `${testTag}-T2`,
      company: "apex engineering ltd.", // lowercase variation
      authority: "LGED",
      packageName: "A2 Test Package 2",
      closingAt: new Date(Date.now() + 86400000).toISOString(),
      stage: "New",
      status: "Active",
    });
    createdTenderIds.push(t2.id);

    const t3 = await tenderRepo.create({
      tenderId: `${testTag}-T3`,
      company: "  APEX ENGINEERING LTD.  ", // uppercase + whitespace variation
      authority: "BWDB",
      packageName: "A2 Test Package 3",
      closingAt: new Date(Date.now() + 86400000).toISOString(),
      stage: "New",
      status: "Active",
    });
    createdTenderIds.push(t3.id);

    assert.equal(t1.companyId, t2.companyId, "t2 must reuse existing companyId of t1");
    assert.equal(t1.companyId, t3.companyId, "t3 must reuse existing companyId of t1");

    // Check companies table directly via companyRepo
    const companies = await companyRepo.list();
    const matches = companies.filter(
      (c) => c.name.toLowerCase() === "apex engineering ltd."
    );
    assert.equal(matches.length, 1, "Exactly one master record in companies table for Apex Engineering Ltd.");
    console.log("✓ Test 2 passed: A-2 Case-insensitive company reuse verified on PostgreSQL.");

    // -------------------------------------------------------------------------
    // 3. Lifecycle Single Milestone Unique Constraint & Upsert (A-3)
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Verifying Single Milestone UNIQUE(tender_id) & Upsert (A-3)...");

    // Result upsert
    const r1 = await lifecycleRepo.upsertResult(t1.id, {
      outcome: "Lost",
      remarks: "Initial outcome",
    });
    assert.equal(r1.outcome, "Lost");

    const r2 = await lifecycleRepo.upsertResult(t1.id, {
      outcome: "Won",
      quotedAmount: 1300000,
      remarks: "Updated outcome to Won",
    });
    assert.equal(r2.outcome, "Won");
    assert.equal(r2.quotedAmount, 1300000);
    const countResults = await tenderRepo.countResults(t1.id);
    assert.equal(countResults, 1, "Must have exactly 1 Result row in DB for tender t1");

    // Direct DB conflict test: Attempting raw INSERT on results with same tender_id must fail unique constraint
    let directConflictFailed = false;
    try {
      await pool.query(
        "INSERT INTO results (id, tender_id, outcome, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())",
        [randomUUID(), t1.id, "Lost"]
      );
    } catch (err: any) {
      directConflictFailed = true;
      assert(err.message.includes("unique") || err.code === "23505", "Must trigger unique constraint violation");
    }
    assert(directConflictFailed, "Direct duplicate INSERT must be rejected by PostgreSQL UNIQUE(tender_id)");

    // NOA upsert
    const noa1 = await lifecycleRepo.upsertNoa(t1.id, {
      noaNumber: "NOA-PG-001",
      issuedAt: new Date().toISOString(),
      contractValue: 1280000,
    });
    assert.equal(noa1.noaNumber, "NOA-PG-001");

    const noa2 = await lifecycleRepo.upsertNoa(t1.id, {
      noaNumber: "NOA-PG-001-REV",
      issuedAt: new Date().toISOString(),
      contractValue: 1290000,
    });
    assert.equal(noa2.noaNumber, "NOA-PG-001-REV");
    const countNoa = await tenderRepo.countNoa(t1.id);
    assert.equal(countNoa, 1, "Must have exactly 1 NOA row in DB for tender t1");

    // Performance Security upsert
    const ps1 = await lifecycleRepo.upsertSecurity(t1.id, {
      securityNumber: "PS-PG-001",
      amount: 129000,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 31536000000).toISOString(),
    });
    assert.equal(ps1.securityNumber, "PS-PG-001");

    const ps2 = await lifecycleRepo.upsertSecurity(t1.id, {
      securityNumber: "PS-PG-001-EXT",
      amount: 130000,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 31536000000).toISOString(),
    });
    assert.equal(ps2.securityNumber, "PS-PG-001-EXT");
    const countPS = await tenderRepo.countPerformanceSecurities(t1.id);
    assert.equal(countPS, 1, "Must have exactly 1 Performance Security row in DB for tender t1");

    // Contract Agreement upsert
    const ca1 = await lifecycleRepo.upsertContractAgreement(t1.id, {
      contractNumber: "CA-PG-001",
      signedAt: new Date().toISOString(),
      contractValue: 1290000,
    });
    assert.equal(ca1.contractNumber, "CA-PG-001");

    const ca2 = await lifecycleRepo.upsertContractAgreement(t1.id, {
      contractNumber: "CA-PG-001-FINAL",
      signedAt: new Date().toISOString(),
      contractValue: 1290000,
    });
    assert.equal(ca2.contractNumber, "CA-PG-001-FINAL");
    const countCA = await tenderRepo.countContractAgreements(t1.id);
    assert.equal(countCA, 1, "Must have exactly 1 Contract Agreement row in DB for tender t1");

    console.log("✓ Test 3 passed: A-3 Single milestone UNIQUE(tender_id) & upserts verified on PostgreSQL.");

    // -------------------------------------------------------------------------
    // 4. Tender Deletion Dependency Guard (A-1)
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Verifying Tender Deletion Dependency Guard (A-1)...");
    let deleteThrew = false;
    try {
      await tenderRepo.delete(t1.id);
    } catch (err: any) {
      deleteThrew = true;
      assert.match(err.message, /Cannot delete tender: it has a recorded evaluation result/i);
    }
    assert(deleteThrew, "Tender with child records must not be deleted");

    const checkExists = await tenderRepo.findById(t1.id);
    assert(checkExists, "Tender t1 must still exist after blocked deletion attempt");
    console.log("✓ Test 4 passed: A-1 Tender Deletion Guard blocked deletion of tender with dependent milestones.");

    // -------------------------------------------------------------------------
    // 5. Issue Batch CRUD
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Verifying Issue Batch CRUD on PostgreSQL...");
    const testAuth = await authorityRepo.create({
      name: `PG Safety Auth ${testTag}`,
      zone: "Dhaka Metro",
    });
    createdAuthorityIds.push(testAuth.id);
    const batch = await batchRepo.create({
      issueDate: new Date().toISOString().slice(0, 10),
      authorityId: testAuth.id,
      authorityZone: "Dhaka Metro",
      reference: `${testTag}-BATCH`,
      status: "Draft",
    });
    createdBatchIds.push(batch.id);

    assert(batch.id, "Batch must have an id");
    assert.equal(batch.reference, `${testTag}-BATCH`);

    const fetchedBatch = await batchRepo.findById(batch.id);
    assert(fetchedBatch, "Batch must be retrievable by id");
    assert.equal(fetchedBatch.reference, `${testTag}-BATCH`);

    const updatedBatch = await batchRepo.update(batch.id, {
      notes: "Updated batch notes for PG test",
      status: "Issued",
    });
    assert(updatedBatch, "Updated batch must be returned");
    assert.equal(updatedBatch.status, "Issued");
    assert.equal(updatedBatch.notes, "Updated batch notes for PG test");
    console.log("✓ Test 5 passed: Issue Batch CRUD verified on PostgreSQL.");

    // -------------------------------------------------------------------------
    // 6. Purchase Sheet CRUD & Duplicate Tender Protection (A-4)
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Verifying Purchase Sheet CRUD & A-4 Duplicate Assignment Protection...");

    // Create two new standalone tenders for this batch
    const batchTenderA = await tenderRepo.create({
      tenderId: `${testTag}-BA`,
      company: "Company Alpha",
      authority: "RHD",
      packageName: "Batch Line Tender A",
      closingAt: new Date(Date.now() + 86400000).toISOString(),
      issueBatchId: batch.id,
      stage: "Purchase Pending",
      status: "Active",
    });
    createdTenderIds.push(batchTenderA.id);

    const batchTenderB = await tenderRepo.create({
      tenderId: `${testTag}-BB`,
      company: "Company Beta",
      authority: "RHD",
      packageName: "Batch Line Tender B",
      closingAt: new Date(Date.now() + 86400000).toISOString(),
      issueBatchId: batch.id,
      stage: "Purchase Pending",
      status: "Active",
    });
    createdTenderIds.push(batchTenderB.id);

    // Create Purchase Sheet 1 with batchTenderA and batchTenderB
    const sheet1 = await sheetRepo.create({
      issueBatchId: batch.id,
      sheetNumber: `PS-${testTag}-01`,
      status: "Draft",
      viewMode: "flat",
      selectedTenderIds: [batchTenderA.id, batchTenderB.id],
      lineAssignments: [
        { tenderId: batchTenderA.id, companyId: batchTenderA.companyId },
        { tenderId: batchTenderB.id, companyId: batchTenderB.companyId },
      ],
    });
    createdSheetIds.push(sheet1.id);

    assert.equal(sheet1.selectedTenderIds.length, 2);
    assert.equal(sheet1.lineAssignments?.length, 2);

    // Test A-4: Attempting to create Purchase Sheet 2 with batchTenderA (already assigned) must fail via workflowService
    let duplicateRejected = false;
    try {
      await workflowService.createSheet({
        issueBatchId: batch.id,
        sheetNumber: `PS-${testTag}-02`,
        selectedTenderIds: [batchTenderA.id], // duplicate assignment!
      });
    } catch (err: any) {
      duplicateRejected = true;
      const msg = err.issues ? err.issues.map((i: any) => i.message).join(" ") : err.message;
      assert.match(msg, /already assigned to/i);
    }
    assert(duplicateRejected, "Duplicate tender assignment to purchase sheet must be rejected (A-4)");

    // Sheet update
    const updatedSheet = await sheetRepo.update(sheet1.id, {
      status: "Purchased",
      purchaseAmount: 5000,
      paymentMethod: "Bank Pay Order",
    });
    assert(updatedSheet, "Updated sheet must be returned");
    assert.equal(updatedSheet.status, "Purchased");
    assert.equal(updatedSheet.purchaseAmount, 5000);

    // Sheet deletion
    await sheetRepo.delete(sheet1.id);
    const checkDeletedSheet = await sheetRepo.findById(sheet1.id);
    assert.equal(checkDeletedSheet, undefined, "Deleted sheet must not be found");
    // Remove from cleanup array since already deleted
    const sheetIdx = createdSheetIds.indexOf(sheet1.id);
    if (sheetIdx >= 0) createdSheetIds.splice(sheetIdx, 1);

    console.log("✓ Test 6 passed: Purchase Sheet CRUD and A-4 duplicate assignment protection verified on PostgreSQL.");

  } finally {
    // -------------------------------------------------------------------------
    // Cleanup test records cleanly
    // -------------------------------------------------------------------------
    console.log("\n[Cleanup] Cleaning up PostgreSQL test records...");
    for (const sheetId of createdSheetIds) {
      try {
        await pool.query("DELETE FROM purchase_sheet_lines WHERE purchase_sheet_id = $1", [sheetId]);
        await pool.query("DELETE FROM purchase_sheets WHERE id = $1", [sheetId]);
      } catch {}
    }
    for (const tenderId of createdTenderIds) {
      try {
        await pool.query("DELETE FROM results WHERE tender_id = $1", [tenderId]);
        await pool.query("DELETE FROM noa WHERE tender_id = $1", [tenderId]);
        await pool.query("DELETE FROM performance_securities WHERE tender_id = $1", [tenderId]);
        await pool.query("DELETE FROM contract_agreements WHERE tender_id = $1", [tenderId]);
        await pool.query("DELETE FROM pay_orders WHERE tender_id = $1", [tenderId]);
        await pool.query("DELETE FROM charges WHERE tender_id = $1", [tenderId]);
        await pool.query("DELETE FROM credit_commitment_certificates WHERE tender_id = $1", [tenderId]);
        await pool.query("DELETE FROM tenders WHERE id = $1", [tenderId]);
      } catch {}
    }
    for (const batchId of createdBatchIds) {
      try {
        await pool.query("DELETE FROM issue_batches WHERE id = $1", [batchId]);
      } catch {}
    }
    for (const authId of createdAuthorityIds) {
      try {
        await pool.query("DELETE FROM authorities WHERE id = $1", [authId]);
      } catch {}
    }
    await closePgPool();
    console.log("✓ Cleanup completed.");
  }

  console.log("\n=======================================================");
  console.log("ALL POSTGRESQL REPOSITORY & SAFETY TESTS PASSED!");
  console.log("=======================================================\n");
}

runPgTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
