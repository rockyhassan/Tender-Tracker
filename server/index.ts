import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { openTenderDatabase } from "./database";
import {
  PgTenderRepository,
  SqliteIssueBatchRepository,
  SqlitePurchaseSheetRepository,
  SqliteTenderRepository,
  type TenderRepository,
} from "./repository";
import { PgCompanyRepository, SqliteCompanyRepository, type CompanyRepository } from "./company-repository";
import { CompanyService, CompanyValidationError } from "./company-service";
import { TenderService, TenderValidationError } from "./service";
import { WorkflowService, WorkflowValidationError } from "./workflow-service";
import { LifecycleRepository, PgLifecycleRepository } from "./lifecycle-repository";
import { LifecycleService, LifecycleValidationError } from "./lifecycle-service";
import { ImportReportService, reportCsv, reportHtml, type DuplicateDecision } from "./import-report-service";
import { exportBackup, restoreBackup, type IBackupProvider, SqliteBackupProvider } from "./backup-service";
import { PostgresBackupProvider } from "./pg-backup-service";
import { SecurityError, SecurityService, sessionTokenFromRequest } from "./security-service";
import { PgBankRepository, SqliteBankRepository, type BankRepository } from "./bank-repository";
import { BankService, BankValidationError } from "./bank-service";
import { reportPdf } from "./report-pdf";
import { AuthorityRepository, AuthorityService, AuthorityValidationError, PgAuthorityRepository, type IAuthorityRepository } from "./authority-service";
import {
  DocumentService,
  DocumentValidationError,
  PgDocumentRepository,
  SqliteDocumentRepository,
  SupabaseDocumentStorage,
  LocalFileDocumentStorage,
  type DocumentStorage,
  type IDocumentRepository,
} from "./document-service";
import { getSupabaseClient, ensureStorageBucket } from "./supabase";
import { automaticBackupStatus, readAutomaticBackup, startAutomaticBackups, writeAutomaticBackup } from "./automatic-backup";
import { getPgPool, getSanitizedPgConfig } from "./postgres";
import { PgIssueBatchRepository, PgPurchaseSheetRepository } from "./pg-workflow-repository";
import { resolve } from "node:path";

// PostgreSQL vs SQLite detection
const pgConfig = getSanitizedPgConfig();
const isPg = pgConfig.connectionMode !== "unconfigured" && process.env.USE_SQLITE !== "1" && process.env.TENDER_DRIVER !== "sqlite";

// Production safety check: do not silently start in SQLite mode when DATABASE_URL is missing in production
if (process.env.NODE_ENV === "production" && !isPg) {
  throw new Error(
    "Fatal: PostgreSQL configuration is missing in production environment (DATABASE_URL is required). SQLite fallback is disabled in production."
  );
}

// SQLite database is only initialized when SQLite mode is active
const database = !isPg
  ? openTenderDatabase({ seed: process.env.TENDER_DB_SEED === "1" || process.env.TENDER_DB_SEED === "true" })
  : null;
const pgPool = isPg ? getPgPool() : null;

export const repository: TenderRepository = isPg && pgPool
  ? new PgTenderRepository(pgPool)
  : new SqliteTenderRepository({ database: database! });

export const companyRepository: CompanyRepository = isPg && pgPool
  ? new PgCompanyRepository(pgPool)
  : new SqliteCompanyRepository(database!);

export const companyService = new CompanyService(companyRepository);

export const issueBatchRepository = isPg && pgPool
  ? new PgIssueBatchRepository(pgPool)
  : new SqliteIssueBatchRepository(database!);

export const purchaseSheetRepository = isPg && pgPool
  ? new PgPurchaseSheetRepository(pgPool)
  : new SqlitePurchaseSheetRepository(database!);

const authorityRepository: IAuthorityRepository = isPg && pgPool
  ? new PgAuthorityRepository(pgPool)
  : new AuthorityRepository(database!);

export const workflowService = new WorkflowService(issueBatchRepository, purchaseSheetRepository, repository, authorityRepository);

export const lifecycleRepository = isPg && pgPool
  ? new PgLifecycleRepository(pgPool, repository)
  : new LifecycleRepository(database!, repository as SqliteTenderRepository);

export const lifecycleService = new LifecycleService(lifecycleRepository);

export const service = new TenderService(repository, lifecycleService, issueBatchRepository);

export const importReportService = new ImportReportService(repository, service, (isPg && pgPool ? pgPool : database)!);

