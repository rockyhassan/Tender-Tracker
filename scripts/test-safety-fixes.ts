import assert from "node:assert/strict";
import { openTenderDatabase } from "../server/database";
import { SqliteTenderRepository } from "../server/repository";
import { SqliteCompanyRepository } from "../server/company-repository";
import { LifecycleRepository } from "../server/lifecycle-repository";
import { TenderService } from "../server/service";
import { LifecycleService } from "../server/lifecycle-service";

async function runTests() {
  console.log("Starting focused pre-production safety tests (A-2 & A-3)...");

  const database = openTenderDatabase({ path: ":memory:" });
  const tenderRepo = new SqliteTenderRepository({ database });
  const companyRepo = new SqliteCompanyRepository(database);
  const lifecycleRepo = new LifecycleRepository(database, tenderRepo);
  const tenderService = new TenderService(tenderRepo);
  const lifecycleService = new LifecycleService(lifecycleRepo);

  // -------------------------------------------------------------------------
  // Test 1: Same company name does not create duplicate master companies (A-2)
  // -------------------------------------------------------------------------
  console.log("\n[Test 1] Verifying company master duplication prevention (A-2)...");

  // 1a: Create tender without companyId
  const tender1 = tenderRepo.create({
    tenderId: "T-SAFE-001",
    company: "Apex Engineering Ltd.",
    authority: "RHD",
    packageName: "Bridge Rehab Lot 1",
    closingAt: "2026-11-01T10:00:00.000Z",
    stage: "New",
    status: "Active",
  });
  assert(tender1.companyId, "tender1 must have a resolved companyId");
  const apexCompanyId = tender1.companyId;

  const companiesAfter1 = companyRepo.list();
  const apexMatches1 = companiesAfter1.filter(
    (c) => c.name.toLowerCase() === "apex engineering ltd."
  );
  assert.equal(apexMatches1.length, 1, "Exactly one master record for Apex Engineering Ltd.");
  assert.equal(apexMatches1[0].id, apexCompanyId);

  // 1b: Create tender 2 with lowercase company name and no companyId
  const tender2 = tenderRepo.create({
    tenderId: "T-SAFE-002",
    company: "apex engineering ltd.",
    authority: "LGED",
    packageName: "Rural Road Package 5",
    closingAt: "2026-11-02T10:00:00.000Z",
    stage: "New",
    status: "Active",
  });
  assert.equal(
    tender2.companyId,
    apexCompanyId,
    "tender2 with lowercase company name must resolve to existing master company ID"
  );

  // 1c: Create tender 3 with mixed case + whitespace and no companyId
  const tender3 = tenderRepo.create({
    tenderId: "T-SAFE-003",
    company: "  APEX ENGINEERING LTD.  ",
    authority: "BWDB",
    packageName: "Embankment Lot 2",
    closingAt: "2026-11-03T10:00:00.000Z",
    stage: "New",
    status: "Active",
  });
  assert.equal(
    tender3.companyId,
    apexCompanyId,
    "tender3 with mixed-case and whitespace must resolve to existing master company ID"
  );

  const companiesAfter3 = companyRepo.list();
  const apexMatches3 = companiesAfter3.filter(
    (c) => c.name.toLowerCase() === "apex engineering ltd."
  );
  assert.equal(
    apexMatches3.length,
    1,
    "Still exactly one master company record for Apex Engineering Ltd. after 3 creations"
  );

  // 1d: Preserve explicit companyId behavior
  const explicitCompanyId = "explicit-company-uuid-999";
  const tenderWithExplicit = tenderRepo.create({
    tenderId: "T-SAFE-004",
    company: "Apex Engineering Ltd.",
    companyId: explicitCompanyId,
    authority: "PWD",
    packageName: "Office Building Block B",
    closingAt: "2026-11-04T10:00:00.000Z",
    stage: "New",
    status: "Active",
  });
  assert.equal(
    tenderWithExplicit.companyId,
    explicitCompanyId,
    "Explicit companyId must be preserved exactly when provided"
  );

  // 1e: Bulk creation deduplication
  const bulkResult = tenderRepo.createBulk([
    {
      tenderId: "T-SAFE-BULK-1",
      company: "Summit Power Grid",
      authority: "BPDB",
      packageName: "Substation Upgrade 1",
      closingAt: "2026-11-05T10:00:00.000Z",
      stage: "New",
      status: "Active",
    },
    {
      tenderId: "T-SAFE-BULK-2",
      company: "summit power grid",
      authority: "BPDB",
      packageName: "Substation Upgrade 2",
      closingAt: "2026-11-06T10:00:00.000Z",
      stage: "New",
      status: "Active",
    },
  ]);
  assert.equal(bulkResult.length, 2);
  assert(bulkResult[0].companyId);
  assert.equal(
    bulkResult[0].companyId,
    bulkResult[1].companyId,
    "Bulk tenders with same company name case-insensitively must resolve to the same companyId"
  );
  const summitMatches = companyRepo.list().filter(
    (c) => c.name.toLowerCase() === "summit power grid"
  );
  assert.equal(summitMatches.length, 1, "Only one company record created for Summit Power Grid in bulk");

  // 1f: Direct company repository create deduplication
  const directCompany = companyRepo.create({ name: "Apex Engineering Ltd." });
  assert.equal(
    directCompany.id,
    apexCompanyId,
    "CompanyRepository.create without id must return existing company master record"
  );

  // 1g: Service-level creation resolves existing company
  const tenderFromService = await tenderService.create({
    tenderId: "T-SAFE-SRV-1",
    company: "apex engineering ltd.",
    authority: "RHD",
    packageName: "Service-level test package",
    closingAt: "2026-11-08T10:00:00.000Z",
    stage: "New",
    status: "Active",
  });
  assert.equal(
    tenderFromService.companyId,
    apexCompanyId,
    "TenderService.create must resolve to the existing company master record"
  );

  console.log("✓ Test 1 passed: Company master duplication prevented case-insensitively while preserving explicit companyId.");

  // -------------------------------------------------------------------------
  // Test 2: A second Result for the same Tender is blocked/upserted safely (A-3)
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] Verifying single milestone enforcement for Results (A-3)...");

  // 2a: Upsert first Result
  const res1 = lifecycleRepo.upsertResult(tender1.id, {
    outcome: "Won",
    announcedAt: "2026-11-10T12:00:00.000Z",
    resultDate: "2026-11-10T12:00:00.000Z",
    quotedAmount: 5_000_000,
    rank: 1,
    awardedCompany: "Apex Engineering Ltd.",
    remarks: "Initial evaluation win",
  });
  assert.equal(res1.outcome, "Won");
  assert.equal(tenderRepo.countResults(tender1.id), 1);

  // 2b: Direct duplicate insert is blocked by database UNIQUE constraint
  assert.throws(
    () => {
      database.prepare(`
        INSERT INTO results (id, tender_id, outcome, created_at, updated_at)
        VALUES ('raw-result-duplicate', ?, 'Lost', datetime('now'), datetime('now'))
      `).run(tender1.id);
    },
    /UNIQUE constraint failed/i,
    "Database constraint must block duplicate Result insert for the same tender_id"
  );
  assert.equal(tenderRepo.countResults(tender1.id), 1);

  // 2c: Repository upsert updates in place without creating a duplicate record
  const res2 = lifecycleRepo.upsertResult(tender1.id, {
    outcome: "Lost",
    quotedAmount: 5_200_000,
    rank: 2,
    remarks: "Post-audit correction",
  });
  assert.equal(res2.outcome, "Lost");
  assert.equal(res2.quotedAmount, 5_200_000);
  assert.equal(res2.remarks, "Post-audit correction");
  assert.equal(
    tenderRepo.countResults(tender1.id),
    1,
    "Result count must remain exactly 1 after upsert"
  );
  assert.equal(lifecycleRepo.result(tender1.id)?.outcome, "Lost");

  // 2d: Service-level upsert updates safely
  const resFromService = await lifecycleService.upsertResult(tender1.id, {
    outcome: "Won",
    remarks: "Restored win status via service",
  });
  assert.equal(resFromService.outcome, "Won");
  assert.equal(tenderRepo.countResults(tender1.id), 1);

  console.log("✓ Test 2 passed: Second Result blocked at DB constraint level and safely upserted via repository & service.");

  // -------------------------------------------------------------------------
  // Test 3: A second NOA is blocked/upserted safely (A-3)
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] Verifying single milestone enforcement for NOA (A-3)...");

  // 3a: Upsert first NOA
  const noa1 = lifecycleRepo.upsertNoa(tender1.id, {
    noaNumber: "NOA/2026/001",
    issuedAt: "2026-11-15T10:00:00.000Z",
    acceptanceDeadline: "2026-11-25T10:00:00.000Z",
    contractValue: 4_950_000,
    status: "Pending",
    remarks: "Initial NOA issue",
  });
  assert.equal(noa1.noaNumber, "NOA/2026/001");
  assert.equal(tenderRepo.countNoa(tender1.id), 1);

  // 3b: Direct duplicate insert is blocked by database UNIQUE constraint
  assert.throws(
    () => {
      database.prepare(`
        INSERT INTO noa (id, tender_id, noa_number, issued_at, status, created_at, updated_at)
        VALUES ('raw-noa-duplicate', ?, 'NOA/2026/002', datetime('now'), 'Pending', datetime('now'), datetime('now'))
      `).run(tender1.id);
    },
    /UNIQUE constraint failed/i,
    "Database constraint must block duplicate NOA insert for the same tender_id"
  );
  assert.equal(tenderRepo.countNoa(tender1.id), 1);

  // 3c: Repository upsert updates in place without creating a duplicate record
  const noa2 = lifecycleRepo.upsertNoa(tender1.id, {
    noaNumber: "NOA/2026/001-REV1",
    issuedAt: "2026-11-15T10:00:00.000Z",
    contractValue: 4_900_000,
    status: "Active",
    remarks: "Accepted by contractor",
  });
  assert.equal(noa2.noaNumber, "NOA/2026/001-REV1");
  assert.equal(noa2.contractValue, 4_900_000);
  assert.equal(noa2.status, "Active");
  assert.equal(
    tenderRepo.countNoa(tender1.id),
    1,
    "NOA count must remain exactly 1 after upsert"
  );
  assert.equal(lifecycleRepo.noa(tender1.id)?.noaNumber, "NOA/2026/001-REV1");

  // 3d: Service-level upsert updates safely
  const noaFromService = await lifecycleService.upsertNoa(tender1.id, {
    noaNumber: "NOA/2026/001-FINAL",
    issuedAt: "2026-11-15T10:00:00.000Z",
    contractValue: 4_950_000,
    status: "Completed",
  });
  assert.equal(noaFromService.noaNumber, "NOA/2026/001-FINAL");
  assert.equal(tenderRepo.countNoa(tender1.id), 1);

  console.log("✓ Test 3 passed: Second NOA blocked at DB constraint level and safely upserted via repository & service.");

  // -------------------------------------------------------------------------
  // Test 4: A second Performance Security is blocked/upserted safely (A-3)
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] Verifying single milestone enforcement for Performance Security (A-3)...");

  // 4a: Upsert first Performance Security
  const ps1 = lifecycleRepo.upsertSecurity(tender1.id, {
    securityNumber: "BG-SEC-2026-101",
    amount: 500_000,
    issuedAt: "2026-11-20T00:00:00.000Z",
    expiresAt: "2027-05-20T00:00:00.000Z",
    provider: "Dhaka Bank",
    status: "Active",
    remarks: "Original bank guarantee",
  });
  assert.equal(ps1.securityNumber, "BG-SEC-2026-101");
  assert.equal(tenderRepo.countPerformanceSecurities(tender1.id), 1);

  // 4b: Direct duplicate insert is blocked by database UNIQUE constraint
  assert.throws(
    () => {
      database.prepare(`
        INSERT INTO performance_securities (id, tender_id, security_number, amount, issued_at, expires_at, status, created_at, updated_at)
        VALUES ('raw-ps-duplicate', ?, 'BG-SEC-2026-102', 500000, datetime('now'), datetime('now'), 'Active', datetime('now'), datetime('now'))
      `).run(tender1.id);
    },
    /UNIQUE constraint failed/i,
    "Database constraint must block duplicate Performance Security insert for the same tender_id"
  );
  assert.equal(tenderRepo.countPerformanceSecurities(tender1.id), 1);

  // 4c: Repository upsert updates in place without creating a duplicate record
  const ps2 = lifecycleRepo.upsertSecurity(tender1.id, {
    securityNumber: "BG-SEC-2026-101-EXT",
    amount: 500_000,
    issuedAt: "2026-11-20T00:00:00.000Z",
    expiresAt: "2027-11-20T00:00:00.000Z",
    returnDate: "2027-11-25T00:00:00.000Z",
    returnStatus: "Returned",
    returnRemarks: "Released upon completion",
    provider: "Dhaka Bank",
    status: "Completed",
    remarks: "Extended and completed",
  });
  assert.equal(ps2.securityNumber, "BG-SEC-2026-101-EXT");
  assert.equal(ps2.status, "Completed");
  assert.equal(ps2.returnStatus, "Returned");
  assert.equal(
    tenderRepo.countPerformanceSecurities(tender1.id),
    1,
    "Performance Security count must remain exactly 1 after upsert"
  );
  assert.equal(lifecycleRepo.details(tender1.id)?.performanceSecurity?.securityNumber, "BG-SEC-2026-101-EXT");

  // 4d: Service-level upsert updates safely
  const psFromService = await lifecycleService.upsertSecurity(tender1.id, {
    securityNumber: "BG-SEC-2026-101-FINAL",
    amount: 500_000,
    issuedAt: "2026-11-20T00:00:00.000Z",
    expiresAt: "2027-11-20T00:00:00.000Z",
    status: "Completed",
  });
  assert.equal(psFromService.securityNumber, "BG-SEC-2026-101-FINAL");
  assert.equal(tenderRepo.countPerformanceSecurities(tender1.id), 1);

  console.log("✓ Test 4 passed: Second Performance Security blocked at DB constraint level and safely upserted via repository & service.");

  // -------------------------------------------------------------------------
  // Test 5: A second Contract Agreement is blocked/upserted safely (A-3)
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] Verifying single milestone enforcement for Contract Agreement (A-3)...");

  // 5a: Upsert first Contract Agreement
  const ca1 = lifecycleRepo.upsertContractAgreement(tender1.id, {
    contractNumber: "AGR/2026/044",
    signedAt: "2026-11-28T00:00:00.000Z",
    startDate: "2026-12-01T00:00:00.000Z",
    endDate: "2027-12-01T00:00:00.000Z",
    contractValue: 4_900_000,
    status: "Active",
    remarks: "Signed contract",
  });
  assert.equal(ca1.contractNumber, "AGR/2026/044");
  assert.equal(tenderRepo.countContractAgreements(tender1.id), 1);

  // 5b: Direct duplicate insert is blocked by database UNIQUE constraint
  assert.throws(
    () => {
      database.prepare(`
        INSERT INTO contract_agreements (id, tender_id, contract_number, signed_at, contract_value, status, created_at, updated_at)
        VALUES ('raw-ca-duplicate', ?, 'AGR/2026/045', datetime('now'), 4900000, 'Active', datetime('now'), datetime('now'))
      `).run(tender1.id);
    },
    /UNIQUE constraint failed/i,
    "Database constraint must block duplicate Contract Agreement insert for the same tender_id"
  );
  assert.equal(tenderRepo.countContractAgreements(tender1.id), 1);

  // 5c: Repository upsert updates in place without creating a duplicate record
  const ca2 = lifecycleRepo.upsertContractAgreement(tender1.id, {
    contractNumber: "AGR/2026/044-AMEND",
    signedAt: "2026-11-28T00:00:00.000Z",
    startDate: "2026-12-01T00:00:00.000Z",
    endDate: "2028-06-01T00:00:00.000Z",
    contractValue: 5_100_000,
    status: "Active",
    remarks: "Addendum 1 - time and cost extension",
  });
  assert.equal(ca2.contractNumber, "AGR/2026/044-AMEND");
  assert.equal(ca2.contractValue, 5_100_000);
  assert.equal(
    tenderRepo.countContractAgreements(tender1.id),
    1,
    "Contract Agreement count must remain exactly 1 after upsert"
  );
  assert.equal(lifecycleRepo.contractAgreement(tender1.id)?.contractNumber, "AGR/2026/044-AMEND");

  // 5d: Service-level upsert updates safely
  const caFromService = await lifecycleService.upsertContractAgreement(tender1.id, {
    contractNumber: "AGR/2026/044-FINAL",
    signedAt: "2026-11-28T00:00:00.000Z",
    contractValue: 5_200_000,
    status: "Completed",
  });
  assert.equal(caFromService.contractNumber, "AGR/2026/044-FINAL");
  assert.equal(tenderRepo.countContractAgreements(tender1.id), 1);

  console.log("✓ Test 5 passed: Second Contract Agreement blocked at DB constraint level and safely upserted via repository & service.");

  // Verify tender deletion guard (A-1) still protects against deleting tender with milestones
  console.log("\n[Sanity Check] Verifying A-1 Tender Deletion Guard remains intact...");
  assert.throws(
    () => tenderRepo.delete(tender1.id),
    /Cannot delete tender: it has a recorded evaluation result/i,
    "Tender with milestone records cannot be deleted"
  );
  console.log("✓ Sanity check passed: A-1 Tender Deletion Guard is intact.");

  console.log("\n=======================================================");
  console.log("ALL 5 SAFETY CHECKS PASSED SUCCESSFULLY!");
  console.log("=======================================================\n");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
