import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { getPgPool, closePgPool, testPgConnection } from "../server/postgres";
import { getSupabaseClient, ensureStorageBucket, getSupabaseConfig } from "../server/supabase";
import {
  DocumentService,
  PgDocumentRepository,
  SupabaseDocumentStorage,
  DocumentValidationError,
} from "../server/document-service";
import { PgAuthorityRepository } from "../server/pg-authority-repository";

async function runStorageTests(): Promise<void> {
  console.log("===============================================================");
  console.log("Tender Tracker — Phase 2B Supabase Storage & Metadata Tests");
  console.log("===============================================================\n");

  // Step 0: Preflight checks
  const pgTest = await testPgConnection();
  if (!pgTest.ok) {
    console.error("❌ PostgreSQL connection failed:", pgTest.message);
    process.exit(1);
  }
  console.log("✓ PostgreSQL connected:", pgTest.details?.version);

  const supabaseConfig = getSupabaseConfig();
  if (!supabaseConfig.isConfigured) {
    console.error("❌ Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  console.log("✓ Supabase URL configured:", supabaseConfig.url);

  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error("❌ Failed to initialize Supabase client.");
    process.exit(1);
  }

  // Ensure documents bucket exists and is private
  await ensureStorageBucket(supabase, "documents", { isPublic: false });
  const { data: bucket, error: bucketErr } = await supabase.storage.getBucket("documents");
  assert(!bucketErr && bucket, "documents bucket must exist in Supabase");
  assert.equal(bucket.public, false, "documents bucket must be private (public: false)");
  console.log("✓ Supabase Storage 'documents' bucket verified (private).");

  const pool = getPgPool();
  const authorityRepo = new PgAuthorityRepository(pool);
  const docRepo = new PgDocumentRepository(pool);
  const docStorage = new SupabaseDocumentStorage(supabase, "documents");
  const docService = new DocumentService(docRepo, docStorage);

  const testRunId = `TEST-${Date.now()}`;
  let testAuthorityId: string | undefined = undefined;
  const createdDocIds: string[] = [];
  const createdStorageNames: string[] = [];

  try {
    // Create temporary test authority to link documents to
    const authority = await authorityRepo.create({
      name: `Storage Test Authority ${testRunId}`,
      zone: "Dhaka",
      contact: "storage-test@example.com",
    });
    testAuthorityId = authority.id;
    console.log(`✓ Created test authority with ID: ${testAuthorityId}`);

    // -------------------------------------------------------------------------
    // Test 1: Document Upload & Metadata Creation
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Testing Document metadata creation & Supabase Storage upload...");
    const sampleContent = `Test document payload for Phase 2B migration - ${testRunId} - ${randomUUID()}`;
    const sampleBuffer = Buffer.from(sampleContent, "utf-8");
    const sampleSha256 = createHash("sha256").update(sampleBuffer).digest("hex");
    const sampleBase64 = `data:text/plain;base64,${sampleBuffer.toString("base64")}`;

    const createdDoc = await docService.create({
      authorityId: testAuthorityId,
      fileName: "technical_spec.txt",
      mimeType: "text/plain",
      data: sampleBase64,
    });

    createdDocIds.push(createdDoc.id);

    // Verify metadata returned
    assert(createdDoc.id, "Document must have a generated ID");
    assert.equal(createdDoc.authorityId, testAuthorityId);
    assert.equal(createdDoc.fileName, "technical_spec.txt");
    assert.equal(createdDoc.mimeType, "text/plain");
    assert.equal(createdDoc.sizeBytes, sampleBuffer.length);
    assert.equal(createdDoc.sha256, sampleSha256);
    console.log("  ✓ Metadata returned from create() is valid.");

    // Verify metadata record in PostgreSQL
    const pgRecord = await docRepo.get(createdDoc.id);
    assert(pgRecord, "Metadata row must exist in PostgreSQL documents table");
    assert.equal(pgRecord.sha256, sampleSha256);
    assert.equal(pgRecord.sizeBytes, sampleBuffer.length);
    assert(pgRecord.storageName.endsWith(".txt"), "storageName must preserve extension");
    createdStorageNames.push(pgRecord.storageName);
    console.log(`  ✓ PostgreSQL documents table row verified (storageName: ${pgRecord.storageName}).`);

    // Verify binary object in Supabase Storage
    const { data: rawDownload, error: rawErr } = await supabase.storage
      .from("documents")
      .download(pgRecord.storageName);
    assert(!rawErr && rawDownload, "Binary object must exist in Supabase Storage bucket 'documents'");
    const rawDownloadedBuffer = Buffer.from(await rawDownload.arrayBuffer());
    assert.equal(rawDownloadedBuffer.toString("utf-8"), sampleContent);
    console.log("  ✓ Binary object verified in Supabase Storage.");

    // -------------------------------------------------------------------------
    // Test 2: Document Retrieval / Download
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Testing Document retrieval/download via DocumentService...");
    const readResult = await docService.read(createdDoc.id);
    assert(readResult, "read() must return item and bytes");
    assert.equal(readResult.item.id, createdDoc.id);
    assert.equal(readResult.item.fileName, "technical_spec.txt");
    assert.equal(readResult.bytes.toString("utf-8"), sampleContent);
    assert.equal(
      createHash("sha256").update(readResult.bytes).digest("hex"),
      sampleSha256
    );
    console.log("  ✓ Document retrieval/download verified byte-for-byte.");

    // -------------------------------------------------------------------------
    // Test 3: Document Listing
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Testing Document listing...");
    const listResult = await docService.list({ authorityId: testAuthorityId });
    assert.equal(listResult.length, 1);
    assert.equal(listResult[0].id, createdDoc.id);
    console.log("  ✓ Document listing by authorityId verified.");

    // -------------------------------------------------------------------------
    // Test 4: Missing Storage Object Handling (Safe 404, no crash)
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Testing Missing Storage Object handling...");
    // Create another document, then remove binary object from storage directly
    const tempContent = "Temp file to delete storage object out-of-band";
    const tempDoc = await docService.create({
      authorityId: testAuthorityId,
      fileName: "temp_ghost.txt",
      mimeType: "text/plain",
      data: `data:text/plain;base64,${Buffer.from(tempContent).toString("base64")}`,
    });
    createdDocIds.push(tempDoc.id);
    const tempPgRecord = (await docRepo.get(tempDoc.id))!;

    // Delete object out-of-band directly from Supabase Storage
    await supabase.storage.from("documents").remove([tempPgRecord.storageName]);

    // read() should return undefined safely without throwing an uncaught exception
    const missingRead = await docService.read(tempDoc.id);
    assert.equal(missingRead, undefined, "read() must return undefined when storage object is missing");
    console.log("  ✓ Missing storage object handled safely (returns undefined, no crash).");

    // Clean up temp ghost record
    await docRepo.delete(tempDoc.id);

    // -------------------------------------------------------------------------
    // Test 5: Storage/Metadata Consistency & Rollback on Failure
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Testing Storage/Metadata consistency & rollback on failure...");
    let caughtValidationError = false;
    try {
      await docService.create({
        tenderId: "non-existent-tender-id",
        fileName: "invalid_fk.txt",
        mimeType: "text/plain",
        data: `data:text/plain;base64,${Buffer.from("invalid fk").toString("base64")}`,
      });
    } catch (err: any) {
      caughtValidationError = true;
      assert(err instanceof DocumentValidationError);
    }
    assert(caughtValidationError, "Non-existent target must throw DocumentValidationError");
    console.log("  ✓ Target validation prevents orphaned storage objects.");

    // -------------------------------------------------------------------------
    // Test 6: Document Deletion
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Testing Document deletion...");
    const deleted = await docService.delete(createdDoc.id);
    assert.equal(deleted, true, "delete() should return true on successful deletion");

    // Verify metadata row is deleted from PostgreSQL
    const postDeletePg = await docRepo.get(createdDoc.id);
    assert.equal(postDeletePg, undefined, "Metadata row must be removed from PostgreSQL");
    console.log("  ✓ PostgreSQL metadata row removed.");

    // Verify binary object is removed from Supabase Storage
    const { data: postDeleteDownload, error: postDeleteErr } = await supabase.storage
      .from("documents")
      .download(pgRecord.storageName);
    assert(
      postDeleteErr || !postDeleteDownload,
      "Binary object must be removed from Supabase Storage"
    );
    console.log("  ✓ Supabase Storage binary object removed.");

    // Calling delete again should return false (idempotent / not found)
    const deleteAgain = await docService.delete(createdDoc.id);
    assert.equal(deleteAgain, false, "Subsequent delete() must return false");
    console.log("  ✓ Subsequent delete() returns false as expected.");

    console.log("\n===============================================================");
    console.log("✓ ALL SUPABASE STORAGE & METADATA TESTS PASSED SUCCESSFULLY!");
    console.log("===============================================================\n");
  } finally {
    // Cleanup any lingering artifacts
    console.log("Cleaning up test resources...");
    for (const docId of createdDocIds) {
      await docRepo.delete(docId).catch(() => {});
    }
    for (const storageName of createdStorageNames) {
      await supabase.storage.from("documents").remove([storageName]).catch(() => {});
    }
    if (testAuthorityId) {
      await authorityRepo.delete(testAuthorityId).catch(() => {});
      console.log(`✓ Cleaned up test authority ${testAuthorityId}`);
    }
    await closePgPool();
    console.log("✓ PostgreSQL connection pool closed.");
  }
}

runStorageTests().catch((err) => {
  console.error("\n❌ Fatal test runner error:", err);
  process.exit(1);
});
