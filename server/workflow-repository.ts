import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type {
  CreateIssueBatchInput, CreateIssueBatchWithTendersInput, CreatePurchaseSheetInput, IssueBatch, IssueBatchListQuery, IssueBatchWithTendersResult, PurchaseSheet, PurchaseSheetListQuery,
  PurchaseSheetLine, Tender, UpdateIssueBatchInput, UpdatePurchaseSheetInput,
} from "../shared/domain";

const cloneBatch = (batch: IssueBatch): IssueBatch => ({ ...batch });
const cloneSheet = (sheet: PurchaseSheet): PurchaseSheet => ({ ...sheet, selectedTenderIds: [...sheet.selectedTenderIds], tenders: sheet.tenders.map((tender) => ({ ...tender })), viewMetadata: { ...sheet.viewMetadata, companies: [...sheet.viewMetadata.companies] } });
const asRows = (rows: Record<string, SQLOutputValue>[]): Record<string, any>[] => rows as Record<string, any>[];

type BatchRow = { id: string; issue_date: string; authority_zone: string; authority_id: string | null; authority_name: string | null; company_id: string | null; reference: string | null; notes: string | null; status: IssueBatch["status"]; created_at: string; updated_at: string; tender_count: number; purchase_sheet_count: number };

type TenderRow = { id: string; tender_id: string; company_id: string | null; company_name: string | null; authority: string; authority_zone: string | null; submission_at: string | null; issue_batch_id: string | null; package_name: string; closing_at: string; tender_value: number | null; submitted_value: number | null; stage: Tender["stage"]; status: Tender["status"]; created_at: string; updated_at: string };
const tenderSelect = `SELECT t.id, t.tender_id, t.company_id, c.name AS company_name, t.authority, t.authority_zone, t.issue_batch_id, t.package_name, t.closing_at, t.submission_at, t.tender_value, t.submitted_value, t.stage, t.status, t.created_at, t.updated_at FROM tenders t LEFT JOIN companies c ON c.id = t.company_id`;
const toTender = (row: TenderRow): Tender => ({ id: row.id, tenderId: row.tender_id, company: row.company_name ?? "Unassigned", companyId: row.company_id ?? undefined, authority: row.authority, authorityZone: row.authority_zone ?? undefined, submissionAt: row.submission_at ?? undefined, issueBatchId: row.issue_batch_id ?? undefined, packageName: row.package_name, closingAt: row.closing_at, tenderValue: row.tender_value == null ? undefined : Number(row.tender_value), submittedValue: row.submitted_value == null ? undefined : Number(row.submitted_value), stage: row.stage, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });

export interface IssueBatchRepository {
  list(query?: IssueBatchListQuery): Promise<IssueBatch[]> | IssueBatch[];
  findById(id: string): Promise<IssueBatch | undefined> | IssueBatch | undefined;
  create(input: CreateIssueBatchInput): Promise<IssueBatch> | IssueBatch;
  createWithTenders(input: CreateIssueBatchWithTendersInput): Promise<IssueBatchWithTendersResult> | IssueBatchWithTendersResult;
  update(id: string, changes: UpdateIssueBatchInput): Promise<IssueBatch | undefined> | IssueBatch | undefined;
  delete(id: string): Promise<boolean> | boolean;
  countTenders(batchId: string): Promise<number> | number;
  countPurchaseSheets(batchId: string): Promise<number> | number;
}

export interface PurchaseSheetRepository {
  list(query?: PurchaseSheetListQuery): Promise<PurchaseSheet[]> | PurchaseSheet[];
  findById(id: string): Promise<PurchaseSheet | undefined> | PurchaseSheet | undefined;
  create(input: CreatePurchaseSheetInput): Promise<PurchaseSheet> | PurchaseSheet;
  update(id: string, changes: UpdatePurchaseSheetInput): Promise<PurchaseSheet | undefined> | PurchaseSheet | undefined;
  delete(id: string): Promise<boolean> | boolean;
  countCharges(sheetId: string): Promise<number> | number;
  countPayOrders(sheetId: string): Promise<number> | number;
  findSheetForTender(tenderId: string, excludeSheetId?: string): Promise<{ id: string; sheetNumber?: string } | undefined> | { id: string; sheetNumber?: string } | undefined;
}

export { PgIssueBatchRepository, PgPurchaseSheetRepository } from "./pg-workflow-repository";

export class SqliteIssueBatchRepository implements IssueBatchRepository {
  constructor(private readonly database: DatabaseSync) {}

  private toBatch(row: BatchRow): IssueBatch {
    return { id: row.id, issueDate: row.issue_date, authorityZone: row.authority_zone, authorityId: row.authority_id ?? undefined, authorityName: row.authority_name ?? undefined, reference: row.reference ?? undefined, notes: row.notes ?? undefined, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, tenderCount: Number(row.tender_count ?? 0), purchaseSheetCount: Number(row.purchase_sheet_count ?? 0) };
  }

