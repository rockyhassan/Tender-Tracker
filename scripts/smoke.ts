import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashPassword, verifyPassword } from "../server/security-service";
import { cacheLifecycleResults, cacheTenders, cachedTenders, clearOfflineState } from "../src/offline";

const port = 18_700 + (process.pid % 900);
const baseUrl = `http://127.0.0.1:${port}`;
const databasePath = join(tmpdir(), `tender-tracker-smoke-${process.pid}.sqlite`);
const seededDatabasePath = join(tmpdir(), `tender-tracker-smoke-seeded-${process.pid}.sqlite`);
const backupDirectory = join(tmpdir(), `tender-tracker-smoke-backups-${process.pid}`);

type Tender = { id: string; tenderId: string; company: string; companyId?: string; packageName?: string; status: string; stage: string; submissionAt?: string; tenderValue?: number; submittedValue?: number };
type ResponseBody = Record<string, unknown> | Tender | Tender[];

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Smoke assertion failed: ${message}`);
};

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: ResponseBody }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(sessionToken ? { "x-session-token": sessionToken } : {}), ...(init?.headers ?? {}) },
  });
  const body = response.status === 204 ? {} : ((await response.json()) as ResponseBody);
  return { status: response.status, body };
}

async function startServer(options: { databasePath?: string; seed?: boolean } = {}): Promise<ChildProcess> {
  const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), TENDER_DB_PATH: options.databasePath ?? databasePath, TENDER_DB_SEED: options.seed ? "1" : "0", TENDER_BACKUP_DIR: backupDirectory, TENDER_BACKUP_RETENTION: "2", USE_SQLITE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  child.on("error", (err) => console.error(`[server error] ${err}`));
  child.on("exit", (code) => console.log(`[server exit] ${code}`));

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await request("/api/health");
      if (health.status === 200) return child;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error("Server did not become healthy");
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The process may have exited between the health check and shutdown.
    }
  } else {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let server: ChildProcess | undefined;
let sessionToken = "";
try {
  rmSync(databasePath, { force: true });
  rmSync(backupDirectory, { recursive: true, force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(backupDirectory, { recursive: true, force: true });

  server = await startServer();
  const passwordHash = hashPassword("Smoke Correct Horse Battery 123!");
  assert(passwordHash.startsWith("scrypt-v1$") && !passwordHash.includes("Smoke Correct Horse Battery 123!"), "master password is stored as a modern non-plaintext hash");
  assert(verifyPassword("Smoke Correct Horse Battery 123!", passwordHash), "password hash verifies the correct password");
  assert(!verifyPassword("wrong password", passwordHash), "password hash rejects an incorrect password");
  const initialSecurity = await request("/api/security/status");
  assert(initialSecurity.status === 200 && !(initialSecurity.body as { configured?: boolean }).configured, "security starts unconfigured on a fresh database");
  const setup = await request("/api/security/setup", { method: "POST", body: JSON.stringify({ password: "Smoke Correct Horse Battery 123!", recoveryEmail: "owner@example.test" }) });
  assert(setup.status === 201 && Boolean((setup.body as { token?: string }).token), "master password setup creates a local session");
  sessionToken = (setup.body as { token: string }).token;
  const wrongUnlock = await request("/api/security/unlock", { method: "POST", body: JSON.stringify({ password: "wrong password" }) });
  assert(wrongUnlock.status === 401, "unlock rejects an incorrect password");
  const closingAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const created = await request("/api/tenders", {
    method: "POST",
    body: JSON.stringify({
      tenderId: "SMOKE/2026/001",
      company: "Smoke Works Ltd.",
      authority: "Test Authority",
      packageName: "SQLite persistence package",
      closingAt,
      tenderValue: 123456,
      stage: "New",
      status: "Active",
    }),
  });
  assert(created.status === 201, `create returned ${created.status}`);
  const createdTender = created.body as Tender;
  assert(Boolean(createdTender.id), "create returned an id");

  const blankTender = await request("/api/tenders", { method: "POST", body: JSON.stringify({ tenderId: "SMOKE/BLANK/001", company: "Blank Values Ltd.", authority: "Test Authority", packageName: "Value later package", closingAt: new Date(Date.now() + 30 * 86400000).toISOString() }) });
  assert(blankTender.status === 201 && (blankTender.body as Tender).tenderValue === undefined && (blankTender.body as Tender).submittedValue === undefined, "initial tender creation accepts blank tender and submitted values without coercing to zero");
  const blankId = (blankTender.body as Tender).id;
  const blankNegative = await request(`/api/tenders/${encodeURIComponent(blankId)}`, { method: "PATCH", body: JSON.stringify({ tenderValue: -1 }) });
  assert(blankNegative.status === 400, "negative tender value is rejected");
  const blankUpdated = await request(`/api/tenders/${encodeURIComponent(blankId)}`, { method: "PATCH", body: JSON.stringify({ tenderValue: 456000, submittedValue: 455000 }) });
  assert(blankUpdated.status === 200 && (blankUpdated.body as Tender).tenderValue === 456000 && (blankUpdated.body as Tender).submittedValue === 455000, "blank tender values can be added later through update");

  const automaticBackup = await request("/api/backup/automatic");
  assert(automaticBackup.status === 200 && (automaticBackup.body as { files?: string[]; retention?: number }).files?.length === 1 && (automaticBackup.body as { retention?: number }).retention === 2, "startup writes an automatic local backup with configured retention");
  const authority = await request("/api/authorities", { method: "POST", body: JSON.stringify({ name: "Smoke Authority", zone: "Smoke Zone", contact: "ops@authority.test", referenceNotes: "Keep reference", etenderPortal: "https://etender.example.test", etenderReference: "AUTH-001" }) });
  assert(authority.status === 201 && (authority.body as { name?: string }).name === "Smoke Authority", "authority profile creates");
  const authorityId = (authority.body as { id: string }).id;
  const authorityUpdate = await request(`/api/authorities/${encodeURIComponent(authorityId)}`, { method: "PATCH", body: JSON.stringify({ contact: "updated@authority.test", etenderNotes: "Updated metadata" }) });
  assert(authorityUpdate.status === 200 && (authorityUpdate.body as { contact?: string }).contact === "updated@authority.test" && (authorityUpdate.body as { etenderNotes?: string }).etenderNotes === "Updated metadata", "authority profile update persists optional e-Tender metadata");
  const authorities = await request("/api/authorities");
  assert(authorities.status === 200 && Array.isArray(authorities.body) && (authorities.body as unknown[]).some((item) => (item as { id: string }).id === authorityId), "authority profile list returns CRUD record");
  const uploaded = await request("/api/documents", { method: "POST", body: JSON.stringify({ authorityId, fileName: "reference.txt", mimeType: "text/plain", data: "data:text/plain;base64,SGVsbG8gc21va2U=" }) });
  assert(uploaded.status === 201 && (uploaded.body as { fileName?: string; sizeBytes?: number }).fileName === "reference.txt" && (uploaded.body as { sizeBytes?: number }).sizeBytes === 11, "authority document upload validates and stores metadata");
  const documentId = (uploaded.body as { id: string }).id;
  const listedDocuments = await request(`/api/documents?authorityId=${encodeURIComponent(authorityId)}`);
  assert(listedDocuments.status === 200 && Array.isArray(listedDocuments.body) && (listedDocuments.body as unknown[]).length === 1, "authority document list returns metadata");
  const downloadedDocument = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(documentId)}/download`);
  assert(downloadedDocument.status === 200 && (await downloadedDocument.text()) === "Hello smoke", "document download returns stored bytes");
  const deletedDocument = await request(`/api/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
  assert(deletedDocument.status === 204, "document delete removes metadata and local file");
  writeFileSync(join(backupDirectory, "tender-tracker-auto-2020-01-01.json"), "old"); writeFileSync(join(backupDirectory, "tender-tracker-auto-2020-01-02.json"), "old"); writeFileSync(join(backupDirectory, "tender-tracker-auto-2020-01-03.json"), "old");
  const backupNow = await request("/api/backup/now", { method: "POST" }); const backupAfterRetention = await request("/api/backup/automatic");
  assert(backupNow.status === 200 && backupAfterRetention.status === 200 && ((backupAfterRetention.body as { files?: string[] }).files?.length ?? 99) <= 2, "manual automatic-backup write applies retention cleanup");

  const createdTenderFull = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}`);
  const createdCompanyId = (createdTenderFull.body as Tender & { companyId: string }).companyId;
  const bankBefore = await request("/api/bank-profile");
  assert(bankBefore.status === 200 && bankBefore.body === null, "fresh database has no current bank profile");
  const bankSaved = await request("/api/bank-profile", { method: "PUT", body: JSON.stringify({ accountName: "Smoke Operating Account", accountNumber: "123456789012", branch: "Motijheel" }) });
  const bankSavedBody = bankSaved.body as { accountName?: string; accountNumberMasked?: string; branch?: string };
  assert(bankSaved.status === 200 && bankSavedBody.accountName === "Smoke Operating Account" && bankSavedBody.branch === "Motijheel" && bankSavedBody.accountNumberMasked === "••••••••9012" && !JSON.stringify(bankSaved.body).includes("123456789012"), "bank profile saves with a masked account number only");
  const bankUpdated = await request("/api/bank-profile", { method: "PUT", body: JSON.stringify({ accountName: "Smoke Updated Account", accountNumber: "999900001111", branch: "Gulshan" }) });
  assert(bankUpdated.status === 200 && (bankUpdated.body as { accountName?: string }).accountName === "Smoke Updated Account", "bank profile update persists");
  const bankTemplate = await request("/api/email-templates", { method: "POST", body: JSON.stringify({ type: "purchase-sheet-bank", name: "Smoke bank request", to: "bank@example.test", cc: "ops@example.test", subject: "Purchase {{sheetNumber}}" }) });
  assert(bankTemplate.status === 201 && (bankTemplate.body as { type?: string }).type === "purchase-sheet-bank", "purchase sheet bank email template creates");
  const bankTemplateId = (bankTemplate.body as { id: string }).id;
  const noaTemplate = await request("/api/email-templates", { method: "POST", body: JSON.stringify({ type: "company-noa", name: "Smoke NOA notice", companyId: createdCompanyId, to: "company@example.test", subject: "NOA {{noaNumber}}" }) });
  assert(noaTemplate.status === 201 && (noaTemplate.body as { companyId?: string }).companyId === createdCompanyId, "company/NOA email template creates for a company");
  const noaTemplateId = (noaTemplate.body as { id: string }).id;
  const templateEdited = await request(`/api/email-templates/${encodeURIComponent(bankTemplateId)}`, { method: "PATCH", body: JSON.stringify({ subject: "Updated purchase {{sheetNumber}}" }) });
  assert(templateEdited.status === 200 && (templateEdited.body as { subject?: string }).subject === "Updated purchase {{sheetNumber}}", "email template edit persists subject fields");
  const selectedTemplate = await request(`/api/email-templates/${encodeURIComponent(bankTemplateId)}/select`, { method: "PUT" });
  assert(selectedTemplate.status === 200 && (selectedTemplate.body as { selected?: boolean }).selected === true, "email template selection is persisted");
  const selectedTemplates = await request("/api/email-templates");
  assert(selectedTemplates.status === 200 && Array.isArray(selectedTemplates.body) && (selectedTemplates.body as unknown as Array<{ id: string; selected: boolean }>).find((item) => item.id === bankTemplateId)?.selected === true, "email template listing returns selection state");
  const deletedTemplate = await request(`/api/email-templates/${encodeURIComponent(noaTemplateId)}`, { method: "DELETE" });
  assert(deletedTemplate.status === 204, "email template delete returns 204");
  const companyList = await request("/api/companies");
  assert(companyList.status === 200 && Array.isArray(companyList.body) && !companyList.body.some((company) => "username" in (company as object) || "password" in (company as object) || "tender_password_ciphertext" in (company as object)), "normal company responses never expose plaintext or ciphertext credential fields");
  const managedCompany = await request("/api/companies", { method: "POST", body: JSON.stringify({ name: "Smoke Managed Company", code: "SMOKE", contact: "owner@example.test", notes: "CRUD fixture" }) });
  assert(managedCompany.status === 201 && (managedCompany.body as { name?: string }).name === "Smoke Managed Company", "company create returns profile fields");
  const managedCompanyId = (managedCompany.body as { id: string }).id;
  const managedUpdate = await request(`/api/companies/${encodeURIComponent(managedCompanyId)}`, { method: "PATCH", body: JSON.stringify({ contact: "updated@example.test", notes: "Updated notes" }) });
  assert(managedUpdate.status === 200 && (managedUpdate.body as { contact?: string }).contact === "updated@example.test", "company update persists contact and notes");
  const archived = await request(`/api/companies/${encodeURIComponent(managedCompanyId)}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) });
  assert(archived.status === 200 && Boolean((archived.body as { archivedAt?: string }).archivedAt), "company archive marks profile without deleting it");
  const restoredArchive = await request(`/api/companies/${encodeURIComponent(managedCompanyId)}/archive`, { method: "POST", body: JSON.stringify({ archived: false }) });
  assert(restoredArchive.status === 200 && !(restoredArchive.body as { archivedAt?: string }).archivedAt, "company archive can be reversed");
  const saveCredentials = await request(`/api/companies/${encodeURIComponent(createdCompanyId)}/credentials`, { method: "PUT", body: JSON.stringify({ username: "smoke-user", password: "smoke-secret" }) });
  assert(saveCredentials.status === 200 && (saveCredentials.body as { hasCredentials?: boolean }).hasCredentials === true, "credentials save returns only a masked summary");
  const locked = await request("/api/security/lock", { method: "POST" });
  assert(locked.status === 200, "lock endpoint closes the local session");
  sessionToken = "";
  const gated = await request(`/api/companies/${encodeURIComponent(createdCompanyId)}/credentials`);
  assert(gated.status === 401, "credential reveal is gated while locked");
  const unlock = await request("/api/security/unlock", { method: "POST", body: JSON.stringify({ password: "Smoke Correct Horse Battery 123!" }) });
  assert(unlock.status === 200 && Boolean((unlock.body as { token?: string }).token), "correct password unlocks the app");
  sessionToken = (unlock.body as { token: string }).token;
  const revealed = await request(`/api/companies/${encodeURIComponent(createdCompanyId)}/credentials`);
  assert(revealed.status === 200 && (revealed.body as { username?: string; password?: string }).username === "smoke-user" && (revealed.body as { password?: string }).password === "smoke-secret", "unlocked credential reveal returns the saved values only after unlock");
  const encryptedBackup = JSON.parse(await (await fetch(`${baseUrl}/api/backup/export`, { headers: sessionToken ? { "x-session-token": sessionToken } : {} })).text()) as { tables: Record<string, Array<Record<string, unknown>>> };
  const companyBackup = encryptedBackup.tables.companies.find((row) => row.id === createdCompanyId);
  assert(companyBackup && companyBackup.tender_username_ciphertext && companyBackup.tender_password_ciphertext && companyBackup.tender_username !== "smoke-user", "credential backup stores ciphertext rather than plaintext");

  const charge = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/charges`, {
    method: "POST",
    body: JSON.stringify({ type: "Tender purchase", amount: 2500, chargedAt: new Date().toISOString(), reference: "CHG-001", remarks: "Smoke charge" }),
  });
  assert(charge.status === 201 && (charge.body as { reference?: string }).reference === "CHG-001", "tender charge creates with reference");
  const payOrder = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/pay-orders`, {
    method: "POST",
    body: JSON.stringify({ orderNumber: "PO-001", amount: 50000, payee: "Smoke Works Ltd.", companyId: createdTender.companyId, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), bank: "Smoke Bank", returnStatus: "Pending", remarks: "Return after result" }),
  });
  assert(payOrder.status === 201 && (payOrder.body as { payee?: string }).payee === "Smoke Works Ltd.", "Pay Order creates with lifecycle details");
  const certificate = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/credit-commitment-certificates`, {
    method: "POST",
    body: JSON.stringify({ certificateNumber: "CCC-001", amount: 75000, value: 75000, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), returnDate: new Date(Date.now() + 172800000).toISOString(), issuingBank: "Smoke Bank", status: "Active" }),
  });
  assert(certificate.status === 201 && (certificate.body as { certificateNumber?: string }).certificateNumber === "CCC-001", "certificate creates with expiry and return date");
  const result = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/result`, { method: "PUT", body: JSON.stringify({ outcome: "Won", resultDate: new Date().toISOString(), awardedCompany: "Smoke Works Ltd.", remarks: "Smoke result" }) });
  assert(result.status === 200 && (result.body as { outcome?: string }).outcome === "Won", "result update accepts Win/Lost workflow data");
  const winFiltered = await request("/api/tenders?result=Win");
  assert(winFiltered.status === 200 && Array.isArray(winFiltered.body) && winFiltered.body.some((item) => (item as Tender).tenderId === "SMOKE/2026/001") && !winFiltered.body.some((item) => (item as Tender).tenderId === "SMOKE/FILTER/003"), "Win result filter uses lifecycle result records");
  const noa = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/noa`, { method: "PUT", body: JSON.stringify({ noaNumber: "NOA-001", issuedAt: new Date().toISOString(), acceptanceDeadline: new Date(Date.now() + 86400000).toISOString(), contractValue: 120000, status: "Pending" }) });
  assert(noa.status === 200 && (noa.body as { noaNumber?: string }).noaNumber === "NOA-001", "NOA basics save");
  const security = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/performance-security`, { method: "PUT", body: JSON.stringify({ securityNumber: "PS-001", amount: 10000, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), provider: "Smoke Bank", status: "Active", remarks: "Original security record" }) });
  assert(security.status === 200 && (security.body as { securityNumber?: string; amount?: number; remarks?: string }).securityNumber === "PS-001" && (security.body as { amount?: number }).amount === 10000 && (security.body as { remarks?: string }).remarks === "Original security record", "performance security creates with amount and general remarks");
  const contract = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/contract-agreement`, { method: "PUT", body: JSON.stringify({ contractNumber: "CA-001", signedAt: new Date().toISOString(), contractValue: 120000, status: "Active", remarks: "Initial agreement" }) });
  assert(contract.status === 200 && (contract.body as { contractNumber?: string }).contractNumber === "CA-001", "contract agreement creates with sign-up date and remarks");
  const contractUpdated = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/contract-agreement`, { method: "PUT", body: JSON.stringify({ contractNumber: "CA-002", agreementDate: new Date().toISOString(), contractValue: 125000, status: "Completed", remarks: "Signed and registered" }) });
  assert(contractUpdated.status === 200 && (contractUpdated.body as { contractNumber?: string; status?: string; remarks?: string }).contractNumber === "CA-002" && (contractUpdated.body as { status?: string }).status === "Completed" && (contractUpdated.body as { remarks?: string }).remarks === "Signed and registered", "contract agreement update accepts sign-up date alias and persists remarks");

  const details = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/details`);
  const detailsBody = details.body as { totalCharges?: number; totalCost?: number; charges?: unknown[]; payOrders?: unknown[]; creditCommitmentCertificates?: unknown[]; result?: { outcome?: string }; noa?: { noaNumber?: string }; performanceSecurity?: { securityNumber?: string } };
  assert(details.status === 200 && detailsBody.totalCharges === 2500 && detailsBody.totalCost === 2500 && detailsBody.charges?.length === 1 && detailsBody.payOrders?.length === 1 && detailsBody.creditCommitmentCertificates?.length === 1 && detailsBody.result?.outcome === "Won" && detailsBody.noa?.noaNumber === "NOA-001" && detailsBody.performanceSecurity?.securityNumber === "PS-001" && (detailsBody as { contractAgreement?: { contractNumber?: string } }).contractAgreement?.contractNumber === "CA-002", "tender details aggregates lifecycle records and total cost including contract agreement");

  const payOrderRegister = await request("/api/pay-orders");
  const securityRegister = await request("/api/performance-securities");
  assert(payOrderRegister.status === 200 && Array.isArray(payOrderRegister.body) && (payOrderRegister.body as Array<{ tenderReference?: string; company?: string; orderNumber?: string }>).some((item) => item.tenderReference === "SMOKE/2026/001" && item.company === "Smoke Works Ltd." && item.orderNumber === "PO-001"), "dedicated Pay Order list joins tender and company context");
  assert(securityRegister.status === 200 && Array.isArray(securityRegister.body) && (securityRegister.body as Array<{ tenderReference?: string; company?: string; securityNumber?: string }>).some((item) => item.tenderReference === "SMOKE/2026/001" && item.company === "Smoke Works Ltd." && item.securityNumber === "PS-001"), "dedicated Performance Security list joins tender and company context");

  const batch = await request("/api/issue-batches", {
    method: "POST",
    body: JSON.stringify({ issueDate: new Date().toISOString(), authorityId, authorityZone: "Smoke Zone", reference: "SMOKE-BATCH", status: "Draft" }),
  });
  assert(batch.status === 201 && Boolean((batch.body as { id?: string }).id), "issue batch create returns an id");
  const batchId = (batch.body as { id: string }).id;
  const atomicBatch = await request("/api/issue-batches/with-tenders", { method: "POST", body: JSON.stringify({ issueDate: new Date().toISOString(), authorityId, authorityZone: "Atomic Smoke Zone", reference: "ATOMIC-BATCH", notes: "One-request fixture", status: "Issued", rows: [
    { tenderId: "SMOKE/ATOMIC/001", packageName: "Atomic package one", closingAt: new Date(Date.now() + 40 * 86400000).toISOString(), tenderValue: 1000 },
    { tenderId: "SMOKE/ATOMIC/002", packageName: "Atomic package two", closingAt: new Date(Date.now() + 41 * 86400000).toISOString(), submissionAt: new Date(Date.now() + 42 * 86400000).toISOString(), submittedValue: 900 },
  ] }) });
  const atomicBody = atomicBatch.body as { batch?: { id?: string; tenderCount?: number; authorityZone?: string }; tenders?: Array<Tender> };
  assert(atomicBatch.status === 201 && Boolean(atomicBody.batch?.id) && atomicBody.batch?.tenderCount === 2 && atomicBody.tenders?.length === 2 && atomicBody.tenders.every((row) => row.companyId === undefined && (row as Tender & { authorityZone?: string }).authorityZone === "Smoke Zone"), "one request creates an authority-only batch and all tender rows atomically");
  const atomicBatchId = atomicBody.batch!.id!;
  const invalidAtomic = await request("/api/issue-batches/with-tenders", { method: "POST", body: JSON.stringify({ issueDate: new Date().toISOString(), authorityId, authorityZone: "Rollback Smoke Zone", status: "Draft", rows: [
    { tenderId: "SMOKE/ROLLBACK/001", packageName: "Valid row that must roll back", closingAt: new Date(Date.now() + 50 * 86400000).toISOString() },
    { tenderId: "SMOKE/ROLLBACK/002", packageName: "", closingAt: "not-a-date" },
  ] }) });
  const batchesAfterInvalidAtomic = await request("/api/issue-batches");
  const rollbackTender = await request("/api/tenders?tenderId=SMOKE%2FROLLBACK%2F001");
  assert(invalidAtomic.status === 400 && batchesAfterInvalidAtomic.status === 200 && Array.isArray(batchesAfterInvalidAtomic.body) && !(batchesAfterInvalidAtomic.body as Array<{ authorityZone?: string }>).some((item) => item.authorityZone === "Rollback Smoke Zone") && rollbackTender.status === 200 && Array.isArray(rollbackTender.body) && rollbackTender.body.length === 0, "invalid atomic row rejects the request without creating a partial batch or tender");
  const bulkBlank = await request(`/api/issue-batches/${encodeURIComponent(batchId)}/tenders/bulk`, { method: "POST", body: JSON.stringify({ rows: [{ tenderId: "SMOKE/BULK-BLANK/001", company: "Bulk Blank Ltd.", packageName: "Bulk values later", closingAt: new Date(Date.now() + 30 * 86400000).toISOString() }] }) });
  assert(bulkBlank.status === 200 && (bulkBlank.body as { created?: Array<Tender> }).created?.[0]?.tenderValue === undefined, "manual bulk entry accepts blank tender value");
  const unassignedBulk = await request(`/api/issue-batches/${encodeURIComponent(batchId)}/tenders/bulk`, { method: "POST", body: JSON.stringify({ rows: [
    { tenderId: "SMOKE/UNASSIGNED/001", packageName: "Unassigned package one", closingAt: new Date(Date.now() + 31 * 86400000).toISOString() },
    { tenderId: "SMOKE/UNASSIGNED/002", packageName: "Unassigned package two", closingAt: new Date(Date.now() + 32 * 86400000).toISOString(), submissionAt: new Date(Date.now() + 33 * 86400000).toISOString(), submittedValue: 777 },
  ] }) });
  const unassignedRows = (unassignedBulk.body as { created?: Array<Tender> }).created ?? [];
  assert(unassignedBulk.status === 200 && unassignedRows.length === 2 && unassignedRows.every((row) => row.companyId === undefined && row.company === "Unassigned"), "bulk tenders can be created without a company and display Unassigned");
  const alternateCompany = await request("/api/companies", { method: "POST", body: JSON.stringify({ name: "Smoke Alternate Ltd." }) });
  const alternateCompanyId = (alternateCompany.body as { id?: string }).id;
  const primaryCompanyId = (await request("/api/companies")).body as Array<{ id?: string; name?: string }>;
  const smokeCompanyId = primaryCompanyId.find((company) => company.name === "Smoke Works Ltd.")?.id;
  assert(alternateCompany.status === 201 && Boolean(alternateCompanyId) && Boolean(smokeCompanyId), "company profiles remain available for purchase-sheet line assignment");

  const sheet = await request("/api/purchase-sheets", {
    method: "POST",
    body: JSON.stringify({ issueBatchId: batchId, selectedTenderIds: [createdTender.id], status: "Draft", viewMode: "company-grouped", bankEmailTo: "bank@example.test", bankEmailSubject: "Smoke {{sheetNumber}}" }),
  });
  assert(sheet.status === 201, `purchase sheet create returned ${sheet.status}`);
  const createdSheet = sheet.body as { id: string; issueBatchId: string; selectedTenderIds: string[]; viewMode: string; bankEmailTo: string; viewMetadata: { lineCount: number; companyCount: number } };
  assert(Boolean(createdSheet.id) && createdSheet.issueBatchId === batchId, "purchase sheet is scoped to issue batch");
  assert(createdSheet.selectedTenderIds.length === 1 && createdSheet.viewMode === "company-grouped", "purchase sheet stores selected lines and view mode");
  assert(createdSheet.viewMetadata.lineCount === 1 && createdSheet.viewMetadata.companyCount === 1 && createdSheet.bankEmailTo === "bank@example.test", "purchase sheet returns metadata and bank template fields");
  const mixedSheet = await request("/api/purchase-sheets", { method: "POST", body: JSON.stringify({ issueBatchId: batchId, selectedTenderIds: unassignedRows.map((row) => row.id), lineAssignments: unassignedRows.map((row, index) => ({ tenderId: row.id, companyId: index === 0 ? smokeCompanyId : alternateCompanyId })), status: "Draft", viewMode: "flat" }) });
  const mixedSheetBody = mixedSheet.body as { id?: string; lineAssignments?: Array<{ tenderId: string; companyId?: string; company?: string }>; tenders?: Array<Tender> };
  assert(mixedSheet.status === 201 && mixedSheetBody.lineAssignments?.length === 2 && new Set(mixedSheetBody.lineAssignments.map((line) => line.companyId)).size === 2 && new Set(mixedSheetBody.tenders?.map((tender) => tender.company)).size === 2, "purchase sheets persist different companies per selected tender line");
  const mixedAfterRestart = await request(`/api/purchase-sheets/${encodeURIComponent(mixedSheetBody.id ?? "")}`);
  assert(mixedAfterRestart.status === 200 && (mixedAfterRestart.body as { lineAssignments?: Array<{ companyId?: string }> }).lineAssignments?.every((line) => Boolean(line.companyId)), "line-level company assignments survive a fresh read");

  const sheetUpdated = await request(`/api/purchase-sheets/${encodeURIComponent(createdSheet.id)}`, { method: "PATCH", body: JSON.stringify({ status: "Sent to Bank" }) });
  assert(sheetUpdated.status === 200 && (sheetUpdated.body as { status: string }).status === "Sent to Bank", "purchase sheet status updates");

  const invalidSheet = await request("/api/purchase-sheets", { method: "POST", body: JSON.stringify({ issueBatchId: batchId, selectedTenderIds: [], status: "Draft", viewMode: "flat" }) });
  assert(invalidSheet.status === 400, "purchase sheet without selected lines is rejected");

  const searched = await request("/api/tenders?q=sqlite");
  assert(searched.status === 200 && Array.isArray(searched.body) && searched.body.length === 1, "search finds created tender");

  const soonTender = await request("/api/tenders", {
    method: "POST",
    body: JSON.stringify({ tenderId: "SMOKE/2026/002-SOON", company: "Smoke Works Ltd.", authority: "Test Authority", packageName: "Distinct submission package", closingAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), submissionAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), tenderValue: 88000, stage: "Purchased", status: "Active" }),
  });
  assert(soonTender.status === 201, "distinct submission deadline fixture creates");
  const soonTenderBody = soonTender.body as Tender;
  const persistedSoon = await request(`/api/tenders/${encodeURIComponent(soonTenderBody.id)}`);
  assert(persistedSoon.status === 200 && Boolean((persistedSoon.body as Tender).submissionAt), "submission deadline persists on tender create");
  const filterClosing = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
  const filterSubmission = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
  const filterTender = await request("/api/tenders", {
    method: "POST",
    body: JSON.stringify({ tenderId: "SMOKE/FILTER/003", company: "Filter Works Ltd.", authority: "Northern Works Authority", authorityZone: "North Zone", packageName: "Bridge package", closingAt: filterClosing.toISOString(), submissionAt: filterSubmission.toISOString(), tenderValue: 500000, stage: "Result Pending", status: "Active" }),
  });
  assert(filterTender.status === 201, "advanced filter fixture creates");
  const advancedParams = new URLSearchParams({ tenderId: "FILTER/003", company: "Filter Works", authorityZone: "North Zone", packageName: "Bridge", stage: "Result Pending", status: "Active", closingFrom: filterClosing.toISOString().slice(0, 10), closingTo: filterClosing.toISOString().slice(0, 10), submissionFrom: filterSubmission.toISOString().slice(0, 10), submissionTo: filterSubmission.toISOString().slice(0, 10), valueMin: "400000", valueMax: "600000" });
  const advancedFiltered = await request(`/api/tenders?${advancedParams.toString()}`);
  assert(advancedFiltered.status === 200 && Array.isArray(advancedFiltered.body) && advancedFiltered.body.length === 1 && (advancedFiltered.body[0] as Tender).tenderId === "SMOKE/FILTER/003", "advanced tender filters combine ID, company, authority/zone, package, workflow, dates, and value range");
  const invalidRange = await request("/api/tenders?valueMin=9&valueMax=2");
  assert(invalidRange.status === 400, "invalid tender value range is rejected by API validation");
  const pendingFiltered = await request("/api/tenders?result=Pending&tenderId=SMOKE%2F2026%2F002-SOON");
  assert(pendingFiltered.status === 200 && Array.isArray(pendingFiltered.body) && pendingFiltered.body.length === 1, "pending result filter includes tenders without a recorded result");

  const summary = await request("/api/deadlines/summary");
  const summaryBody = summary.body as { totals: { urgent: number; soon: number }; items: Array<{ tenderId: string; kind?: string; dueAt?: string }> };
  const dashboard = await request("/api/dashboard/summary");
  const dashboardBody = dashboard.body as { pendingWork?: { total?: number; counts?: Record<string, number>; sections?: Array<{ key: string; count: number }> } };
  const pendingKeys = new Set((dashboardBody.pendingWork?.sections ?? []).map((section) => section.key));
  assert(dashboard.status === 200 && pendingKeys.has("payOrder") && pendingKeys.has("submission") && pendingKeys.has("result") && pendingKeys.has("noa") && pendingKeys.has("performanceSecurity") && pendingKeys.has("contractAgreement") && pendingKeys.has("payOrderReturn") && pendingKeys.has("creditCommitmentReturn") && (dashboardBody.pendingWork?.counts?.submission ?? 0) >= 1, "dashboard summary exposes future-only pending work sections and counts");
  const deadlineKinds = new Set(summaryBody.items.map((item) => item.kind));
  const submissionAlert = summaryBody.items.find((item) => item.tenderId === "SMOKE/2026/002-SOON" && item.kind === "submission");
  assert(summary.status === 200 && summaryBody.totals.urgent === 4 && summaryBody.totals.soon === 1 && submissionAlert?.dueAt === (persistedSoon.body as Tender).submissionAt && deadlineKinds.has("closing") && deadlineKinds.has("submission") && deadlineKinds.has("acceptance") && deadlineKinds.has("security-expiry") && deadlineKinds.has("pay-order-return"), "deadline summary uses distinct submission deadline for Purchased alerts");
  const securityReturnPending = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/performance-security`, { method: "PUT", body: JSON.stringify({ securityNumber: "PS-001", amount: 10000, issuedAt: (security.body as { issuedAt: string }).issuedAt, expiresAt: (security.body as { expiresAt: string }).expiresAt, provider: "Smoke Bank", status: "Active", returnDate: new Date(Date.now() + 3 * 86400000).toISOString(), returnStatus: "Pending", returnRemarks: "Awaiting bank release", remarks: "Updated security record" }) });
  assert(securityReturnPending.status === 200 && (securityReturnPending.body as { returnStatus?: string; returnRemarks?: string; remarks?: string }).returnStatus === "Pending" && (securityReturnPending.body as { returnRemarks?: string }).returnRemarks === "Awaiting bank release" && (securityReturnPending.body as { remarks?: string }).remarks === "Updated security record", "performance security return fields update and persist");
  const pendingReturnDashboard = await request("/api/dashboard/summary");
  const pendingReturnDeadline = await request("/api/deadlines/summary");
  assert(pendingReturnDashboard.status === 200 && ((pendingReturnDashboard.body as { pendingWork?: { counts?: Record<string, number> } }).pendingWork?.counts?.performanceSecurityReturn ?? 0) >= 1 && (pendingReturnDeadline.body as { items: Array<{ tenderId: string; kind?: string }> }).items.some((item) => item.tenderId === "SMOKE/2026/001" && item.kind === "performance-security-return"), "pending performance security return is surfaced as an active alert");
  const securityReturned = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/performance-security`, { method: "PUT", body: JSON.stringify({ securityNumber: "PS-001", amount: 10000, issuedAt: (security.body as { issuedAt: string }).issuedAt, expiresAt: (security.body as { expiresAt: string }).expiresAt, provider: "Smoke Bank", status: "Active", returnDate: (securityReturnPending.body as { returnDate: string }).returnDate, returnStatus: "Returned", returnRemarks: "Released by bank", remarks: "Completed security history" }) });
  assert(securityReturned.status === 200 && (securityReturned.body as { returnStatus?: string; returnRemarks?: string }).returnStatus === "Returned", "returned performance security update succeeds");
  const returnedDashboard = await request("/api/dashboard/summary");
  const returnedDeadline = await request("/api/deadlines/summary");
  assert((returnedDashboard.body as { pendingWork?: { counts?: Record<string, number> } }).pendingWork?.counts?.performanceSecurityReturn === 0 && !(returnedDeadline.body as { items: Array<{ tenderId: string; kind?: string }> }).items.some((item) => item.tenderId === "SMOKE/2026/001" && item.kind === "performance-security-return"), "returned performance security is removed from active return alerts while history remains");
  const overdueWrite = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}`, { method: "PATCH", body: JSON.stringify({ closingAt: new Date(Date.now() - 3600000).toISOString(), stage: "Submitted" }) });
  assert(overdueWrite.status === 200, "workflow updates remain allowed after a deadline");
  const afterDeadlineSummary = await request("/api/deadlines/summary");
  assert(afterDeadlineSummary.status === 200 && !(afterDeadlineSummary.body as { items: Array<{ tenderId: string; kind?: string; dueAt?: string }> }).items.some((item) => item.tenderId === "SMOKE/2026/001" && (item.kind === "closing" || item.kind === "submission")), "past closing deadlines do not block or remain active alerts");

  const importPreview = await request("/api/import/preview", {
    method: "POST",
    body: JSON.stringify({ filename: "smoke.csv", rows: [
      { "Tender ID": "SMOKE/2026/001", Company: "Updated Smoke Works", Authority: "Test Authority", "Package Name": "Replaced package", "Closing At": closingAt, "Tender Value": 123999, Stage: "Submitted", Status: "Active" },
      { "Tender ID": "SMOKE/2026/002", Company: "Imported Works", Authority: "Second Authority", "Package Name": "New imported package", "Closing At": closingAt, "Tender Value": 88000, Stage: "New", Status: "Draft" },
      { "Tender ID": "SMOKE/2026/002", Company: "Duplicate Works", Authority: "Second Authority", "Package Name": "Duplicate package", "Closing At": closingAt, "Tender Value": 99000, Stage: "New", Status: "Draft" },
      { "Tender ID": "", Company: "Invalid", Authority: "Missing ID", "Package Name": "Invalid row", "Closing At": closingAt, "Tender Value": 1 },
    ] }),
  });
  const previewBody = importPreview.body as { rows: unknown[]; duplicates: Array<{ rowIndex: number }>; validCount: number; invalidCount: number };
  assert(importPreview.status === 200 && previewBody.rows.length === 4 && previewBody.duplicates.length === 2 && previewBody.validCount === 3 && previewBody.invalidCount === 1, "import preview normalizes rows and identifies duplicate Tender IDs");
  const imported = await request("/api/import/commit", {
    method: "POST",
    body: JSON.stringify({ preview: previewBody, decisions: { "2": "replace", "4": "keep-old" } }),
  });
  const importedBody = imported.body as { imported: unknown[]; updated: unknown[]; skipped: number[] };
  assert(imported.status === 200 && importedBody.updated.length === 1 && importedBody.imported.length === 1 && importedBody.skipped.length === 1, "import commit applies replace, keep-both, and invalid-row handling decisions");
  const replaced = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}`);
  assert(replaced.status === 200 && (replaced.body as Tender).packageName === "Replaced package", "replace decision updates existing tender");
  const report = await request("/api/reports/tender-list");
  const reportBody = report.body as { title: string; columns: string[]; rows: unknown[] };
  assert(report.status === 200 && reportBody.title === "Tender List" && reportBody.columns.includes("Tender ID") && reportBody.rows.length >= 2, "tender list report returns normalized rows");
  const csvResponse = await fetch(`${baseUrl}/api/reports/tender-cost.csv`);
  const csvText = await csvResponse.text();
  assert(csvResponse.status === 200 && csvText.includes("Tender ID") && csvText.includes("Total Cost"), "report CSV export returns headers and data");
  const printResponse = await fetch(`${baseUrl}/api/reports/win-lost/print`);
  const printText = await printResponse.text();
  assert(printResponse.status === 200 && printText.includes("<!doctype html>") && printText.includes("Win / Lost"), "report print endpoint returns PDF-ready HTML");
  const pdfResponse = await fetch(`${baseUrl}/api/reports/tender-cost.pdf`);
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
  let pdfText = "";
  try {
    pdfText = execFileSync("pdftotext", ["-", "-"], { input: pdfBytes }).toString();
  } catch {
    // pdftotext may not be available on all development environments (e.g. Windows without poppler)
  }
  assert(pdfResponse.status === 200 && pdfResponse.headers.get("content-type")?.includes("application/pdf") && pdfBytes.toString("latin1").startsWith("%PDF-") && (!pdfText || (pdfText.includes("Tender Cost") && pdfText.includes("BDT 2,500"))), "report PDF export returns a PDF with title and exact BDT formatting");

  clearOfflineState();
  const offlineTenders = [
    { id: "offline-won", tenderId: "OFFLINE/WON", company: "Offline Works", authority: "Test", packageName: "Won package", closingAt: closingAt, tenderValue: 1, stage: "Submitted", status: "Active", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "offline-lost", tenderId: "OFFLINE/LOST", company: "Offline Works", authority: "Test", packageName: "Lost package", closingAt: closingAt, tenderValue: 2, stage: "Submitted", status: "Active", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "offline-pending", tenderId: "OFFLINE/PENDING", company: "Offline Works", authority: "Test", packageName: "Pending package", closingAt: closingAt, tenderValue: 3, stage: "Submitted", status: "Active", createdAt: "2026-01-03T00:00:00.000Z" },
  ] as unknown as import("../shared/domain").Tender[];
  cacheTenders(offlineTenders);
  cacheLifecycleResults([{ tenderId: "offline-won", result: { id: "r1", tenderId: "offline-won", outcome: "Won" } }, { tenderId: "offline-lost", result: { id: "r2", tenderId: "offline-lost", outcome: "Lost" } }]);
  assert(cachedTenders({ result: "Win" }).map((item) => item.tenderId).join() === "OFFLINE/WON", "offline Win filter uses cached lifecycle result");
  assert(cachedTenders({ result: "Lost" }).map((item) => item.tenderId).join() === "OFFLINE/LOST", "offline Lost filter uses cached lifecycle result");
  assert(cachedTenders({ result: "Pending" }).map((item) => item.tenderId).join() === "OFFLINE/PENDING", "offline Pending filter is deterministic for missing results");


  const backupResponse = await fetch(`${baseUrl}/api/backup/export`, { headers: sessionToken ? { "x-session-token": sessionToken } : {} });
  const backupText = await backupResponse.text();
  const backup = JSON.parse(backupText) as { format: string; version: number; tables: Record<string, unknown[]> };
  assert(backupResponse.status === 200 && backupResponse.headers.get("content-disposition")?.includes("tender-tracker-backup") && backup.format === "tender-tracker-backup" && backup.version === 1 && backup.tables.tenders.length >= 2 && backup.tables.purchase_sheets.length >= 1 && backup.tables.bank_profiles.length === 1 && backup.tables.email_templates.length === 1 && !JSON.stringify(backup.tables.bank_profiles).includes("123456789012"), "backup export contains the SQLite ledger and masked bank configuration");

  const invalid = await request("/api/tenders", { method: "POST", body: JSON.stringify({ tenderId: "invalid" }) });
  assert(invalid.status === 400, "invalid create is rejected with 400");

  const updated = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "Closed", packageName: "Updated package" }),
  });
  assert(updated.status === 200 && (updated.body as Tender).status === "Closed", "patch updates tender");

  await stopServer(server);
  server = undefined;
  server = await startServer();
  const restartUnlock = await request("/api/security/unlock", { method: "POST", body: JSON.stringify({ password: "Smoke Correct Horse Battery 123!" }) });
  assert(restartUnlock.status === 200 && Boolean((restartUnlock.body as { token?: string }).token), "restarted server can unlock the protected configuration");
  sessionToken = (restartUnlock.body as { token: string }).token;
  const afterRestart = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}`);
  assert(afterRestart.status === 200 && (afterRestart.body as Tender).status === "Closed", "updated tender survives restart");
  const atomicBatchAfterRestart = await request(`/api/issue-batches/${encodeURIComponent(atomicBatchId)}`);
  const atomicTendersAfterRestart = await request("/api/tenders?authorityZone=Smoke%20Zone");
  assert(atomicBatchAfterRestart.status === 200 && (atomicBatchAfterRestart.body as { tenderCount?: number }).tenderCount === 2 && atomicTendersAfterRestart.status === 200 && Array.isArray(atomicTendersAfterRestart.body) && (atomicTendersAfterRestart.body as Array<Tender>).filter((row) => row.tenderId.startsWith("SMOKE/ATOMIC/")).length === 2, "atomic batch and both tender rows survive restart");
  const blankAfterRestart = await request(`/api/tenders/${encodeURIComponent(blankId)}`);
  assert(blankAfterRestart.status === 200 && (blankAfterRestart.body as Tender).tenderValue === 456000 && (blankAfterRestart.body as Tender).submittedValue === 455000, "nullable tender values survive restart");
  const soonAfterRestart = await request(`/api/tenders/${encodeURIComponent(soonTenderBody.id)}`);
  assert(soonAfterRestart.status === 200 && (soonAfterRestart.body as Tender).submissionAt === (persistedSoon.body as Tender).submissionAt, "submission deadline survives restart");
  const filteredAfterRestart = await request("/api/tenders?tenderId=SMOKE%2FFILTER%2F003&valueMin=500000&valueMax=500000");
  assert(filteredAfterRestart.status === 200 && Array.isArray(filteredAfterRestart.body) && filteredAfterRestart.body.length === 1 && (filteredAfterRestart.body[0] as Tender).tenderId === "SMOKE/FILTER/003", "advanced filter fixture and value bounds survive restart");
  const companiesAfterRestart = await request("/api/companies");
  const managedAfterRestart = Array.isArray(companiesAfterRestart.body) ? companiesAfterRestart.body.find((company) => (company as { id?: string }).id === managedCompanyId) as { contact?: string; notes?: string } | undefined : undefined;
  assert(companiesAfterRestart.status === 200 && managedAfterRestart?.contact === "updated@example.test" && managedAfterRestart.notes === "Updated notes", "company profile survives restart");
  const authoritiesAfterRestart = await request("/api/authorities");
  const authorityAfterRestart = Array.isArray(authoritiesAfterRestart.body) ? authoritiesAfterRestart.body.find((item) => (item as { id?: string }).id === authorityId) as { contact?: string; etenderNotes?: string } | undefined : undefined;
  assert(authoritiesAfterRestart.status === 200 && authorityAfterRestart?.contact === "updated@authority.test" && authorityAfterRestart.etenderNotes === "Updated metadata", "authority profile survives restart");
  const sheetAfterRestart = await request(`/api/purchase-sheets/${encodeURIComponent(createdSheet.id)}`);
  assert(sheetAfterRestart.status === 200 && (sheetAfterRestart.body as { status: string }).status === "Sent to Bank", "purchase sheet survives restart");
  const bankAfterRestart = await request("/api/bank-profile");
  assert(bankAfterRestart.status === 200 && (bankAfterRestart.body as { accountName?: string; accountNumberMasked?: string }).accountName === "Smoke Updated Account" && (bankAfterRestart.body as { accountNumberMasked?: string }).accountNumberMasked === "••••••••1111", "encrypted bank profile survives restart with masked account number");
  const templatesAfterRestart = await request("/api/email-templates");
  assert(templatesAfterRestart.status === 200 && Array.isArray(templatesAfterRestart.body) && (templatesAfterRestart.body as unknown as Array<{ id: string; selected: boolean }>).length === 1 && (templatesAfterRestart.body as unknown as Array<{ id: string; selected: boolean }>)[0].selected, "selected email template survives restart");

  const detailsAfterRestart = await request(`/api/tenders/${encodeURIComponent(createdTender.id)}/details`);
  const persistedDetails = detailsAfterRestart.body as { totalCharges?: number; totalCost?: number; result?: { outcome?: string }; noa?: { noaNumber?: string }; performanceSecurity?: { securityNumber?: string; returnStatus?: string; returnRemarks?: string; remarks?: string }; contractAgreement?: { contractNumber?: string; remarks?: string } };
  assert(detailsAfterRestart.status === 200 && persistedDetails.totalCharges === 2500 && persistedDetails.totalCost === 2500 && persistedDetails.result?.outcome === "Won" && persistedDetails.noa?.noaNumber === "NOA-001" && persistedDetails.performanceSecurity?.securityNumber === "PS-001" && persistedDetails.performanceSecurity.returnStatus === "Returned" && persistedDetails.performanceSecurity.returnRemarks === "Released by bank" && persistedDetails.performanceSecurity.remarks === "Completed security history" && persistedDetails.contractAgreement?.contractNumber === "CA-002" && persistedDetails.contractAgreement.remarks === "Signed and registered", "lifecycle records including returned performance security survive restart");


  const deleted = await request(`/api/tenders/${encodeURIComponent(blankId)}`, { method: "DELETE" });
  assert(deleted.status === 204, "delete returns 204");
  const missing = await request(`/api/tenders/${encodeURIComponent(blankId)}`);
  assert(missing.status === 404, "deleted tender is not found");

  const restored = await request("/api/backup/restore", { method: "POST", body: backupText });
  assert(restored.status === 200 && (restored.body as { ok?: boolean }).ok === true, "backup restore accepts a validated snapshot");
  const restoredTender = await request(`/api/tenders/${encodeURIComponent(blankId)}`);
  assert(restoredTender.status === 200 && (restoredTender.body as Tender).tenderId === "SMOKE/BLANK/001", "restore brings the deleted tender back from the exported snapshot");
  const restoredSheet = await request(`/api/purchase-sheets/${encodeURIComponent(createdSheet.id)}`);
  assert(restoredSheet.status === 200 && (restoredSheet.body as { status: string }).status === "Sent to Bank", "restore brings purchase sheets back");
  const deletedCompany = await request(`/api/companies/${encodeURIComponent(managedCompanyId)}`, { method: "DELETE" });
  assert(deletedCompany.status === 204, "company delete removes an unreferenced profile");

  await stopServer(server);
  server = undefined;
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${seededDatabasePath}${suffix}`, { force: true });
  server = await startServer({ databasePath: seededDatabasePath, seed: true });
  sessionToken = "";
  const seededCompanies = await request("/api/companies");
  const seededRows = Array.isArray(seededCompanies.body) ? seededCompanies.body as Array<{ id?: string; name?: string }> : [];
  const seededNames = seededRows.map((company) => company.name);
  assert(seededCompanies.status === 200 && ["Semu Enterprise", "Kashfia Jerin Enterprise", "Weply"].every((name) => seededNames.filter((candidate) => candidate === name).length === 1), "fresh seeded startup includes each requested default company profile exactly once");
  const seededWeply = seededRows.find((company) => company.name === "Weply");
  assert(Boolean(seededWeply?.id), "seeded Weply profile has a stable id");
  const editedSeeded = await request(`/api/companies/${encodeURIComponent(seededWeply!.id!)}`, { method: "PATCH", body: JSON.stringify({ name: "Weply Owner Edit" }) });
  assert(editedSeeded.status === 200 && (editedSeeded.body as { name?: string }).name === "Weply Owner Edit", "seeded company accepts an owner edit");
  await stopServer(server);
  server = undefined;
  server = await startServer({ databasePath: seededDatabasePath, seed: true });
  const reseededCompanies = await request("/api/companies");
  const reseededRows = Array.isArray(reseededCompanies.body) ? reseededCompanies.body as Array<{ name?: string }> : [];
  assert(reseededCompanies.status === 200 && reseededRows.filter((company) => company.name === "Weply Owner Edit").length === 1 && !reseededRows.some((company) => company.name === "Weply"), "re-running the seed preserves owner edits without creating duplicates");

  console.log("SQLite smoke test passed: tender CRUD, issue batches, purchase sheets, payment instruments, lifecycle results, validation, and restart persistence.");
} finally {
  if (server) await stopServer(server);
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      const path = `${databasePath}${suffix}`;
      if (existsSync(path)) rmSync(path, { force: true, maxRetries: 3 });
    } catch {}
    try {
      const seededPath = `${seededDatabasePath}${suffix}`;
      if (existsSync(seededPath)) rmSync(seededPath, { force: true, maxRetries: 3 });
    } catch {}
  }
}