export const securityService = new SecurityService((isPg && pgPool ? pgPool : database)!);

export const bankRepository: BankRepository = isPg && pgPool
  ? new PgBankRepository(pgPool)
  : new SqliteBankRepository(database!);

export const bankService = new BankService(bankRepository, securityService, (isPg && pgPool ? pgPool : database)!);

export const authorityService = new AuthorityService(authorityRepository);

const supabaseClient = isPg ? getSupabaseClient() : null;

export const documentRepository: IDocumentRepository = isPg && pgPool
  ? new PgDocumentRepository(pgPool)
  : new SqliteDocumentRepository(database!);

export const documentStorage: DocumentStorage = supabaseClient
  ? new SupabaseDocumentStorage(supabaseClient, "documents")
  : new LocalFileDocumentStorage();

if (supabaseClient) {
  ensureStorageBucket(supabaseClient, "documents", { isPublic: false }).catch((err) => {
    console.warn("[Supabase Storage] Initialization notice for 'documents' bucket:", err.message);
  });
  ensureStorageBucket(supabaseClient, "backups", { isPublic: false }).catch((err) => {
    console.warn("[Supabase Storage] Initialization notice for 'backups' bucket:", err.message);
  });
}

export const documentService = new DocumentService(documentRepository, documentStorage);

export const backupProvider: IBackupProvider = isPg && pgPool
  ? new PostgresBackupProvider(pgPool, supabaseClient, {
      retention: Math.max(1, Number(process.env.TENDER_BACKUP_RETENTION ?? 7) || 7),
      bucketName: "backups",
    })
  : new SqliteBackupProvider(database!, {
      backupDirectory: resolve(process.env.TENDER_BACKUP_DIR ?? "data/backups"),
      retention: Math.max(1, Number(process.env.TENDER_BACKUP_RETENTION ?? 7) || 7),
    });

export const backupSchedulerTimer = backupProvider.startScheduler();

export const app = express();

