import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  CreateIssueBatchInput,
  CreateIssueBatchWithTendersInput,
  CreatePurchaseSheetInput,
  IssueBatch,
  IssueBatchListQuery,
  IssueBatchWithTendersResult,
  PurchaseSheet,
  PurchaseSheetListQuery,
  PurchaseSheetLine,
  Tender,
  UpdateIssueBatchInput,
  UpdatePurchaseSheetInput,
} from "../shared/domain";
import type { IssueBatchRepository, PurchaseSheetRepository } from "./workflow-repository";

const toIso = (val: unknown): string | undefined => {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

const toTender = (row: any): Tender => ({
  id: row.id,
  tenderId: row.tender_id,
  company: row.company_name ?? "Unassigned",
  companyId: row.company_id ?? undefined,
  authority: row.authority,
  authorityZone: row.authority_zone ?? undefined,
  submissionAt: toIso(row.submission_at),
  issueBatchId: row.issue_batch_id ?? undefined,
  packageName: row.package_name,
  closingAt: toIso(row.closing_at)!,
  tenderValue: row.tender_value == null ? undefined : Number(row.tender_value),
  submittedValue: row.submitted_value == null ? undefined : Number(row.submitted_value),
  stage: row.stage,
  status: row.status,
  createdAt: toIso(row.created_at)!,
  updatedAt: toIso(row.updated_at)!,
});

const tenderSelect = `
  SELECT t.id, t.tender_id, t.company_id, c.name AS company_name,
         t.authority, t.authority_zone, t.issue_batch_id, t.package_name,
         t.closing_at, t.submission_at, t.tender_value, t.submitted_value,
         t.stage, t.status, t.created_at, t.updated_at
  FROM tenders t
  LEFT JOIN companies c ON c.id = t.company_id
`;

export class PgIssueBatchRepository implements IssueBatchRepository {
  constructor(private readonly pool: pg.Pool) {}

  private toBatch(row: any): IssueBatch {
    return {
      id: row.id,
      issueDate: toIso(row.issue_date)!,
      authorityZone: row.authority_zone,
      authorityId: row.authority_id ?? undefined,
      authorityName: row.authority_name ?? undefined,
      reference: row.reference ?? undefined,
      notes: row.notes ?? undefined,
      status: row.status,
      createdAt: toIso(row.created_at)!,
      updatedAt: toIso(row.updated_at)!,
      tenderCount: Number(row.tender_count ?? 0),
      purchaseSheetCount: Number(row.purchase_sheet_count ?? 0),
    };
  }

  async list(query: IssueBatchListQuery = {}): Promise<IssueBatch[]> {
    const clauses: string[] = [];
    const params: any[] = [];
    if (query.status) {
      params.push(query.status);
      clauses.push(`ib.status = $${params.length}`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sql = `
      SELECT ib.*, a.name AS authority_name,
        (SELECT COUNT(*) FROM tenders t WHERE t.issue_batch_id = ib.id) AS tender_count,
        (SELECT COUNT(*) FROM purchase_sheets ps WHERE ps.issue_batch_id = ib.id) AS purchase_sheet_count
      FROM issue_batches ib
      LEFT JOIN authorities a ON a.id = ib.authority_id
      ${where}
      ORDER BY ib.issue_date DESC, ib.created_at DESC
    `;
    const res = await this.pool.query(sql, params);
    return res.rows.map((row) => this.toBatch(row));
  }

  async findById(id: string): Promise<IssueBatch | undefined> {
    const sql = `
      SELECT ib.*, a.name AS authority_name,
        (SELECT COUNT(*) FROM tenders t WHERE t.issue_batch_id = ib.id) AS tender_count,
        (SELECT COUNT(*) FROM purchase_sheets ps WHERE ps.issue_batch_id = ib.id) AS purchase_sheet_count
      FROM issue_batches ib
      LEFT JOIN authorities a ON a.id = ib.authority_id
      WHERE ib.id = $1
    `;
    const res = await this.pool.query(sql, [id]);
    return res.rows[0] ? this.toBatch(res.rows[0]) : undefined;
  }

  async create(input: CreateIssueBatchInput): Promise<IssueBatch> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO issue_batches (id, authority_id, issue_date, authority_zone, reference, notes, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.authorityId ?? null,
        new Date(input.issueDate).toISOString(),
        input.authorityZone ?? "",
        input.reference ?? null,
        input.notes ?? null,
        input.status,
        now,
        now,
      ]
    );
    return (await this.findById(id))!;
  }

  async createWithTenders(input: CreateIssueBatchWithTendersInput): Promise<IssueBatchWithTendersResult> {
    const batchId = randomUUID();
    const now = new Date().toISOString();
    const tenderIds = input.rows.map(() => randomUUID());

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO issue_batches (id, authority_id, issue_date, authority_zone, reference, notes, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          batchId,
          input.authorityId ?? null,
          new Date(input.issueDate).toISOString(),
          input.authorityZone ?? "",
          input.reference ?? null,
          input.notes ?? null,
          input.status,
          now,
          now,
        ]
      );

      for (let i = 0; i < input.rows.length; i++) {
        const row = input.rows[i];
        const tid = tenderIds[i];
        await client.query(
          `INSERT INTO tenders (id, tender_id, company_id, issue_batch_id, authority, authority_zone, package_name, closing_at, submission_at, tender_value, submitted_value, stage, status, created_at, updated_at)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            tid,
            row.tenderId.trim(),
            batchId,
            input.authorityName ?? input.authorityZone ?? "",
            input.authorityZone ?? "",
            row.packageName.trim(),
            new Date(row.closingAt).toISOString(),
            row.submissionAt ? new Date(row.submissionAt).toISOString() : null,
            row.tenderValue ?? null,
            row.submittedValue ?? null,
            row.stage,
            row.status,
            now,
            now,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const batch = (await this.findById(batchId))!;
    const tenders: Tender[] = [];
    for (const tid of tenderIds) {
      const res = await this.pool.query(`${tenderSelect} WHERE t.id = $1`, [tid]);
      if (res.rows[0]) tenders.push(toTender(res.rows[0]));
    }
    return { batch, tenders };
  }

  async update(id: string, changes: UpdateIssueBatchInput): Promise<IssueBatch | undefined> {
    if (!(await this.findById(id))) return undefined;
    const values: Array<[string, any]> = [];
    if (changes.issueDate !== undefined) values.push(["issue_date", new Date(changes.issueDate).toISOString()]);
    if (changes.authorityId !== undefined) values.push(["authority_id", changes.authorityId]);
    if (changes.authorityZone !== undefined) values.push(["authority_zone", changes.authorityZone || ""]);
    if (changes.reference !== undefined) values.push(["reference", changes.reference || null]);
    if (changes.notes !== undefined) values.push(["notes", changes.notes || null]);
    if (changes.status !== undefined) values.push(["status", changes.status]);
    values.push(["updated_at", new Date().toISOString()]);

    const assignments = values.map(([field], idx) => `"${field}" = $${idx + 1}`).join(", ");
    await this.pool.query(
      `UPDATE issue_batches SET ${assignments} WHERE id = $${values.length + 1}`,
      [...values.map(([, val]) => val), id]
    );
    return await this.findById(id);
  }

  async countTenders(batchId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM tenders WHERE issue_batch_id = $1", [batchId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countPurchaseSheets(batchId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM purchase_sheets WHERE issue_batch_id = $1", [batchId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async delete(id: string): Promise<boolean> {
    const tenderCount = await this.countTenders(id);
    if (tenderCount > 0) {
      throw new Error(`Cannot delete issue batch: it contains ${tenderCount} tender(s). Remove or reassign the tenders first.`);
    }
    const sheetCount = await this.countPurchaseSheets(id);
    if (sheetCount > 0) {
      throw new Error(`Cannot delete issue batch: it has ${sheetCount} associated purchase sheet(s). Delete the purchase sheets first.`);
    }
    try {
      const res = await this.pool.query("DELETE FROM issue_batches WHERE id = $1", [id]);
      return Number(res.rowCount ?? 0) > 0;
    } catch (error: any) {
      if (error && (error.code === "23503" || /FOREIGN KEY/i.test(error.message))) {
        throw new Error("Cannot delete issue batch: dependent records exist.");
      }
      throw error;
    }
  }
}

export class PgPurchaseSheetRepository implements PurchaseSheetRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async lineRows(sheetId: string): Promise<Array<Tender & { lineCompanyId?: string }>> {
    const sql = `
      SELECT t.id, t.tender_id, psl.company_id AS line_company_id, lc.name AS line_company_name,
             t.company_id, c.name AS company_name, t.authority, t.authority_zone, t.issue_batch_id,
             t.package_name, t.closing_at, t.submission_at, t.tender_value, t.submitted_value,
             t.stage, t.status, t.created_at, t.updated_at
      FROM tenders t
      LEFT JOIN companies c ON c.id = t.company_id
      LEFT JOIN purchase_sheet_lines psl ON psl.tender_id = t.id
      LEFT JOIN companies lc ON lc.id = psl.company_id
      WHERE psl.purchase_sheet_id = $1
      ORDER BY psl.line_order ASC
    `;
    const res = await this.pool.query(sql, [sheetId]);
    return res.rows.map((row) => ({
      ...toTender(row),
      companyId: row.line_company_id ?? row.company_id ?? undefined,
      company: row.line_company_name ?? row.company_name ?? "Unassigned",
      lineCompanyId: row.line_company_id ?? undefined,
    }));
  }

  private async toSheet(row: any): Promise<PurchaseSheet> {
    const tenders = await this.lineRows(row.id);
    const companies = [...new Set(tenders.map((tender) => tender.company || "Unassigned"))];
    const lineAssignments: PurchaseSheetLine[] = tenders.map((tender) => ({
      tenderId: tender.id,
      companyId: tender.companyId,
      company: tender.company || "Unassigned",
    }));

    return {
      id: row.id,
      issueBatchId: row.issue_batch_id,
      sheetNumber: row.sheet_number ?? undefined,
      purchasedAt: toIso(row.purchased_at),
      purchaseAmount: row.purchase_amount == null ? undefined : Number(row.purchase_amount),
      paymentMethod: row.payment_method ?? undefined,
      status: row.status,
      viewMode: row.view_mode,
      bankEmailTo: row.bank_email_to ?? undefined,
      bankEmailCc: row.bank_email_cc ?? undefined,
      bankEmailSubject: row.bank_email_subject ?? undefined,
      notes: row.notes ?? undefined,
      selectedTenderIds: tenders.map((tender) => tender.id),
      lineAssignments,
      tenders,
      viewMetadata: {
        mode: row.view_mode,
        lineCount: tenders.length,
        companyCount: companies.length,
        companies,
      },
      createdAt: toIso(row.created_at)!,
      updatedAt: toIso(row.updated_at)!,
    };
  }

  async list(query: PurchaseSheetListQuery = {}): Promise<PurchaseSheet[]> {
    const clauses: string[] = [];
    const params: any[] = [];
    if (query.issueBatchId) {
      params.push(query.issueBatchId);
      clauses.push(`ps.issue_batch_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      clauses.push(`ps.status = $${params.length}`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT ps.* FROM purchase_sheets ps${where} ORDER BY ps.created_at DESC, ps.id ASC`;
    const res = await this.pool.query(sql, params);
    const sheets = await Promise.all(res.rows.map((row) => this.toSheet(row)));
    return sheets;
  }

  async findById(id: string): Promise<PurchaseSheet | undefined> {
    const res = await this.pool.query("SELECT ps.* FROM purchase_sheets ps WHERE ps.id = $1", [id]);
    return res.rows[0] ? await this.toSheet(res.rows[0]) : undefined;
  }

  async findSheetForTender(tenderId: string, excludeSheetId?: string): Promise<{ id: string; sheetNumber?: string } | undefined> {
    const query = excludeSheetId
      ? "SELECT ps.id, ps.sheet_number FROM purchase_sheet_lines psl JOIN purchase_sheets ps ON ps.id = psl.purchase_sheet_id WHERE psl.tender_id = $1 AND psl.purchase_sheet_id != $2 LIMIT 1"
      : "SELECT ps.id, ps.sheet_number FROM purchase_sheet_lines psl JOIN purchase_sheets ps ON ps.id = psl.purchase_sheet_id WHERE psl.tender_id = $1 LIMIT 1";
    const params = excludeSheetId ? [tenderId, excludeSheetId] : [tenderId];
    const res = await this.pool.query(query, params);
    return res.rows[0] ? { id: res.rows[0].id, sheetNumber: res.rows[0].sheet_number ?? undefined } : undefined;
  }

  private async writeLines(
    client: { query: (q: string, p?: any[]) => Promise<any> },
    sheetId: string,
    tenderIds: string[],
    assignments?: Array<{ tenderId: string; companyId?: string }>
  ): Promise<void> {
    for (const tenderId of tenderIds) {
      const existing = await this.findSheetForTender(tenderId, sheetId);
      if (existing) {
        const sheetLabel = existing.sheetNumber ? `Purchase Sheet #${existing.sheetNumber}` : existing.id;
        throw new Error(`Cannot assign tender: already assigned to ${sheetLabel}.`);
      }
    }
    const byTender = new Map((assignments ?? []).map((item) => [item.tenderId, item.companyId ?? null]));
    for (let index = 0; index < tenderIds.length; index++) {
      const tenderId = tenderIds[index];
      await client.query(
        `INSERT INTO purchase_sheet_lines (id, purchase_sheet_id, tender_id, company_id, line_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), sheetId, tenderId, byTender.get(tenderId) ?? null, index]
      );
    }
  }

  async create(input: CreatePurchaseSheetInput): Promise<PurchaseSheet> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO purchase_sheets
          (id, issue_batch_id, sheet_number, purchased_at, purchase_amount, payment_method, status, view_mode,
           bank_email_to, bank_email_cc, bank_email_subject, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          input.issueBatchId,
          input.sheetNumber || null,
          input.purchasedAt ? new Date(input.purchasedAt).toISOString() : null,
          input.purchaseAmount ?? null,
          input.paymentMethod || null,
          input.status,
          input.viewMode,
          input.bankEmailTo || null,
          input.bankEmailCc || null,
          input.bankEmailSubject || null,
          input.notes || null,
          now,
          now,
        ]
      );
      await this.writeLines(client, id, input.selectedTenderIds, input.lineAssignments);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return (await this.findById(id))!;
  }

  async update(id: string, changes: UpdatePurchaseSheetInput): Promise<PurchaseSheet | undefined> {
    if (!(await this.findById(id))) return undefined;

    const values: Array<[string, any]> = [];
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

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      values.push(["updated_at", new Date().toISOString()]);
      const assignments = values.map(([field], idx) => `"${field}" = $${idx + 1}`).join(", ");
      await client.query(
        `UPDATE purchase_sheets SET ${assignments} WHERE id = $${values.length + 1}`,
        [...values.map(([, val]) => val), id]
      );

      if (changes.selectedTenderIds !== undefined) {
        await client.query("DELETE FROM purchase_sheet_lines WHERE purchase_sheet_id = $1", [id]);
        await this.writeLines(client, id, changes.selectedTenderIds, changes.lineAssignments);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return await this.findById(id);
  }

  async countCharges(sheetId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM charges WHERE purchase_sheet_id = $1", [sheetId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countPayOrders(sheetId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM pay_orders WHERE purchase_sheet_id = $1", [sheetId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async delete(id: string): Promise<boolean> {
    const chargeCount = await this.countCharges(id);
    if (chargeCount > 0) {
      throw new Error(`Cannot delete purchase sheet: it is linked to ${chargeCount} financial charge record(s).`);
    }
    const payOrderCount = await this.countPayOrders(id);
    if (payOrderCount > 0) {
      throw new Error(`Cannot delete purchase sheet: it is linked to ${payOrderCount} pay order(s).`);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM purchase_sheet_lines WHERE purchase_sheet_id = $1", [id]);
      const res = await client.query("DELETE FROM purchase_sheets WHERE id = $1", [id]);
      await client.query("COMMIT");
      return Number(res.rowCount ?? 0) > 0;
    } catch (error: any) {
      await client.query("ROLLBACK");
      if (error && (error.code === "23503" || /FOREIGN KEY/i.test(error.message))) {
        throw new Error("Cannot delete purchase sheet: dependent records exist.");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