  list(query: IssueBatchListQuery = {}): IssueBatch[] {
    const clauses: string[] = [];
    const params: SQLOutputValue[] = [];
    if (query.status) { clauses.push("ib.status = ?"); params.push(query.status); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`SELECT ib.*, a.name AS authority_name, (SELECT COUNT(*) FROM tenders t WHERE t.issue_batch_id = ib.id) AS tender_count, (SELECT COUNT(*) FROM purchase_sheets ps WHERE ps.issue_batch_id = ib.id) AS purchase_sheet_count FROM issue_batches ib LEFT JOIN authorities a ON a.id = ib.authority_id${where} ORDER BY ib.issue_date DESC, ib.created_at DESC`).all(...params);
    return asRows(rows).map((row) => cloneBatch(this.toBatch(row as BatchRow)));
  }

  findById(id: string): IssueBatch | undefined {
    const row = this.database.prepare("SELECT ib.*, a.name AS authority_name, (SELECT COUNT(*) FROM tenders t WHERE t.issue_batch_id = ib.id) AS tender_count, (SELECT COUNT(*) FROM purchase_sheets ps WHERE ps.issue_batch_id = ib.id) AS purchase_sheet_count FROM issue_batches ib LEFT JOIN authorities a ON a.id = ib.authority_id WHERE ib.id = ?").get(id);
    return row ? cloneBatch(this.toBatch(row as BatchRow)) : undefined;
  }

