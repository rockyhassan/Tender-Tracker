import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  closePgPool,
  getPgConfig,
  getPgPool,
  getSanitizedPgConfig,
  SUPABASE_TRANSACTION_POOLER_PORT,
  DIRECT_POSTGRES_PORT,
  testPgConnection,
} from "../server/postgres";
import { applyPostgresSchema, verifyPostgresSchema } from "../server/pg-schema";

// Simple zero-dependency .env loader for scripts
function loadEnvFile(): void {
  const envFiles = [".env.local", ".env"];

  for (const filename of envFiles) {
    const envPath = resolve(process.cwd(), filename);
    if (!existsSync(envPath)) continue;

    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();

  console.log("=======================================================");
  console.log("Tender Tracker — PostgreSQL Connectivity Verification");
  console.log("=======================================================\n");

  const sanitized = getSanitizedPgConfig();
  console.log("Configuration Summary:");
  console.log(`- Connection Mode : ${sanitized.connectionMode}`);
  console.log(`- Target Host     : ${sanitized.host ?? "(not specified)"}`);
  console.log(`- Target Port     : ${sanitized.port ?? "(not specified)"}`);
  console.log(`- Target Database : ${sanitized.database ?? "(not specified)"}`);
  console.log(`- Username        : ${sanitized.user ?? "(not specified)"}`);
  console.log(`- SSL Enabled     : ${sanitized.ssl}`);
  console.log(`- Max Connections : ${sanitized.maxConnections}`);
  console.log(`- Supabase Host   : ${sanitized.isSupabase ? "Yes" : "No"}`);
  console.log(`- Pooler Port     : ${sanitized.isTransactionPoolerPort ? "Yes (6543)" : "No"}`);

  if (sanitized.warning) {
    console.log(`\n⚠️  WARNING: ${sanitized.warning}`);
  }

  if (sanitized.connectionMode === "unconfigured") {
    console.log("\n❌ PostgreSQL connection credentials are not configured.");
    console.log("\nRequired Environment Variables:");
    console.log("  DATABASE_URL - Supabase Transaction Pooler URI (port 6543)");
    console.log("  e.g.: postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres");
    console.log("\nAlternatively, provide discrete variables:");
    console.log("  PGHOST, PGPORT (6543 for Supabase pooler), PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE=require");
    console.log("\nApplication continues running seamlessly on SQLite.");
    process.exit(0);
  }

  console.log("\nConnecting to PostgreSQL...");
  const pool = getPgPool();

  try {
    const testResult = await testPgConnection(pool);

    if (!testResult.ok) {
      console.error(`\n❌ Connectivity test failed: ${testResult.message}`);
      if (testResult.details) {
        console.error("Details:", JSON.stringify(testResult.details, null, 2));
      }
      process.exitCode = 1;
      return;
    }

    console.log("\n✓ SUCCESS: Connected to PostgreSQL!");
    console.log(`  - Server Time : ${testResult.details?.serverTime}`);
    console.log(`  - PG Version  : ${testResult.details?.version}`);
    console.log(`  - Query Time  : ${testResult.details?.durationMs}ms`);

    if (sanitized.isSupabase && sanitized.port === DIRECT_POSTGRES_PORT) {
      console.log(`\n⚠️  WARNING: Connection succeeded on direct port ${DIRECT_POSTGRES_PORT}.`);
      console.log(`   For production deployment, switch to Transaction Pooler port ${SUPABASE_TRANSACTION_POOLER_PORT}.`);
    }

    const args = process.argv.slice(2);
    if (args.includes("--apply-schema")) {
      console.log("\nApplying Tender Tracker 18-table schema to PostgreSQL...");
      const schemaResult = await applyPostgresSchema(pool);
      console.log(`✓ Schema applied successfully. Existing tables: ${schemaResult.existingTables.length} / ${schemaResult.tablesChecked.length}`);
    } else {
      const schemaCheck = await verifyPostgresSchema(pool);
      console.log(`\nSchema Status in Database:`);
      console.log(`  - Foundation Tables Present : ${schemaCheck.existingTables.length} / ${schemaCheck.tablesChecked.length}`);
      if (schemaCheck.missingTables.length > 0) {
        console.log(`  - Tables Pending Creation   : ${schemaCheck.missingTables.join(", ")}`);
        console.log(`  (Run with --apply-schema to initialize the 18 foundation tables)`);
      } else {
        console.log(`  ✓ All 18 foundation tables are present and verified in PostgreSQL.`);
      }
    }
  } catch (error: any) {
    console.error("\n❌ Unexpected error during verification:", error.message);
    process.exitCode = 1;
  } finally {
    console.log("\nClosing connection pool...");
    await closePgPool();
    console.log("✓ Connection pool closed cleanly.");
  }
}

main().catch((err) => {
  console.error("Fatal verification error:", err);
  process.exit(1);
});
