import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "../server/postgres";

async function runDryRun() {
  console.log("===============================================================");
  console.log("Phase 4B — Production Start Dry-Run");
  console.log("===============================================================\n");

  // Step 1: Ensure dist/ exists (pnpm build output)
  console.log("[1/6] Checking production build artifacts...");
  const distIndexHtml = resolve(process.cwd(), "dist/index.html");
  assert(existsSync(distIndexHtml), "dist/index.html must exist before production start");
  const htmlContent = readFileSync(distIndexHtml, "utf-8");
  assert(htmlContent.includes("<div id=\"root\">"), "dist/index.html must contain root div");
  console.log("  ✓ dist/index.html found and verified.");

  // Step 2: Prepare production environment
  console.log("\n[2/6] Preparing production environment variables...");
  // Load local credentials into process.env before setting NODE_ENV=production
  loadEnvFile();

  const requiredVars = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  for (const v of requiredVars) {
    assert(process.env[v], `Missing required environment variable: ${v}`);
  }
  const dryRunPort = "8899";
  const testCronSecret = "dryrun-cron-secret-" + Date.now();

  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: "production",
    PORT: dryRunPort,
    CRON_SECRET: testCronSecret,
  };
  delete childEnv.USE_SQLITE;
  delete childEnv.TENDER_DRIVER;

  console.log("  ✓ Production environment configured (NODE_ENV=production, PORT=" + dryRunPort + ").");
  console.log("  ✓ SQLite overrides (USE_SQLITE, TENDER_DRIVER) explicitly absent.");

  // Step 3: Spawn production server process via `tsx server/index.ts`
  console.log("\n[3/6] Starting server via tsx server/index.ts in production mode...");
  const serverProc = spawn(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), resolve("server/index.ts")],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let serverStarted = false;
  let serverOutput = "";

  const startupPromise = new Promise<void>((resolvePromise, rejectPromise) => {
    serverProc.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      serverOutput += text;
      if (text.includes("Tender Tracker API listening on") && text.includes("PostgreSQL")) {
        serverStarted = true;
        resolvePromise();
      }
    });
    serverProc.stderr?.on("data", (chunk) => {
      serverOutput += chunk.toString();
    });
    serverProc.on("error", rejectPromise);
    serverProc.on("exit", (code) => {
      if (!serverStarted) {
        rejectPromise(new Error(`Server process exited prematurely with code ${code}. Output:\n${serverOutput}`));
      }
    });
  });

  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`Server failed to start within 15s. Output:\n${serverOutput}`)), 15000)
  );

  try {
    await Promise.race([startupPromise, timeout]);
    console.log("  ✓ Server successfully started and bound to port " + dryRunPort + " in PostgreSQL mode.");

    // Step 4: Verify API endpoints
    console.log("\n[4/6] Verifying API endpoints...");
    const baseUrl = `http://127.0.0.1:${dryRunPort}`;

    // 4a: Health check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200, "Health check must return 200");
    const healthData = await healthRes.json() as { ok: boolean; driver: string; service: string };
    assert.equal(healthData.ok, true);
    assert.equal(healthData.driver, "postgres", "Driver must be postgres in production");
    assert.equal(healthData.service, "tender-tracker");
    console.log("  ✓ /api/health returned driver: 'postgres', ok: true.");

    // 4b: Security status check (proves PostgreSQL repository & connection pool work)
    const securityRes = await fetch(`${baseUrl}/api/security/status`);
    assert.equal(securityRes.status, 200, "Security status must return 200");
    const securityData = await securityRes.json() as { configured: boolean; unlocked: boolean };
    assert(typeof securityData.configured === "boolean", "Security status must return configured boolean");
    console.log("  ✓ /api/security/status responded successfully from PostgreSQL (configured=" + securityData.configured + ").");

    // 4c: Backup authentication check
    const backupNoAuth = await fetch(`${baseUrl}/api/backup/now`, { method: "POST" });
    assert.equal(backupNoAuth.status, 401, "Backup without credentials must return 401");
    console.log("  ✓ /api/backup/now correctly requires authentication in production.");

    // Step 5: Verify Static File & SPA Serving
    console.log("\n[5/6] Verifying static asset serving and SPA routing...");

    // 5a: Root path (/) must serve index.html
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200, "Root must return 200");
    const rootHtml = await rootRes.text();
    assert(rootHtml.includes("<div id=\"root\">"), "Root must serve index.html");
    console.log("  ✓ GET / correctly served dist/index.html.");

    // 5b: Client-side route (/tenders) must fall back to index.html
    const spaRes = await fetch(`${baseUrl}/tenders`);
    assert.equal(spaRes.status, 200, "SPA route must return 200");
    const spaHtml = await spaRes.text();
    assert(spaHtml.includes("<div id=\"root\">"), "SPA route /tenders must serve index.html");
    console.log("  ✓ GET /tenders correctly fell back to dist/index.html (SPA routing).");

    // 5c: Non-existent API route (/api/nonexistent) must NOT return index.html
    const apiNotFoundRes = await fetch(`${baseUrl}/api/nonexistent`);
    assert.notEqual(apiNotFoundRes.status, 200, "Unknown API route must not return 200");
    const apiNotFoundText = await apiNotFoundRes.text();
    assert(!apiNotFoundText.includes("<div id=\"root\">"), "SPA fallback must NOT intercept /api/* routes");
    console.log("  ✓ GET /api/nonexistent was NOT intercepted by SPA fallback (returned 404).");

    // Step 6: Verify direct programmatic component states
    console.log("\n[6/6] Verifying architecture components...");
    process.env.NODE_ENV = "production";
    const { backupProvider, documentStorage } = await import("../server/index.ts");
    assert.equal(backupProvider.mode, "postgres", "Backup provider must be PostgresBackupProvider");
    assert.equal(documentStorage.constructor.name, "SupabaseDocumentStorage", "Storage provider must be SupabaseDocumentStorage");
    console.log("  ✓ Backup provider confirmed as PostgresBackupProvider.");
    console.log("  ✓ Document storage confirmed as SupabaseDocumentStorage.");

    console.log("\n===============================================================");
    console.log("Phase 4B Dry-Run Passed: All production checks verified!");
    console.log("===============================================================");
  } finally {
    // Clean shutdown of server process
    if (serverProc.pid) {
      serverProc.kill("SIGTERM");
      // Wait for process to exit
      await new Promise<void>((r) => {
        serverProc.on("exit", () => r());
        setTimeout(r, 2000);
      });
      console.log("\n[Clean Shutdown] Production test server stopped cleanly.");
    }
  }
}

runDryRun().catch((err) => {
  console.error("\nFATAL Dry-Run Error:", err);
  process.exit(1);
});