  create(input: CreateIssueBatchInput): IssueBatch {
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare("INSERT INTO issue_batches (id, authority_id, issue_date, authority_zone, reference, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.authorityId ?? null, new Date(input.issueDate).toISOString(), input.authorityZone ?? "", input.reference ?? null, input.notes ?? null, input.status, now, now);
    return this.findById(id) as IssueBatch;
  }

  createWithTenders(input: CreateIssueBatchWithTendersInput): IssueBatchWithTendersResult {
    const batchId = randomUUID();
    const now = new Date().toISOString();
    const tenderIds = input.rows.map(() => randomUUID());
    this.database.exec("BEGIN");
    try {
      this.database.prepare("INSERT INTO issue_batches (id, authority_id, issue_date, authority_zone, reference, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(batchId, input.authorityId ?? null, new Date(input.issueDate).toISOString(), input.authorityZone ?? "", input.reference ?? null, input.notes ?? null, input.status, now, now);
      const insertTender = this.database.prepare("INSERT INTO tenders (id, tender_id, company_id, issue_batch_id, authority, authority_zone, package_name, closing_at, submission_at, tender_value, submitted_value, stage, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      input.rows.forEach((row, index) => insertTender.run(tenderIds[index], row.tenderId.trim(), batchId, input.authorityName ?? input.authorityZone ?? "", input.authorityZone ?? "", row.packageName.trim(), new Date(row.closingAt).toISOString(), row.submissionAt ? new Date(row.submissionAt).toISOString() : null, row.tenderValue ?? null, row.submittedValue ?? null, row.stage, row.status, now, now));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const batch = this.findById(batchId) as IssueBatch;
    const tenders = tenderIds.map((id) => this.database.prepare(`${tenderSelect} WHERE t.id = ?`).get(id)).filter(Boolean).map((row) => toTender(row as TenderRow));
    return { batch, tenders };
  }

  update(id: string, changes: UpdateIssueBatchInput): IssueBatch | undefined {
    if (!this.findById(id)) return undefined;
    const values: Array<[string, SQLOutputValue]> = [];
    if (changes.issueDate !== undefined) values.push(["issue_date", new Date(changes.issueDate).toISOString()]);
    if (changes.authorityId !== undefined) values.push(["authority_id", changes.authorityId]);
    if (changes.authorityZone !== undefined) values.push(["authority_zone", changes.authorityZone || ""]);
    if (changes.reference !== undefined) values.push(["reference", changes.reference || null]);
    if (changes.notes !== undefined) values.push(["notes", changes.notes || null]);
    if (changes.status !== undefined) values.push(["status", changes.status]);
    values.push(["updated_at", new Date().toISOString()]);
    this.database.prepare(`UPDATE issue_batches SET ${values.map(([field]) => `${field} = ?`).join(", ")} WHERE id = ?`).run(...values.map(([, value]) => value), id);
    return this.findById(id);
  }

  countTenders(batchId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM tenders WHERE issue_batch_id = ?").get(batchId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countPurchaseSheets(batchId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM purchase_sheets WHERE issue_batch_id = ?").get(batchId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  delete(id: string): boolean {
    const tenderCount = this.countTenders(id);
    if (tenderCount > 0) {
      throw new Error(`Cannot delete issue batch: it contains ${tenderCount} tender(s). Remove or reassign the tenders first.`);
    }
    const sheetCount = this.countPurchaseSheets(id);
    if (sheetCount > 0) {
      throw new Error(`Cannot delete issue batch: it has ${sheetCount} associated purchase sheet(s). Delete the purchase sheets first.`);
    }
    try {
      return (this.database.prepare("DELETE FROM issue_batches WHERE id = ?").run(id) as { changes: number }).changes > 0;
    } catch (error) {
      if (error instanceof Error && /FOREIGN KEY/i.test(error.message)) {
        throw new Error("Cannot delete issue batch: dependent records exist.");
      }
      throw error;
    }
  }
}

export class SqlitePurchaseSheetRepository implements PurchaseSheetRepository {
  constructor(private readonly database: DatabaseSync) {}

  private lineRows(sheetId: string): Array<Tender & { lineCompanyId?: string }> {
    const rows = this.database.prepare(`SELECT t.id, t.tender_id, psl.company_id AS line_company_id, lc.name AS line_company_name, t.company_id, c.name AS company_name, t.authority, t.authority_zone, t.issue_batch_id, t.package_name, t.closing_at, t.submission_at, t.tender_value, t.submitted_value, t.stage, t.status, t.created_at, t.updated_at FROM tenders t LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN purchase_sheet_lines psl ON psl.tender_id = t.id LEFT JOIN companies lc ON lc.id = psl.company_id WHERE psl.purchase_sheet_id = ? ORDER BY psl.line_order ASC`).all(sheetId);
    return asRows(rows).map((row) => ({ ...toTender(row as TenderRow), companyId: (row as any).line_company_id ?? (row as any).company_id ?? undefined, company: (row as any).line_company_name ?? "Unassigned", lineCompanyId: (row as any).line_company_id ?? undefined }));
  }
  private lines(sheetId: string): Tender[] { return this.lineRows(sheetId); }
  private toSheet(row: Record<string, any>): PurchaseSheet {
    const tenders = this.lines(row.id);
    const companies = [...new Set(tenders.map((tender) => tender.company || "Unassigned"))];
    const lineAssignments: PurchaseSheetLine[] = tenders.map((tender) => ({ tenderId: tender.id, companyId: tender.companyId, company: tender.company || "Unassigned" }));
    return { id: row.id, issueBatchId: row.issue_batch_id, sheetNumber: row.sheet_number ?? undefined, purchasedAt: row.purchased_at ?? undefined, purchaseAmount: row.purchase_amount == null ? undefined : Number(row.purchase_amount), paymentMethod: row.payment_method ?? undefined, status: row.status, viewMode: row.view_mode, bankEmailTo: row.bank_email_to ?? undefined, bankEmailCc: row.bank_email_cc ?? undefined, bankEmailSubject: row.bank_email_subject ?? undefined, notes: row.notes ?? undefined, selectedTenderIds: tenders.map((tender) => tender.id), lineAssignments, tenders, viewMetadata: { mode: row.view_mode, lineCount: tenders.length, companyCount: companies.length, companies }, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  list(query: PurchaseSheetListQuery = {}): PurchaseSheet[] {
    const clauses: string[] = []; const params: SQLOutputValue[] = [];
    if (query.issueBatchId) { clauses.push("ps.issue_batch_id = ?"); params.push(query.issueBatchId); }
    if (query.status) { clauses.push("ps.status = ?"); params.push(query.status); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`SELECT ps.* FROM purchase_sheets ps${where} ORDER BY ps.created_at DESC, ps.id ASC`).all(...params);
    return asRows(rows).map((row) => cloneSheet(this.toSheet(row)));
  }

  findById(id: string): PurchaseSheet | undefined {
    const row = this.database.prepare("SELECT ps.* FROM purchase_sheets ps WHERE ps.id = ?").get(id);
    return row ? cloneSheet(this.toSheet(row as Record<string, any>)) : undefined;
  }

  findSheetForTender(tenderId: string, excludeSheetId?: string): { id: string; sheetNumber?: string } | undefined {
    const query = excludeSheetId
      ? "SELECT ps.id, ps.sheet_number FROM purchase_sheet_lines psl JOIN purchase_sheets ps ON ps.id = psl.purchase_sheet_id WHERE psl.tender_id = ? AND psl.purchase_sheet_id != ? LIMIT 1"
      : "SELECT ps.id, ps.sheet_number FROM purchase_sheet_lines psl JOIN purchase_sheets ps ON ps.id = psl.purchase_sheet_id WHERE psl.tender_id = ? LIMIT 1";
    const params = excludeSheetId ? [tenderId, excludeSheetId] : [tenderId];
    const row = this.database.prepare(query).get(...params) as { id: string; sheet_number: string | null } | undefined;
    return row ? { id: row.id, sheetNumber: row.sheet_number ?? undefined } : undefined;
  }

  private writeLines(sheetId: string, tenderIds: string[], assignments?: Array<{ tenderId: string; companyId?: string }>): void {
    for (const tenderId of tenderIds) {
      const existing = this.findSheetForTender(tenderId, sheetId);
      if (existing) {
        const sheetLabel = existing.sheetNumber ? `Purchase Sheet #${existing.sheetNumber}` : existing.id;
        throw new Error(`Cannot assign tender: already assigned to ${sheetLabel}.`);
      }
    }
    const insert = this.database.prepare("INSERT INTO purchase_sheet_lines (id, purchase_sheet_id, tender_id, company_id, line_order) VALUES (?, ?, ?, ?, ?)");
    const byTender = new Map((assignments ?? []).map((item) => [item.tenderId, item.companyId ?? null]));
    tenderIds.forEach((tenderId, index) => insert.run(randomUUID(), sheetId, tenderId, byTender.get(tenderId) ?? null, index));
  }

  create(input: CreatePurchaseSheetInput): PurchaseSheet {
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.exec("BEGIN");
    try {
      this.database.prepare("INSERT INTO purchase_sheets (id, issue_batch_id, sheet_number, purchased_at, purchase_amount, payment_method, status, view_mode, bank_email_to, bank_email_cc, bank_email_subject, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.issueBatchId, input.sheetNumber || null, input.purchasedAt ? new Date(input.purchasedAt).toISOString() : null, input.purchaseAmount ?? null, input.paymentMethod || null, input.status, input.viewMode, input.bankEmailTo || null, input.bankEmailCc || null, input.bankEmailSubject || null, input.notes || null, now, now);
      this.writeLines(id, input.selectedTenderIds, input.lineAssignments); this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.findById(id) as PurchaseSheet;
  }

  update(id: string, changes: UpdatePurchaseSheetInput): PurchaseSheet | undefined {
    if (!this.findById(id)) return undefined;
    const values: Array<[string, SQLOutputValue]> = [];
    if (changes.issueBatchId !== undefined) values.push(["issue_batch_id", changes.issueBatchId]);
    if (changes.sheetNumber !== undefined) values.push(["sheet_number", changes.sheetNumber || null]);
    if (changes.purchasedAt !== undefined) values.push(["purchased_at", changes.purchasedAt ? new Date(changes.purchasedAt).toISOString() : null]);
    if (changes.purchaseAmount !== undefined) values.push(["purchase_amount", changes.purchaseAmount]);
    if (changes.paymentMethod !== undefined) values.push(["payment_method", changes.paymentMethod || null]);
    if (changes.status !== undefined) values.push(["status", changes.status]);
    if (changes.viewMode !== undefined) values.push(["view_mode", changes.viewMode]);
    if (changes.bankEmailTo !== undefined) values.push(["bank_email_to", changes.bankEmailTo || null]);
    if (changes.bankEmailCc !== undefined) values.push(["bank_email_cc", changes.bankEmailCc || null]);
    if (changes.bankEmailSubject !== undefined) values.push(["bank_email_subject", changes.bankEmailSubject || null]);
    if (changes.notes !== undefined) values.push(["notes", changes.notes || null]);
    this.database.exec("BEGIN");
    try {
      values.push(["updated_at", new Date().toISOString()]);
      this.database.prepare(`UPDATE purchase_sheets SET ${values.map(([field]) => `${field} = ?`).join(", ")} WHERE id = ?`).run(...values.map(([, value]) => value), id);
      if (changes.selectedTenderIds !== undefined) { this.database.prepare("DELETE FROM purchase_sheet_lines WHERE purchase_sheet_id = ?").run(id); this.writeLines(id, changes.selectedTenderIds, changes.lineAssignments); }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.findById(id);
  }

  countCharges(sheetId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM charges WHERE purchase_sheet_id = ?").get(sheetId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countPayOrders(sheetId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM pay_orders WHERE purchase_sheet_id = ?").get(sheetId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  delete(id: string): boolean {
    const chargeCount = this.countCharges(id);
    if (chargeCount > 0) {
      throw new Error(`Cannot delete purchase sheet: it is linked to ${chargeCount} financial charge record(s).`);
    }
    const payOrderCount = this.countPayOrders(id);
    if (payOrderCount > 0) {
      throw new Error(`Cannot delete purchase sheet: it is linked to ${payOrderCount} pay order(s).`);
    }
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM purchase_sheet_lines WHERE purchase_sheet_id = ?").run(id);
      const result = this.database.prepare("DELETE FROM purchase_sheets WHERE id = ?").run(id) as { changes: number };
      this.database.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (error instanceof Error && /FOREIGN KEY/i.test(error.message)) {
        throw new Error("Cannot delete purchase sheet: dependent records exist.");
      }
      throw error;
    }
  }
}
