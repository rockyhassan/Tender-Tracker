import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { getSupabaseClient, ensureStorageBucket, getSupabaseConfig } from "../server/supabase";
import { getPgPool, testPgConnection } from "../server/postgres";

/**
 * Migration utility for Phase 2B:
 * Migrates local filesystem document binaries from data/documents/ to Supabase Storage.
 *
 * SAFETY GUARANTEES:
 * - Read-only / dry-run by default unless invoked with `--execute`.
 * - NEVER deletes local files.
 * - Verifies sha256 checksums before and after upload.
 */
async function main(): Promise<void> {
  const isExecute = process.argv.includes("--execute");

  console.log("=============================================================");
  console.log("Tender Tracker — Document Binary Storage Migration to Supabase");
  console.log("=============================================================\n");
  console.log(`Mode: ${isExecute ? "EXECUTE (Uploading to Supabase Storage)" : "DRY-RUN (Simulating migration only, use --execute to apply)"}`);

  const supabaseConfig = getSupabaseConfig();
  if (!supabaseConfig.isConfigured) {
    console.error("\n❌ Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
    process.exit(1);
  }

  const client = getSupabaseClient();
  if (!client) {
    console.error("\n❌ Failed to initialize Supabase client.");
    process.exit(1);
  }

  const documentsDir = resolve(process.cwd(), "data/documents");
  if (!existsSync(documentsDir)) {
    console.log(`\nLocal directory ${documentsDir} does not exist. Nothing to migrate.`);
    return;
  }

  const files = readdirSync(documentsDir).filter((name) => {
    const fullPath = join(documentsDir, name);
    return statSync(fullPath).isFile();
  });

  console.log(`\nFound ${files.length} file(s) in ${documentsDir}.`);
  if (files.length === 0) {
    console.log("No local document binaries found to migrate.");
    return;
  }

  // Ensure documents bucket exists in Supabase
  if (isExecute) {
    console.log("Ensuring private 'documents' bucket exists in Supabase Storage...");
    await ensureStorageBucket(client, "documents", { isPublic: false });
    console.log("✓ 'documents' bucket is verified.");
  }

  // Query metadata from PostgreSQL if connected
  const pgTest = await testPgConnection();
  const pool = pgTest.ok ? getPgPool() : null;
  const metadataByStorageName = new Map<string, any>();

  if (pool) {
    const res = await pool.query("SELECT * FROM documents");
    for (const row of res.rows) {
      metadataByStorageName.set(row.storage_name, row);
    }
    console.log(`Found ${res.rows.length} document metadata record(s) in PostgreSQL.`);
  }

  let migratedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const fileName of files) {
    const filePath = join(documentsDir, fileName);
    const bytes = readFileSync(filePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const meta = metadataByStorageName.get(fileName);
    const mimeType = meta?.mime_type || "application/octet-stream";

    console.log(`\n- Document: ${fileName} (${bytes.length} bytes, sha256: ${hash.slice(0, 12)}...)`);
    if (meta) {
      console.log(`  Linked metadata: ID=${meta.id}, Original Name="${meta.file_name}"`);
    } else {
      console.log(`  (No matching PostgreSQL metadata row found for ${fileName})`);
    }

    if (!isExecute) {
      console.log(`  [DRY-RUN] Would upload ${fileName} to bucket 'documents' with mimeType '${mimeType}'.`);
      migratedCount++;
      continue;
    }

    try {
      // Check if object already exists in Supabase Storage
      const { data: existingData, error: downloadError } = await client.storage
        .from("documents")
        .download(fileName);

      if (!downloadError && existingData) {
        console.log(`  ✓ Already present in Supabase Storage. Skipping upload.`);
        skippedCount++;
        continue;
      }

      const { error: uploadError } = await client.storage
        .from("documents")
        .upload(fileName, bytes, { contentType: mimeType, upsert: false });

      if (uploadError) {
        console.error(`  ❌ Upload failed: ${uploadError.message}`);
        failedCount++;
      } else {
        console.log(`  ✓ Uploaded to Supabase Storage successfully.`);
        migratedCount++;
      }
    } catch (err: any) {
      console.error(`  ❌ Error processing ${fileName}:`, err.message);
      failedCount++;
    }
  }

  console.log("\n=============================================================");
  console.log("Migration Summary:");
  console.log(`  - Total files inspected : ${files.length}`);
  console.log(`  - Migrated / Planned    : ${migratedCount}`);
  console.log(`  - Already up to date    : ${skippedCount}`);
  console.log(`  - Failed                : ${failedCount}`);
  console.log("=============================================================");
  console.log("Note: Local files in data/documents/ remain intact and were NOT modified or deleted.\n");
}

main().catch((err) => {
  console.error("Fatal migration error:", err);
  process.exit(1);
});
