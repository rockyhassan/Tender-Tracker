import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app } from "../server";
import { getPgPool, closePgPool } from "../server/postgres";
import { PgAuthorityRepository } from "../server/pg-authority-repository";
import { getSupabaseClient } from "../server/supabase";

async function testHttpEndpoints(): Promise<void> {
  console.log("===============================================================");
  console.log("Tender Tracker — Phase 2B Document HTTP API Integration Tests");
  console.log("===============================================================\n");

  const pool = getPgPool();
  const authorityRepo = new PgAuthorityRepository(pool);
  const supabase = getSupabaseClient();
  assert(supabase, "Supabase client must be configured");

  // Create temporary authority
  const authority = await authorityRepo.create({
    name: `API Test Auth ${Date.now()}`,
    zone: "Chittagong",
    contact: "api-test@example.com",
  });
  console.log(`✓ Created test authority for API test: ${authority.id}`);

  // Start Express server on random port
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✓ Express server listening on ${baseUrl}`);

  let uploadedDocId = "";
  let uploadedStorageName = "";

  try {
    // 1. POST /api/documents
    console.log("\n[API Test 1] POST /api/documents");
    const payload = {
      authorityId: authority.id,
      fileName: "api_uploaded_document.pdf",
      mimeType: "application/pdf",
      data: `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test binary stream").toString("base64")}`,
    };

    const postRes = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.equal(postRes.status, 201, "POST /api/documents must return 201 Created");
    const postData = (await postRes.json()) as any;
    assert.equal(postData.fileName, "api_uploaded_document.pdf");
    assert.equal(postData.mimeType, "application/pdf");
    assert.equal(postData.authorityId, authority.id);
    uploadedDocId = postData.id;
    console.log(`  ✓ Document uploaded successfully (ID: ${uploadedDocId})`);

    // Verify storage object in Supabase
    const pgCheck = await pool.query("SELECT * FROM documents WHERE id = $1", [uploadedDocId]);
    assert.equal(pgCheck.rows.length, 1);
    uploadedStorageName = pgCheck.rows[0].storage_name;
    const { data: supaObj, error: supaErr } = await supabase.storage.from("documents").download(uploadedStorageName);
    assert(!supaErr && supaObj, "Binary must be in Supabase Storage 'documents' bucket");
    console.log(`  ✓ Binary confirmed in Supabase Storage (${uploadedStorageName})`);

    // 2. GET /api/documents?authorityId=...
    console.log("\n[API Test 2] GET /api/documents?authorityId=...");
    const listRes = await fetch(`${baseUrl}/api/documents?authorityId=${encodeURIComponent(authority.id)}`);
    assert.equal(listRes.status, 200, "GET /api/documents must return 200 OK");
    const listData = (await listRes.json()) as any[];
    assert.equal(listData.length, 1);
    assert.equal(listData[0].id, uploadedDocId);
    console.log(`  ✓ Listed 1 document for authority`);

    // 3. GET /api/documents/:id/download
    console.log("\n[API Test 3] GET /api/documents/:id/download");
    const dlRes = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(uploadedDocId)}/download`);
    assert.equal(dlRes.status, 200, "Download route must return 200 OK");
    assert.equal(dlRes.headers.get("content-type"), "application/pdf");
    assert(dlRes.headers.get("content-disposition")?.includes("api_uploaded_document.pdf"));
    const dlText = await dlRes.text();
    assert.equal(dlText, "%PDF-1.4 test binary stream");
    console.log(`  ✓ Download streamed correct bytes with proper Content-Type & Content-Disposition`);

    // 4. Missing object handling (HTTP 404, not 500)
    console.log("\n[API Test 4] Missing object handling on download");
    const missingRes = await fetch(`${baseUrl}/api/documents/00000000-0000-0000-0000-000000000000/download`);
    assert.equal(missingRes.status, 404, "Non-existent document must return 404");
    console.log(`  ✓ Non-existent document ID returns 404`);

    // 5. DELETE /api/documents/:id
    console.log("\n[API Test 5] DELETE /api/documents/:id");
    const delRes = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(uploadedDocId)}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 204, "DELETE must return 204 No Content");

    // Verify gone from DB and Storage
    const pgAfter = await pool.query("SELECT * FROM documents WHERE id = $1", [uploadedDocId]);
    assert.equal(pgAfter.rows.length, 0, "Row must be deleted from PostgreSQL");
    const { data: supaAfter } = await supabase.storage.from("documents").download(uploadedStorageName);
    assert(!supaAfter, "Binary object must be removed from Supabase Storage");
    console.log(`  ✓ Verified document removed from PostgreSQL and Supabase Storage`);

    // 6. DELETE on non-existent document
    console.log("\n[API Test 6] DELETE non-existent document");
    const del404Res = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(uploadedDocId)}`, {
      method: "DELETE",
    });
    assert.equal(del404Res.status, 404, "Subsequent DELETE must return 404");
    console.log(`  ✓ Subsequent DELETE returned 404`);

    console.log("\n===============================================================");
    console.log("✓ ALL HTTP API INTEGRATION TESTS PASSED SUCCESSFULLY!");
    console.log("===============================================================\n");
  } finally {
    server.close();
    await authorityRepo.delete(authority.id).catch(() => {});
    await closePgPool().catch(() => {});
  }
}

testHttpEndpoints().catch((err) => {
  console.error("❌ Fatal HTTP API test error:", err);
  process.exit(1);
});
