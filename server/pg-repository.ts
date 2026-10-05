import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Tender, TenderListQuery, UpdateTenderInput } from "../shared/domain";
import type { TenderRepository } from "./repository";

type TenderRow = {
  id: string;
  tender_id: string;
  company_id: string | null;
  company_name: string | null;
  authority: string;
  authority_zone: string | null;
  issue_batch_id: string | null;
  package_name: string;
  closing_at: string | Date;
  submission_at: string | Date | null;
  tender_value: number | string | null;
  submitted_value: number | string | null;
  stage: Tender["stage"];
  status: Tender["status"];
  created_at: string | Date;
  updated_at: string | Date;
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

const toIso = (val: unknown): string | undefined => {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

const toTender = (row: TenderRow): Tender => ({
  id: row.id,
  tenderId: row.tender_id,
  company: row.company_name ?? "Unassigned",
  companyId: row.company_id ?? undefined,
  authority: row.authority,
  authorityZone: row.authority_zone ?? undefined,
  issueBatchId: row.issue_batch_id ?? undefined,
  packageName: row.package_name,
  closingAt: toIso(row.closing_at)!,
  submissionAt: toIso(row.submission_at),
  tenderValue: row.tender_value == null ? undefined : Number(row.tender_value),
  submittedValue: row.submitted_value == null ? undefined : Number(row.submitted_value),
  stage: row.stage,
  status: row.status,
  createdAt: toIso(row.created_at)!,
  updatedAt: toIso(row.updated_at)!,
});

const contains = (value: string): string => `%${value.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

const dateBoundary = (value: string | undefined, end: boolean): string | undefined => {
  if (!value) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : value;
};

const resultOutcome = (value: TenderListQuery["result"]): "Won" | "Lost" | "Pending" | undefined => (value === "Win" ? "Won" : value);

export class PgTenderRepository implements TenderRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(query: TenderListQuery = {}): Promise<Tender[]> {
    const clauses: string[] = [];
    const params: any[] = [];

    if (query.companyId) {
      params.push(query.companyId);
      clauses.push(`t.company_id = $${params.length}`);
    }
    if (query.tenderId) {
      params.push(contains(query.tenderId));
      clauses.push(`LOWER(t.tender_id) LIKE $${params.length} ESCAPE '\\'`);
    }
    if (query.company) {
      params.push(contains(query.company));
      clauses.push(`LOWER(c.name) LIKE $${params.length} ESCAPE '\\'`);
    }
    if (query.authority) {
      params.push(contains(query.authority));
      clauses.push(`LOWER(t.authority) LIKE $${params.length} ESCAPE '\\'`);
    }
    if (query.authorityZone) {
      params.push(contains(query.authorityZone));
      clauses.push(`LOWER(t.authority || ' ' || COALESCE(t.authority_zone, '')) LIKE $${params.length} ESCAPE '\\'`);
    }
    if (query.packageName) {
      params.push(contains(query.packageName));
      clauses.push(`LOWER(t.package_name) LIKE $${params.length} ESCAPE '\\'`);
    }
    if (query.status) {
      params.push(query.status);
      clauses.push(`t.status = $${params.length}`);
    }
    if (query.stage) {
      params.push(query.stage);
      clauses.push(`t.stage = $${params.length}`);
    }
    if (query.q) {
      params.push(contains(query.q));
      clauses.push(`LOWER(t.tender_id || ' ' || COALESCE(c.name, '') || ' ' || t.authority || ' ' || t.package_name) LIKE $${params.length}`);
    }

    const closingFrom = dateBoundary(query.closingFrom ?? query.closingDateFrom, false);
    const closingTo = dateBoundary(query.closingTo ?? query.closingDateTo, true);
    const submissionFrom = dateBoundary(query.submissionFrom ?? query.submissionDateFrom, false);
    const submissionTo = dateBoundary(query.submissionTo ?? query.submissionDateTo, true);

    if (closingFrom) {
      params.push(closingFrom);
      clauses.push(`t.closing_at >= $${params.length}`);
    }
    if (closingTo) {
      params.push(closingTo);
      clauses.push(`t.closing_at <= $${params.length}`);
    }
    if (submissionFrom) {
      params.push(submissionFrom);
      clauses.push(`t.submission_at IS NOT NULL AND t.submission_at >= $${params.length}`);
    }
    if (submissionTo) {
      params.push(submissionTo);
      clauses.push(`t.submission_at IS NOT NULL AND t.submission_at <= $${params.length}`);
    }

    const valueMin = query.valueMin ?? query.tenderValueMin;
    const valueMax = query.valueMax ?? query.tenderValueMax;
    if (valueMin !== undefined) {
      params.push(valueMin);
      clauses.push(`t.tender_value >= $${params.length}`);
    }
    if (valueMax !== undefined) {
      params.push(valueMax);
      clauses.push(`t.tender_value <= $${params.length}`);
    }

    const outcome = resultOutcome(query.result);
    if (outcome === "Pending") {
      clauses.push(`(NOT EXISTS (SELECT 1 FROM results r WHERE r.tender_id = t.id) OR EXISTS (SELECT 1 FROM results r WHERE r.tender_id = t.id AND r.outcome = 'Pending'))`);
    } else if (outcome) {
      params.push(outcome);
      clauses.push(`EXISTS (SELECT 1 FROM results r WHERE r.tender_id = t.id AND r.outcome = $${params.length})`);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.pool.query<TenderRow>(`${TENDER_SELECT}${where} ORDER BY t.created_at ASC, t.id ASC`, params);
    return res.rows.map(toTender);
  }

  async findById(id: string): Promise<Tender | undefined> {
    const res = await this.pool.query<TenderRow>(`${TENDER_SELECT} WHERE t.id = $1`, [id]);
    return res.rows[0] ? toTender(res.rows[0]) : undefined;
  }

  async findByTenderId(tenderId: string): Promise<Tender | undefined> {
    const res = await this.pool.query<TenderRow>(
      `${TENDER_SELECT} WHERE LOWER(t.tender_id) = LOWER($1) ORDER BY t.created_at ASC LIMIT 1`,
      [tenderId]
    );
    return res.rows[0] ? toTender(res.rows[0]) : undefined;
  }

  private async resolveCompanyId(
    client: { query: (q: string, p?: any[]) => Promise<any> },
    companyName: string | undefined,
    explicitCompanyId: string | undefined
  ): Promise<{ companyId: string | null; companyName: string }> {
    const trimmed = companyName?.trim();
    if (explicitCompanyId) {
      return { companyId: explicitCompanyId, companyName: trimmed || "Unassigned" };
    }
    if (!trimmed) {
      return { companyId: null, companyName: "Unassigned" };
    }
    const existing = await client.query(
      "SELECT id, name FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1",
      [trimmed]
    );
    if (existing.rows && existing.rows.length > 0) {
      return { companyId: existing.rows[0].id, companyName: existing.rows[0].name };
    }
    return { companyId: randomUUID(), companyName: trimmed };
  }

  async create(tender: Omit<Tender, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Tender> {
    const now = new Date().toISOString();
    const id = tender.id ?? randomUUID();
    if (tender.id) {
      const existing = await this.findById(tender.id);
      if (existing) return existing;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { companyId, companyName } = await this.resolveCompanyId(client, tender.company, tender.companyId);

      if (companyId) {
        await client.query(
          `INSERT INTO companies (id, name, created_at, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
          [companyId, companyName, now, now]
        );
      }

      await client.query(
        `INSERT INTO tenders
          (id, tender_id, company_id, issue_batch_id, authority, authority_zone,
           package_name, closing_at, submission_at, tender_value, submitted_value, stage, status,
           created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
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
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return (await this.findById(id))!;
  }

  async createBulk(tenders: Array<Omit<Tender, "id" | "createdAt" | "updatedAt"> & { id?: string }>): Promise<Tender[]> {
    const now = new Date().toISOString();
    const ids = tenders.map((tender) => tender.id ?? randomUUID());

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const batchCompanyCache = new Map<string, { id: string; name: string }>();

      for (let i = 0; i < tenders.length; i++) {
        const tender = tenders[i];
        const id = ids[i];
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
            const existing = await client.query(
              "SELECT id, name FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1",
              [trimmed]
            );
            if (existing.rows.length > 0) {
              companyId = existing.rows[0].id;
              companyName = existing.rows[0].name;
            } else {
              companyId = randomUUID();
            }
            batchCompanyCache.set(lower, { id: companyId as string, name: companyName });
          }
        }

        if (companyId) {
          await client.query(
            `INSERT INTO companies (id, name, created_at, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
            [companyId, companyName, now, now]
          );
        }

        await client.query(
          `INSERT INTO tenders
            (id, tender_id, company_id, issue_batch_id, authority, authority_zone,
             package_name, closing_at, submission_at, tender_value, submitted_value, stage, status,
             created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
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

    const fetched = await Promise.all(ids.map((id) => this.findById(id)));
    return fetched.filter((tender): tender is Tender => Boolean(tender));
  }

  async update(id: string, changes: UpdateTenderInput): Promise<Tender | undefined> {
    const existing = await this.findById(id);
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
      const resolved = await this.resolveCompanyId(this.pool, changes.company, undefined);
      nextCompanyId = resolved.companyId;
      companyNameToUpsert = resolved.companyName;
    }

    const fields: Array<[string, any]> = [];
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

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (nextCompanyId && companyNameToUpsert) {
        await client.query(
          `INSERT INTO companies (id, name, created_at, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
          [nextCompanyId, companyNameToUpsert, now, now]
        );
      }
      if (fields.length > 0) {
        fields.push(["updated_at", now]);
        const assignments = fields.map(([field], idx) => `"${field}" = $${idx + 1}`).join(", ");
        await client.query(
          `UPDATE tenders SET ${assignments} WHERE id = $${fields.length + 1}`,
          [...fields.map(([, val]) => val), id]
        );
      } else {
        await client.query("UPDATE tenders SET updated_at = $1 WHERE id = $2", [now, id]);
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

  async countPurchaseSheetLines(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM purchase_sheet_lines WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countCharges(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM charges WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countPayOrders(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM pay_orders WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countCertificates(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM credit_commitment_certificates WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countResults(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM results WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countNoa(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM noa WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countPerformanceSecurities(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM performance_securities WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countContractAgreements(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM contract_agreements WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async countDocuments(tenderId: string): Promise<number> {
    const res = await this.pool.query("SELECT COUNT(*) AS count FROM documents WHERE tender_id = $1", [tenderId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async delete(id: string): Promise<boolean> {
    const sheetLineCount = await this.countPurchaseSheetLines(id);
    if (sheetLineCount > 0) {
      throw new Error(`Cannot delete tender: it is assigned to ${sheetLineCount} purchase sheet(s). Remove it from the purchase sheet first.`);
    }
    const payOrderCount = await this.countPayOrders(id);
    if (payOrderCount > 0) {
      throw new Error(`Cannot delete tender: it is linked to ${payOrderCount} pay order(s).`);
    }
    const chargeCount = await this.countCharges(id);
    if (chargeCount > 0) {
      throw new Error(`Cannot delete tender: it is linked to ${chargeCount} financial charge record(s).`);
    }
    const certificateCount = await this.countCertificates(id);
    if (certificateCount > 0) {
      throw new Error(`Cannot delete tender: it is linked to ${certificateCount} credit commitment certificate(s).`);
    }
    const resultCount = await this.countResults(id);
    if (resultCount > 0) {
      throw new Error("Cannot delete tender: it has a recorded evaluation result.");
    }
    const noaCount = await this.countNoa(id);
    if (noaCount > 0) {
      throw new Error("Cannot delete tender: it has an associated Notification of Award (NOA).");
    }
    const securityCount = await this.countPerformanceSecurities(id);
    if (securityCount > 0) {
      throw new Error(`Cannot delete tender: it is linked to ${securityCount} performance security record(s).`);
    }
    const contractCount = await this.countContractAgreements(id);
    if (contractCount > 0) {
      throw new Error("Cannot delete tender: it has an associated contract agreement.");
    }
    const documentCount = await this.countDocuments(id);
    if (documentCount > 0) {
      throw new Error(`Cannot delete tender: it has ${documentCount} attached document(s). Remove documents first.`);
    }

    try {
      const result = await this.pool.query("DELETE FROM tenders WHERE id = $1", [id]);
      return Number(result.rowCount ?? 0) > 0;
    } catch (error: any) {
      if (error && (error.code === "23503" || /FOREIGN KEY/i.test(error.message))) {
        throw new Error("Cannot delete tender: dependent records exist.");
      }
      throw error;
    }
  }
}