app.use(express.json({ limit: "25mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "tender-tracker", driver: isPg ? "postgres" : "sqlite" }));

app.get("/api/security/status", async (req, res, next) => {
  try {
    res.json(await securityService.status(sessionTokenFromRequest(req.headers)));
  } catch (error) {
    next(error);
  }
});
app.post("/api/security/setup", async (req, res, next) => {
  try {
    res.status(201).json(await securityService.setup(req.body?.password, req.body?.recoveryEmail));
  } catch (error) {
    next(error);
  }
});
app.post("/api/security/unlock", async (req, res, next) => {
  try {
    res.json(await securityService.unlock(req.body?.password));
  } catch (error) {
    next(error);
  }
});
app.post("/api/security/lock", async (req, res, next) => {
  try {
    securityService.lock(sessionTokenFromRequest(req.headers));
    res.json({ ok: true, status: await securityService.status() });
  } catch (error) {
    next(error);
  }
});
app.post("/api/security/master-password", async (req, res, next) => {
  try {
    res.json(await securityService.changePassword(sessionTokenFromRequest(req.headers), req.body?.currentPassword, req.body?.password));
  } catch (error) {
    next(error);
  }
});
app.put("/api/security/recovery", async (req, res, next) => {
  try {
    res.json({ status: await securityService.configureRecovery(sessionTokenFromRequest(req.headers), req.body?.recoveryEmail) });
  } catch (error) {
    next(error);
  }
});
app.post("/api/security/recovery/request", async (req, res, next) => {
  try {
    res.json(await securityService.requestRecovery(req.body?.recoveryEmail));
  } catch (error) {
    next(error);
  }
});

app.get("/api/companies", async (req, res, next) => {
  try {
    const summaries = await securityService.listCompanies();
    const result = await Promise.all(
      summaries.map(async (summary) => ({ ...summary, ...(await companyService.get(summary.id)) }))
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});
app.get("/api/companies/:id", async (req, res, next) => {
  try {
    const company = await companyService.get(req.params.id);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const summaries = await securityService.listCompanies();
    res.json({ ...company, ...summaries.find((item) => item.id === company.id) });
  } catch (error) {
    next(error);
  }
});
app.post("/api/companies", async (req, res, next) => {
  try {
    const company = await companyService.create(req.body);
    const summaries = await securityService.listCompanies();
    res.status(201).json({ ...company, ...summaries.find((item) => item.id === company.id) });
  } catch (error) {
    next(error);
  }
});
app.patch("/api/companies/:id", async (req, res, next) => {
  try {
    const company = await companyService.update(req.params.id, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const summaries = await securityService.listCompanies();
    res.json({ ...company, ...summaries.find((item) => item.id === company.id) });
  } catch (error) {
    next(error);
  }
});
app.delete("/api/companies/:id", async (req, res, next) => {
  try {
    if (!(await companyService.delete(req.params.id))) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
app.post("/api/companies/:id/archive", async (req, res, next) => {
  try {
    const company = await companyService.archive(req.params.id, req.body?.archived !== false);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  } catch (error) {
    next(error);
  }
});
app.get("/api/companies/:id/credentials", async (req, res, next) => {
  try {
    const credentials = await securityService.getCredentials(sessionTokenFromRequest(req.headers), req.params.id);
    if (!credentials) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(credentials);
  } catch (error) {
    next(error);
  }
});
app.put("/api/companies/:id/credentials", async (req, res, next) => {
  try {
    const summary = await securityService.saveCredentials(sessionTokenFromRequest(req.headers), req.params.id, req.body?.username, req.body?.password);
    if (!summary) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(summary);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/companies/:id/credentials", async (req, res, next) => {
  try {
    if (!(await securityService.clearCredentials(sessionTokenFromRequest(req.headers), req.params.id))) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/api/bank-profile", async (req, res, next) => {
  try {
    res.json((await bankService.getProfile(sessionTokenFromRequest(req.headers))) ?? null);
  } catch (error) {
    next(error);
  }
});
app.put("/api/bank-profile", async (req, res, next) => {
  try {
    res.json(await bankService.saveProfile(sessionTokenFromRequest(req.headers), req.body));
  } catch (error) {
    next(error);
  }
});
app.get("/api/email-templates", async (_req, res, next) => {
  try {
    res.json(await bankService.listTemplates());
  } catch (error) {
    next(error);
  }
});
app.post("/api/email-templates", async (req, res, next) => {
  try {
    res.status(201).json(await bankService.createTemplate(req.body));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/email-templates/:id", async (req, res, next) => {
  try {
    const template = await bankService.updateTemplate(req.params.id, req.body);
    if (!template) {
      res.status(404).json({ error: "Email template not found" });
      return;
    }
    res.json(template);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/email-templates/:id", async (req, res, next) => {
  try {
    if (!(await bankService.deleteTemplate(req.params.id))) {
      res.status(404).json({ error: "Email template not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
app.put("/api/email-templates/:id/select", async (req, res, next) => {
  try {
    const template = await bankService.selectTemplate(req.params.id);
    if (!template) {
      res.status(404).json({ error: "Email template not found" });
      return;
    }
    res.json(template);
  } catch (error) {
    next(error);
  }
});

app.get("/api/authorities", async (_req, res, next) => {
  try {
    res.json(await authorityService.list());
  } catch (error) {
    next(error);
  }
});
app.get("/api/authorities/:id", async (req, res, next) => {
  try {
    const item = await authorityService.get(req.params.id);
    if (!item) {
      res.status(404).json({ error: "Authority not found" });
      return;
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
});
app.post("/api/authorities", async (req, res, next) => {
  try {
    res.status(201).json(await authorityService.create(req.body));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/authorities/:id", async (req, res, next) => {
  try {
    const item = await authorityService.update(req.params.id, req.body);
    if (!item) {
      res.status(404).json({ error: "Authority not found" });
      return;
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/authorities/:id", async (req, res, next) => {
  try {
    if (!(await authorityService.delete(req.params.id))) {
      res.status(404).json({ error: "Authority not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
app.get("/api/documents", async (req, res, next) => {
  try {
    res.json(await documentService.list({ tenderId: typeof req.query.tenderId === "string" ? req.query.tenderId : undefined, authorityId: typeof req.query.authorityId === "string" ? req.query.authorityId : undefined }));
  } catch (error) {
    next(error);
  }
});
app.post("/api/documents", async (req, res, next) => {
  try {
    res.status(201).json(await documentService.create(req.body));
  } catch (error) {
    next(error);
  }
});
app.get("/api/documents/:id/download", async (req, res, next) => {
  try {
    const found = await documentService.read(req.params.id);
    if (!found) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.type(found.item.mimeType).setHeader("Content-Disposition", `attachment; filename="${found.item.fileName.replace(/"/g, "")}"`).send(found.bytes);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/documents/:id", async (req, res, next) => {
  try {
    if (!(await documentService.delete(req.params.id))) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
app.get("/api/backup/automatic", async (_req, res, next) => {
  try {
    res.json(await backupProvider.getStatus());
  } catch (error) {
    next(error);
  }
});
function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

app.post("/api/backup/now", async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const cronSecretHeader = req.headers["x-cron-secret"];
    const cronSecret = process.env.CRON_SECRET;

    let authorized = false;

    let providedSecret: string | undefined;
    if (typeof authHeader === "string") {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) providedSecret = match[1].trim();
    }
    if (!providedSecret && typeof cronSecretHeader === "string") {
      providedSecret = cronSecretHeader.trim();
    }

    if (providedSecret) {
      if (cronSecret && constantTimeCompare(providedSecret, cronSecret)) {
        authorized = true;
      } else {
        res.status(401).json({ error: "Unauthorized: Invalid cron secret" });
        return;
      }
    }

    if (!authorized) {
      const token = sessionTokenFromRequest(req.headers);
      if (token) {
        try {
          securityService.requireSession(token);
          authorized = true;
        } catch {
          // invalid or expired session
        }
      }
    }

    if (!authorized) {
      res.status(401).json({ error: "Unauthorized: Valid CRON_SECRET or application session required" });
      return;
    }

    res.json(await backupProvider.writeAutomaticBackup());
  } catch (error) {
    next(error);
  }
});
app.get("/api/backup/automatic/:fileName", async (req, res, next) => {
  try {
    securityService.requireSession(sessionTokenFromRequest(req.headers));
    const backup = await backupProvider.readAutomaticBackup(req.params.fileName);
    res.type("application/json").setHeader("Content-Disposition", `attachment; filename=${req.params.fileName}`).send(backup.data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/backup/export", async (req, res, next) => {
  try {
    securityService.requireSession(sessionTokenFromRequest(req.headers));
    const filename = `tender-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const snapshot = await backupProvider.exportBackup();
    res.type("application/json").setHeader("Content-Disposition", `attachment; filename=${filename}`).send(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    next(error);
  }
});
app.post("/api/backup/restore", async (req, res, next) => {
  try {
    if (!backupProvider.isRestoreSupported()) {
      res.status(400).json({
        error: "Database restore in PostgreSQL mode is managed via Supabase Platform (PITR/backups) to prevent destructive cloud data loss.",
      });
      return;
    }
    res.json({ ok: true, ...(await backupProvider.restoreBackup(req.body)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tenders", async (req, res, next) => {
  try {
    res.json(await service.list(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tenders", async (req, res, next) => {
  try {
    res.status(201).json(await service.create(req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/issue-batches/:id/tenders/bulk", async (req, res, next) => {
  try {
    res.status(200).json(await service.bulkCreateForBatch({ issueBatchId: req.params.id, rows: req.body?.rows }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tenders/:id", async (req, res, next) => {
  try {
    const tender = await service.get(req.params.id);
    if (!tender) {
      res.status(404).json({ error: "Tender not found" });
      return;
    }
    res.json(tender);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/tenders/:id", async (req, res, next) => {
  try {
    const tender = await service.update(req.params.id, req.body);
    if (!tender) {
      res.status(404).json({ error: "Tender not found" });
      return;
    }
    res.json(tender);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/tenders/:id", async (req, res, next) => {
  try {
    if (!(await service.delete(req.params.id))) {
      res.status(404).json({ error: "Tender not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot delete tender")) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

// Tender-wise payment instruments and lifecycle records.
app.get("/api/tenders/:id/details", async (req, res, next) => {
  try {
    const details = await lifecycleService.details(req.params.id);
    if (!details) {
      res.status(404).json({ error: "Tender not found" });
      return;
    }
    res.json(details);
  } catch (error) {
    next(error);
  }
});
app.get("/api/tender-lifecycle", async (_req, res, next) => {
  try {
    res.json(await lifecycleRepository.resultCache());
  } catch (error) {
    next(error);
  }
});
app.get("/api/pay-orders", async (_req, res, next) => {
  try {
    res.json(await lifecycleRepository.listAllPayOrders());
  } catch (error) {
    next(error);
  }
});
app.get("/api/performance-securities", async (_req, res, next) => {
  try {
    res.json(await lifecycleRepository.listAllPerformanceSecurities());
  } catch (error) {
    next(error);
  }
});
app.post("/api/tenders/:id/charges", async (req, res, next) => {
  try {
    res.status(201).json(await lifecycleService.createCharge(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/tenders/:id/charges/:chargeId", async (req, res, next) => {
  try {
    const item = await lifecycleService.updateCharge(req.params.id, req.params.chargeId, req.body);
    if (!item) {
      res.status(404).json({ error: "Charge not found" });
      return;
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/tenders/:id/charges/:chargeId", async (req, res, next) => {
  try {
    if (!(await lifecycleService.deleteCharge(req.params.id, req.params.chargeId))) {
      res.status(404).json({ error: "Charge not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
app.post("/api/tenders/:id/pay-orders", async (req, res, next) => {
  try {
    res.status(201).json(await lifecycleService.createPayOrder(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/tenders/:id/pay-orders/:orderId", async (req, res, next) => {
  try {
    const item = await lifecycleService.updatePayOrder(req.params.id, req.params.orderId, req.body);
    if (!item) {
      res.status(404).json({ error: "Pay Order not found" });
      return;
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/tenders/:id/pay-orders/:orderId", async (req, res, next) => {
  try {
    if (!(await lifecycleService.deletePayOrder(req.params.id, req.params.orderId))) {
      res.status(404).json({ error: "Pay Order not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
app.post("/api/tenders/:id/credit-commitment-certificates", async (req, res, next) => {
  try {
    res.status(201).json(await lifecycleService.createCertificate(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/tenders/:id/credit-commitment-certificates/:certificateId", async (req, res, next) => {
  try {
    const item = await lifecycleService.updateCertificate(req.params.id, req.params.certificateId, req.body);
    if (!item) {
      res.status(404).json({ error: "Certificate not found" });
      return;
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/tenders/:id/credit-commitment-certificates/:certificateId", async (req, res, next) => {
  try {
    if (!(await lifecycleService.deleteCertificate(req.params.id, req.params.certificateId))) {
      res.status(404).json({ error: "Certificate not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
app.put("/api/tenders/:id/result", async (req, res, next) => {
  try {
    res.json(await lifecycleService.upsertResult(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});
app.put("/api/tenders/:id/noa", async (req, res, next) => {
  try {
    res.json(await lifecycleService.upsertNoa(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});
app.put("/api/tenders/:id/performance-security", async (req, res, next) => {
  try {
    res.json(await lifecycleService.upsertSecurity(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});
app.put("/api/tenders/:id/contract-agreement", async (req, res, next) => {
  try {
    res.json(await lifecycleService.upsertContractAgreement(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});
app.post("/api/tenders/:id/contract-agreements", async (req, res, next) => {
  try {
    res.status(201).json(await lifecycleService.upsertContractAgreement(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/tenders/:id/contract-agreement/:agreementId", async (req, res, next) => {
  try {
    const item = await lifecycleService.updateContractAgreement(req.params.id, req.params.agreementId, req.body);
    if (!item) {
      res.status(404).json({ error: "Contract Agreement not found" });
      return;
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
});
app.patch("/api/tenders/:id/contract-agreements/:agreementId", async (req, res, next) => {
  try {
    const item = await lifecycleService.updateContractAgreement(req.params.id, req.params.agreementId, req.body);
    if (!item) {
      res.status(404).json({ error: "Contract Agreement not found" });
      return;
    }
    res.json(item);
  } catch (error) {
    next(error);
  }
});

app.get("/api/issue-batches", async (req, res, next) => {
  try {
    res.json(await workflowService.listBatches(req.query));
  } catch (error) {
    next(error);
  }
});
app.post("/api/issue-batches", async (req, res, next) => {
  try {
    res.status(201).json(await workflowService.createBatch(req.body));
  } catch (error) {
    next(error);
  }
});
app.post("/api/issue-batches/with-tenders", async (req, res, next) => {
  try {
    res.status(201).json(await workflowService.createBatchWithTenders(req.body));
  } catch (error) {
    next(error);
  }
});
app.get("/api/issue-batches/:id", async (req, res, next) => {
  try {
    const batch = await workflowService.getBatch(req.params.id);
    if (!batch) {
      res.status(404).json({ error: "Issue batch not found" });
      return;
    }
    res.json(batch);
  } catch (error) {
    next(error);
  }
});
app.patch("/api/issue-batches/:id", async (req, res, next) => {
  try {
    const batch = await workflowService.updateBatch(req.params.id, req.body);
    if (!batch) {
      res.status(404).json({ error: "Issue batch not found" });
      return;
    }
    res.json(batch);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/issue-batches/:id", async (req, res, next) => {
  try {
    if (!(await workflowService.deleteBatch(req.params.id))) {
      res.status(404).json({ error: "Issue batch not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot delete issue batch")) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/api/purchase-sheets", async (req, res, next) => {
  try {
    res.json(await workflowService.listSheets(req.query));
  } catch (error) {
    next(error);
  }
});
app.post("/api/purchase-sheets", async (req, res, next) => {
  try {
    res.status(201).json(await workflowService.createSheet(req.body));
  } catch (error) {
    next(error);
  }
});
app.get("/api/purchase-sheets/:id", async (req, res, next) => {
  try {
    const sheet = await workflowService.getSheet(req.params.id);
    if (!sheet) {
      res.status(404).json({ error: "Purchase sheet not found" });
      return;
    }
    res.json(sheet);
  } catch (error) {
    next(error);
  }
});
app.patch("/api/purchase-sheets/:id", async (req, res, next) => {
  try {
    const sheet = await workflowService.updateSheet(req.params.id, req.body);
    if (!sheet) {
      res.status(404).json({ error: "Purchase sheet not found" });
      return;
    }
    res.json(sheet);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/purchase-sheets/:id", async (req, res, next) => {
  try {
    if (!(await workflowService.deleteSheet(req.params.id))) {
      res.status(404).json({ error: "Purchase sheet not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot delete purchase sheet")) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/api/deadlines/summary", async (_req, res, next) => {
  try {
    res.json(await service.deadlineSummary());
  } catch (error) {
    next(error);
  }
});
app.get("/api/dashboard/pending-work", async (_req, res, next) => {
  try {
    res.json(await service.pendingWorkSummary());
  } catch (error) {
    next(error);
  }
});
app.get("/api/dashboard/summary", async (_req, res, next) => {
  try {
    res.json(await service.dashboardSummary());
  } catch (error) {
    next(error);
  }
});

app.post("/api/import/preview", async (req, res, next) => {
  try {
    res.json(await importReportService.preview(req.body));
  } catch (error) {
    next(error);
  }
});
app.post("/api/import/commit", async (req, res, next) => {
  try {
    res.json(await importReportService.commit(req.body.preview, req.body.decisions as Record<string, DuplicateDecision> | undefined));
  } catch (error) {
    next(error);
  }
});

app.get("/api/reports/:type.csv", async (req, res, next) => {
  try {
    const report = await importReportService.report(req.params.type, req.query);
    res.type("text/csv").setHeader("Content-Disposition", `attachment; filename=${req.params.type}.csv`).send(reportCsv(report));
  } catch (error) {
    next(error);
  }
});
app.get("/api/reports/:type.pdf", async (req, res, next) => {
  try {
    const report = await importReportService.report(req.params.type, req.query);
    const context = Object.fromEntries(Object.entries(req.query).filter(([, value]) => typeof value === "string" && value !== ""));
    const pdf = await reportPdf(report, context);
    res.type("application/pdf").setHeader("Content-Disposition", `attachment; filename=${req.params.type}.pdf`).send(pdf);
  } catch (error) {
    next(error);
  }
});
app.get("/api/reports/:type/print", async (req, res, next) => {
  try {
    res.type("html").send(reportHtml(await importReportService.report(req.params.type, req.query)));
  } catch (error) {
    next(error);
  }
});
app.get("/api/reports/:type", async (req, res, next) => {
  try {
    res.json(await importReportService.report(req.params.type, req.query));
  } catch (error) {
    next(error);
  }
});

// Production static frontend serving
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(process.cwd(), "dist");
  app.use(express.static(distDir));

  // SPA fallback for non-API GET routes
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      return next();
    }
    res.sendFile(resolve(distDir, "index.html"));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof SecurityError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (
    error instanceof TenderValidationError ||
    error instanceof CompanyValidationError ||
    error instanceof WorkflowValidationError ||
    error instanceof LifecycleValidationError ||
    error instanceof BankValidationError ||
    error instanceof AuthorityValidationError ||
    error instanceof DocumentValidationError
  ) {
    res.status(400).json({ error: error.message, issues: "issues" in error ? error.issues : [] });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT || 8787);
const isDirectRun = Boolean(
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
);
if (isDirectRun) {
  app.listen(port, "0.0.0.0", () => console.log(`Tender Tracker API listening on ${port} (${isPg ? "PostgreSQL" : "SQLite"})`));
}
