import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { Tender, TenderListQuery, UpdateTenderInput } from "../shared/domain";
import { openTenderDatabase } from "./database";

export interface TenderRepository {
  list(query?: TenderListQuery): Promise<Tender[]> | Tender[];
  findById(id: string): Promise<Tender | undefined> | Tender | undefined;
  findByTenderId(tenderId: string): Promise<Tender | undefined> | Tender | undefined;
  create(tender: Omit<Tender, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Tender> | Tender;
  createBulk(tenders: Array<Omit<Tender, "id" | "createdAt" | "updatedAt"> & { id?: string }>): Promise<Tender[]> | Tender[];
  update(id: string, changes: UpdateTenderInput): Promise<Tender | undefined> | Tender | undefined;
  delete(id: string): Promise<boolean> | boolean;
  countPurchaseSheetLines?(tenderId: string): Promise<number> | number;
  countCharges?(tenderId: string): Promise<number> | number;
  countPayOrders?(tenderId: string): Promise<number> | number;
  countCertificates?(tenderId: string): Promise<number> | number;
  countResults?(tenderId: string): Promise<number> | number;
  countNoa?(tenderId: string): Promise<number> | number;
  countPerformanceSecurities?(tenderId: string): Promise<number> | number;
  countContractAgreements?(tenderId: string): Promise<number> | number;
  countDocuments?(tenderId: string): Promise<number> | number;
}

const clone = (tender: Tender): Tender => ({ ...tender });

type TenderRow = {
  id: string;
  tender_id: string;
  company_id: string | null;
  company_name: string | null;
  authority: string;
  authority_zone: string | null;
  issue_batch_id: string | null;
  package_name: string;
  closing_at: string;
  submission_at: string | null;
  tender_value: number | null;
  submitted_value: number | null;
  stage: Tender["stage"];
  status: Tender["status"];
  created_at: string;
  updated_at: string;
};

const TENDER_SELECT = `
  SELECT
    t.id, t.tender_id, t.company_id, c.name AS company_name,
    t.authority, t.authority_zone, t.issue_batch_id, t.package_name,
    t.closing_at, t.submission_at, t.tender_value, t.submitted_value, t.stage, t.status,
    t.created_at, t.updated_at
  FROM tenders t
  LEFT JOIN companies c ON c.id = t.company_id
`;

const toTender = (row: TenderRow): Tender => ({
  id: row.id,
  tenderId: row.tender_id,
  company: row.company_name ?? "Unassigned",
  companyId: row.company_id ?? undefined,
  authority: row.authority,
  authorityZone: row.authority_zone ?? undefined,
  issueBatchId: row.issue_batch_id ?? undefined,
  packageName: row.package_name,
  closingAt: row.closing_at,
  submissionAt: row.submission_at ?? undefined,
  tenderValue: row.tender_value == null ? undefined : Number(row.tender_value),
  submittedValue: row.submitted_value == null ? undefined : Number(row.submitted_value),
  stage: row.stage,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const asRows = (rows: Record<string, SQLOutputValue>[]): TenderRow[] => rows as unknown as TenderRow[];

const contains = (value: string): string => `%${value.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
const dateBoundary = (value: string | undefined, end: boolean): string | undefined => {
  if (!value) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : value;
};
const resultOutcome = (value: TenderListQuery["result"]): "Won" | "Lost" | "Pending" | undefined => value === "Win" ? "Won" : value;

export interface SqliteTenderRepositoryOptions {
  path?: string;
  database?: DatabaseSync;
}

/** Persistent local repository backed by the native Node 22 SQLite driver. */
export class SqliteTenderRepository implements TenderRepository {
  private readonly database: DatabaseSync;
  private readonly ownsDatabase: boolean;

  constructor(options: string | SqliteTenderRepositoryOptions = {}) {
    if (typeof options === "string") {
      this.database = openTenderDatabase({ path: options });
      this.ownsDatabase = true;
    } else if (options.database) {
      this.database = options.database;
      this.ownsDatabase = false;
    } else {
      this.database = openTenderDatabase({ path: options.path });
      this.ownsDatabase = true;
    }
  }

  list(query: TenderListQuery = {}): Tender[] {
    const clauses: string[] = [];
    const params: SQLOutputValue[] = [];
    if (query.companyId) {
      clauses.push("t.company_id = ?");
      params.push(query.companyId);
    }
    if (query.tenderId) {
      clauses.push("LOWER(t.tender_id) LIKE ? ESCAPE '\\'");
      params.push(contains(query.tenderId));
    }
    if (query.company) {
      clauses.push("LOWER(c.name) LIKE ? ESCAPE '\\'");
      params.push(contains(query.company));
    }
    if (query.authority) {
      clauses.push("LOWER(t.authority) LIKE ? ESCAPE '\\'");
      params.push(contains(query.authority));
    }
    if (query.authorityZone) {
      clauses.push("LOWER(t.authority || ' ' || COALESCE(t.authority_zone, '')) LIKE ? ESCAPE '\\'");
      params.push(contains(query.authorityZone));
    }
    if (query.packageName) {
      clauses.push("LOWER(t.package_name) LIKE ? ESCAPE '\\'");
      params.push(contains(query.packageName));
    }
    if (query.status) {
      clauses.push("t.status = ?");
      params.push(query.status);
    }
    if (query.stage) {
      clauses.push("t.stage = ?");
      params.push(query.stage);
    }
    if (query.q) {
      clauses.push("LOWER(t.tender_id || ' ' || COALESCE(c.name, '') || ' ' || t.authority || ' ' || t.package_name) LIKE ?");
      params.push(contains(query.q));
    }
    const closingFrom = dateBoundary(query.closingFrom ?? query.closingDateFrom, false);
    const closingTo = dateBoundary(query.closingTo ?? query.closingDateTo, true);
    const submissionFrom = dateBoundary(query.submissionFrom ?? query.submissionDateFrom, false);
    const submissionTo = dateBoundary(query.submissionTo ?? query.submissionDateTo, true);
    if (closingFrom) { clauses.push("t.closing_at >= ?"); params.push(closingFrom); }
    if (closingTo) { clauses.push("t.closing_at <= ?"); params.push(closingTo); }
    if (submissionFrom) { clauses.push("t.submission_at IS NOT NULL AND t.submission_at >= ?"); params.push(submissionFrom); }
    if (submissionTo) { clauses.push("t.submission_at IS NOT NULL AND t.submission_at <= ?"); params.push(submissionTo); }
    const valueMin = query.valueMin ?? query.tenderValueMin;
    const valueMax = query.valueMax ?? query.tenderValueMax;
    if (valueMin !== undefined) { clauses.push("t.tender_value >= ?"); params.push(valueMin); }
    if (valueMax !== undefined) { clauses.push("t.tender_value <= ?"); params.push(valueMax); }
    const outcome = resultOutcome(query.result);
    if (outcome === "Pending") {
      clauses.push("(NOT EXISTS (SELECT 1 FROM results r WHERE r.tender_id = t.id) OR EXISTS (SELECT 1 FROM results r WHERE r.tender_id = t.id AND r.outcome = 'Pending'))");
    } else if (outcome) {
      clauses.push("EXISTS (SELECT 1 FROM results r WHERE r.tender_id = t.id AND r.outcome = ?)");
      params.push(outcome);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`${TENDER_SELECT}${where} ORDER BY t.created_at ASC, t.id ASC`)
      .all(...params);
    return asRows(rows).map(toTender).map(clone);
  }

  findById(id: string): Tender | undefined {
    const row = this.database.prepare(`${TENDER_SELECT} WHERE t.id = ?`).get(id);
    return row ? clone(toTender(row as unknown as TenderRow)) : undefined;
  }

  findByTenderId(tenderId: string): Tender | undefined {
    const row = this.database.prepare(`${TENDER_SELECT} WHERE LOWER(t.tender_id) = LOWER(?) ORDER BY t.created_at ASC LIMIT 1`).get(tenderId);
    return row ? clone(toTender(row as unknown as TenderRow)) : undefined;
  }

  private resolveCompanyId(companyName: string | undefined, explicitCompanyId: string | undefined): { companyId: string | null; companyName: string } {
    const trimmed = companyName?.trim();
    if (explicitCompanyId) {
      return { companyId: explicitCompanyId, companyName: trimmed || "Unassigned" };
    }
    if (!trimmed) {
      return { companyId: null, companyName: "Unassigned" };
    }
    const existing = this.database.prepare(
      "SELECT id, name FROM companies WHERE name = ? COLLATE NOCASE LIMIT 1"
    ).get(trimmed) as { id: string; name: string } | undefined;

    if (existing) {
      return { companyId: existing.id, companyName: existing.name };
    }
    return { companyId: randomUUID(), companyName: trimmed };
  }

  create(tender: Omit<Tender, "id" | "createdAt" | "updatedAt"> & { id?: string }): Tender {
    const now = new Date().toISOString();
    const id = tender.id ?? randomUUID();
    if (tender.id) {
      const existing = this.findById(tender.id);
      if (existing) return existing;
    }
    const { companyId, companyName } = this.resolveCompanyId(tender.company, tender.companyId);

    this.database.exec("BEGIN");
    try {
      if (companyId) this.database.prepare(`
        INSERT INTO companies (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
      `).run(companyId, companyName, now, now);
      this.database.prepare(`
        INSERT INTO tenders
          (id, tender_id, company_id, issue_batch_id, authority, authority_zone,
           package_name, closing_at, submission_at, tender_value, submitted_value, stage, status,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        tender.tenderId,
        companyId,
        tender.issueBatchId ?? null,
        tender.authority,
        tender.authorityZone ?? null,
        tender.packageName,
        tender.closingAt,
        tender.submissionAt ?? null,
        tender.tenderValue ?? null,
        tender.submittedValue ?? null,
        tender.stage,
        tender.status,
        now,
        now,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return this.findById(id) as Tender;
  }

  createBulk(tenders: Array<Omit<Tender, "id" | "createdAt" | "updatedAt"> & { id?: string }>): Tender[] {
    const now = new Date().toISOString();
    const ids = tenders.map((tender) => tender.id ?? randomUUID());
    this.database.exec("BEGIN");
    try {
      const companyLookup = this.database.prepare("SELECT id, name FROM companies WHERE name = ? COLLATE NOCASE LIMIT 1");
      const companyInsert = this.database.prepare("INSERT INTO companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at");
      const tenderInsert = this.database.prepare("INSERT INTO tenders (id, tender_id, company_id, issue_batch_id, authority, authority_zone, package_name, closing_at, submission_at, tender_value, submitted_value, stage, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const batchCompanyCache = new Map<string, { id: string; name: string }>();

      tenders.forEach((tender, index) => {
        const id = ids[index];
        const trimmed = tender.company?.trim();
        let companyId: string | null = tender.companyId ?? null;
        let companyName = trimmed || "Unassigned";

        if (tender.companyId) {
          companyId = tender.companyId;
        } else if (trimmed) {
          const lower = trimmed.toLowerCase();
          const cached = batchCompanyCache.get(lower);
          if (cached) {
            companyId = cached.id;
            companyName = cached.name;
          } else {
            const existing = companyLookup.get(trimmed) as { id: string; name: string } | undefined;
            if (existing) {
              companyId = existing.id;
              companyName = existing.name;
            } else {
              companyId = randomUUID();
            }
            batchCompanyCache.set(lower, { id: companyId, name: companyName });
          }
        }

        if (companyId) companyInsert.run(companyId, companyName, now, now);
        tenderInsert.run(id, tender.tenderId, companyId, tender.issueBatchId ?? null, tender.authority, tender.authorityZone ?? null, tender.packageName, tender.closingAt, tender.submissionAt ?? null, tender.tenderValue ?? null, tender.submittedValue ?? null, tender.stage, tender.status, now, now);
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return ids.map((id) => this.findById(id)).filter((tender): tender is Tender => Boolean(tender));
  }

  update(id: string, changes: UpdateTenderInput): Tender | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    let nextCompanyId = existing.companyId ?? null;
    let companyNameToUpsert: string | null = null;

    if (changes.companyId !== undefined) {
      nextCompanyId = changes.companyId || null;
      if (changes.company !== undefined) {
        companyNameToUpsert = changes.company.trim() || "Unassigned";
      }
    } else if (changes.company !== undefined) {
      const resolved = this.resolveCompanyId(changes.company, undefined);
      nextCompanyId = resolved.companyId;
      companyNameToUpsert = resolved.companyName;
    }

    const fields: Array<[string, SQLOutputValue]> = [];
    if (changes.tenderId !== undefined) fields.push(["tender_id", changes.tenderId]);
    if (changes.authority !== undefined) fields.push(["authority", changes.authority]);
    if (changes.authorityZone !== undefined) fields.push(["authority_zone", changes.authorityZone]);
    if (changes.issueBatchId !== undefined) fields.push(["issue_batch_id", changes.issueBatchId]);
    if (changes.packageName !== undefined) fields.push(["package_name", changes.packageName]);
    if (changes.closingAt !== undefined) fields.push(["closing_at", changes.closingAt]);
    if (changes.submissionAt !== undefined) fields.push(["submission_at", changes.submissionAt ?? null]);
    if (changes.tenderValue !== undefined) fields.push(["tender_value", changes.tenderValue]);
    if (changes.submittedValue !== undefined) fields.push(["submitted_value", changes.submittedValue]);
    if (changes.stage !== undefined) fields.push(["stage", changes.stage]);
    if (changes.status !== undefined) fields.push(["status", changes.status]);
    if (changes.companyId !== undefined || changes.company !== undefined) fields.push(["company_id", nextCompanyId]);

    this.database.exec("BEGIN");
    try {
      if (nextCompanyId && companyNameToUpsert) {
        this.database.prepare(`
          INSERT INTO companies (id, name, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
        `).run(nextCompanyId, companyNameToUpsert, now, now);
      }
      if (fields.length > 0) {
        fields.push(["updated_at", now]);
        const assignments = fields.map(([field]) => `${field} = ?`).join(", ");
        this.database.prepare(`UPDATE tenders SET ${assignments} WHERE id = ?`).run(
          ...fields.map(([, value]) => value),
          id,
        );
      } else {
        this.database.prepare("UPDATE tenders SET updated_at = ? WHERE id = ?").run(now, id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return this.findById(id);
  }

  countPurchaseSheetLines(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM purchase_sheet_lines WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countCharges(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM charges WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countPayOrders(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM pay_orders WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countCertificates(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM credit_commitment_certificates WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countResults(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM results WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countNoa(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM noa WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countPerformanceSecurities(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM performance_securities WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countContractAgreements(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM contract_agreements WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countDocuments(tenderId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM documents WHERE tender_id = ?").get(tenderId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  delete(id: string): boolean {
    const sheetLineCount = this.countPurchaseSheetLines(id);
    if (sheetLineCount > 0) {
      throw new Error(`Cannot delete tender: it is assigned to ${sheetLineCount} purchase sheet(s). Remove it from the purchase sheet first.`);
    }
    const payOrderCount = this.countPayOrders(id);
    if (payOrderCount > 0) {
      throw new Error(`Cannot delete tender: it is linked to ${payOrderCount} pay order(s).`);
    }
    const chargeCount = this.countCharges(id);
    if (chargeCount > 0) {
      throw new Error(`Cannot delete tender: it is linked to ${chargeCount} financial charge record(s).`);
    }
    const certificateCount = this.countCertificates(id);
    if (certificateCount > 0) {
      throw new Error(`Cannot delete tender: it is linked to ${certificateCount} credit commitment certificate(s).`);
    }
    const resultCount = this.countResults(id);
    if (resultCount > 0) {
      throw new Error("Cannot delete tender: it has a recorded evaluation result.");
    }
    const noaCount = this.countNoa(id);
    if (noaCount > 0) {
      throw new Error("Cannot delete tender: it has an associated Notification of Award (NOA).");
    }
    const securityCount = this.countPerformanceSecurities(id);
    if (securityCount > 0) {
      throw new Error(`Cannot delete tender: it is linked to ${securityCount} performance security record(s).`);
    }
    const contractCount = this.countContractAgreements(id);
    if (contractCount > 0) {
      throw new Error("Cannot delete tender: it has an associated contract agreement.");
    }
    const documentCount = this.countDocuments(id);
    if (documentCount > 0) {
      throw new Error(`Cannot delete tender: it has ${documentCount} attached document(s). Remove documents first.`);
    }

    try {
      const result = this.database.prepare("DELETE FROM tenders WHERE id = ?").run(id);
      return (result as { changes: number }).changes > 0;
    } catch (error) {
      if (error instanceof Error && /FOREIGN KEY/i.test(error.message)) {
        throw new Error("Cannot delete tender: dependent records exist.");
      }
      throw error;
    }
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}

// Compatibility aliases make the adapter discoverable without changing service consumers.
export const SQLiteTenderRepository = SqliteTenderRepository;
export { PgTenderRepository } from "./pg-repository";

export { SqliteIssueBatchRepository, SqlitePurchaseSheetRepository } from "./workflow-repository";
export type { IssueBatchRepository, PurchaseSheetRepository } from "./workflow-repository";

/** @deprecated Use SqliteTenderRepository. Kept for consumers that imported the old class. */
export class InMemoryTenderRepository implements TenderRepository {
  private readonly tenders = new Map<string, Tender>();

  constructor(initial: Tender[] = []) {
    initial.forEach((tender) => this.tenders.set(tender.id, clone(tender)));
  }

  list(query: TenderListQuery = {}): Tender[] {
    const normalizedQuery = query.q?.toLowerCase();
    const normalizedTenderId = query.tenderId?.toLowerCase();
    const normalizedCompany = query.company?.toLowerCase();
    const normalizedAuthority = query.authority?.toLowerCase();
    const normalizedAuthorityZone = query.authorityZone?.toLowerCase();
    const normalizedPackage = query.packageName?.toLowerCase();
    const closingFrom = dateBoundary(query.closingFrom ?? query.closingDateFrom, false);
    const closingTo = dateBoundary(query.closingTo ?? query.closingDateTo, true);
    const submissionFrom = dateBoundary(query.submissionFrom ?? query.submissionDateFrom, false);
    const submissionTo = dateBoundary(query.submissionTo ?? query.submissionDateTo, true);
    const valueMin = query.valueMin ?? query.tenderValueMin;
    const valueMax = query.valueMax ?? query.tenderValueMax;
    return [...this.tenders.values()]
      .filter((tender) => !query.companyId || tender.companyId === query.companyId)
      .filter((tender) => !normalizedTenderId || tender.tenderId.toLowerCase().includes(normalizedTenderId))
      .filter((tender) => !normalizedCompany || tender.company.toLowerCase().includes(normalizedCompany))
      .filter((tender) => !normalizedAuthority || tender.authority.toLowerCase().includes(normalizedAuthority))
      .filter((tender) => !normalizedAuthorityZone || `${tender.authority} ${tender.authorityZone ?? ""}`.toLowerCase().includes(normalizedAuthorityZone))
      .filter((tender) => !normalizedPackage || tender.packageName.toLowerCase().includes(normalizedPackage))
      .filter((tender) => !query.status || tender.status === query.status)
      .filter((tender) => !query.stage || tender.stage === query.stage)
      .filter((tender) => !closingFrom || tender.closingAt >= closingFrom)
      .filter((tender) => !closingTo || tender.closingAt <= closingTo)
      .filter((tender) => !submissionFrom || Boolean(tender.submissionAt && tender.submissionAt >= submissionFrom))
      .filter((tender) => !submissionTo || Boolean(tender.submissionAt && tender.submissionAt <= submissionTo))
      .filter((tender) => valueMin === undefined || tender.tenderValue !== undefined && tender.tenderValue >= valueMin)
      .filter((tender) => valueMax === undefined || tender.tenderValue !== undefined && tender.tenderValue <= valueMax)
      .filter((tender) => {
        if (!normalizedQuery) return true;
        return `${tender.tenderId} ${tender.company} ${tender.authority} ${tender.packageName}`
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .map(clone);
  }

  findById(id: string): Tender | undefined {
    const tender = this.tenders.get(id);
    return tender ? clone(tender) : undefined;
  }

  findByTenderId(tenderId: string): Tender | undefined {
    const normalized = tenderId.trim().toLowerCase();
    const tender = [...this.tenders.values()].find((item) => item.tenderId.trim().toLowerCase() === normalized);
    return tender ? clone(tender) : undefined;
  }

  create(tender: Omit<Tender, "id" | "createdAt" | "updatedAt"> & { id?: string }): Tender {
    const now = new Date().toISOString();
    const created: Tender = { ...tender, id: tender.id ?? randomUUID(), createdAt: now, updatedAt: now };
    this.tenders.set(created.id, created);
    return clone(created);
  }
  createBulk(tenders: Array<Omit<Tender, "id" | "createdAt" | "updatedAt"> & { id?: string }>): Tender[] {
    return tenders.map((tender) => this.create(tender));
  }

  update(id: string, changes: UpdateTenderInput): Tender | undefined {
    const existing = this.tenders.get(id);
    if (!existing) return undefined;
    const updated: Tender = { ...existing, ...changes, updatedAt: new Date().toISOString() };
    this.tenders.set(id, updated);
    return clone(updated);
  }

  delete(id: string): boolean {
    return this.tenders.delete(id);
  }
}
