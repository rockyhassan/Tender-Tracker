import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { TenderRepository } from "./repository";
import type {
  Charge,
  ChargeInput,
  ContractAgreement,
  ContractAgreementInput,
  CreditCommitmentCertificate,
  CreditCommitmentCertificateInput,
  NOA,
  NOAInput,
  PayOrder,
  PayOrderInput,
  PerformanceSecurity,
  PerformanceSecurityInput,
  TenderDetails,
  TenderResult,
  TenderResultInput,
} from "../shared/domain";

const iso = (value?: string) => (value ? new Date(value).toISOString() : null);
const optional = (value?: string) => value || null;

const toIso = (val: unknown): string | undefined => {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

export class PgLifecycleRepository {
  constructor(private readonly pool: pg.Pool, private readonly tenders: TenderRepository) {}

  private readonly toCharge = (row: Record<string, any>): Charge => ({
    id: row.id,
    tenderId: row.tender_id,
    purchaseSheetId: row.purchase_sheet_id ?? undefined,
    type: row.type,
    chargeType: row.type,
    amount: Number(row.amount),
    chargedAt: toIso(row.charged_at)!,
    reference: row.reference ?? undefined,
    remarks: row.remarks ?? undefined,
    description: row.description ?? undefined,
    status: row.status,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  });

  private readonly toPayOrder = (row: Record<string, any>): PayOrder => ({
    id: row.id,
    tenderId: row.tender_id,
    purchaseSheetId: row.purchase_sheet_id ?? undefined,
    companyId: row.company_id ?? row.resolved_company_id ?? row.line_company_id ?? row.tender_company_id ?? undefined,
    company: row.company_name ?? undefined,
    orderNumber: row.order_number,
    amount: Number(row.amount),
    payee: row.payee ?? "",
    issuedAt: toIso(row.issued_at)!,
    expiresAt: toIso(row.expires_at),
    bank: row.bank ?? undefined,
    returnStatus: row.return_status ?? row.status ?? undefined,
    returnDueAt: toIso(row.return_due_at),
    returnedAt: toIso(row.returned_at),
    status: row.status,
    remarks: row.remarks ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  });

  private readonly toCertificate = (row: Record<string, any>): CreditCommitmentCertificate => ({
    id: row.id,
    tenderId: row.tender_id,
    certificateNumber: row.certificate_number,
    amount: Number(row.amount),
    value: row.value == null ? undefined : Number(row.value),
    issuedAt: toIso(row.issued_at)!,
    expiresAt: toIso(row.expires_at),
    returnDate: toIso(row.return_date),
    issuingBank: row.issuing_bank ?? undefined,
    status: row.status,
    remarks: row.remarks ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  });

  private readonly toResult = (row: Record<string, any>): TenderResult => ({
    id: row.id,
    tenderId: row.tender_id,
    outcome: row.outcome,
    announcedAt: toIso(row.announced_at),
    resultDate: toIso(row.result_date ?? row.announced_at),
    quotedAmount: row.quoted_amount == null ? undefined : Number(row.quoted_amount),
    rank: row.rank == null ? undefined : Number(row.rank),
    awardedCompany: row.awarded_company ?? undefined,
    remarks: row.remarks ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  });

  private readonly toNoa = (row: Record<string, any>): NOA => ({
    id: row.id,
    tenderId: row.tender_id,
    noaNumber: row.noa_number,
    issuedAt: toIso(row.issued_at)!,
    acceptanceDeadline: toIso(row.acceptance_deadline),
    contractValue: row.contract_value == null ? undefined : Number(row.contract_value),
    status: row.status,
    remarks: row.remarks ?? undefined,
    notes: row.notes ?? undefined,
  });

  private readonly toSecurity = (row: Record<string, any>): PerformanceSecurity => ({
    id: row.id,
    tenderId: row.tender_id,
    securityNumber: row.security_number,
    amount: Number(row.amount),
    issuedAt: toIso(row.issued_at)!,
    expiresAt: toIso(row.expires_at)!,
    returnDate: toIso(row.return_date),
    returnStatus: row.return_status ?? undefined,
    returnRemarks: row.return_remarks ?? undefined,
    provider: row.provider ?? undefined,
    status: row.status,
    remarks: row.remarks ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  });

  private readonly toContractAgreement = (row: Record<string, any>): ContractAgreement => ({
    id: row.id,
    tenderId: row.tender_id,
    contractNumber: row.contract_number,
    signedAt: toIso(row.signed_at)!,
    agreementDate: toIso(row.signed_at)!,
    signUpDate: toIso(row.signed_at)!,
    startDate: toIso(row.start_date),
    endDate: toIso(row.end_date),
    contractValue: Number(row.contract_value),
    status: row.status,
    remarks: row.remarks ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  });

  private async exists(tenderId: string): Promise<boolean> {
    const tender = await this.tenders.findById(tenderId);
    return Boolean(tender);
  }

  private async requireTender(tenderId: string): Promise<void> {
    if (!(await this.exists(tenderId))) throw new Error("Tender not found");
  }

  private async requireCompany(companyId: string): Promise<void> {
    const res = await this.pool.query("SELECT 1 FROM companies WHERE id = $1", [companyId]);
    if (res.rows.length === 0) throw new Error("Selected company was not found");
  }

  async details(tenderId: string): Promise<TenderDetails | undefined> {
    const tender = await this.tenders.findById(tenderId);
    if (!tender) return undefined;

    const chargesRes = await this.pool.query("SELECT * FROM charges WHERE tender_id = $1 ORDER BY charged_at DESC, created_at DESC", [tenderId]);
    const charges = chargesRes.rows.map(this.toCharge);

    const payOrdersSql = `
      SELECT p.*, COALESCE(pc.name, lc.name, tc.name) AS company_name,
             COALESCE(p.company_id, psl.company_id, t.company_id) AS resolved_company_id
      FROM pay_orders p
      JOIN tenders t ON t.id = p.tender_id
      LEFT JOIN companies pc ON pc.id = p.company_id
      LEFT JOIN purchase_sheet_lines psl ON psl.purchase_sheet_id = p.purchase_sheet_id AND psl.tender_id = p.tender_id
      LEFT JOIN companies lc ON lc.id = psl.company_id
      LEFT JOIN companies tc ON tc.id = t.company_id
      WHERE p.tender_id = $1
      ORDER BY p.issued_at DESC, p.created_at DESC
    `;
    const payOrdersRes = await this.pool.query(payOrdersSql, [tenderId]);
    const payOrders = payOrdersRes.rows.map(this.toPayOrder);

    const certsRes = await this.pool.query("SELECT * FROM credit_commitment_certificates WHERE tender_id = $1 ORDER BY issued_at DESC, created_at DESC", [tenderId]);
    const creditCommitmentCertificates = certsRes.rows.map(this.toCertificate);

    const [resResult, resNoa, resSec, resContract] = await Promise.all([
      this.result(tenderId),
      this.noa(tenderId),
      this.security(tenderId),
      this.contractAgreement(tenderId),
    ]);

    return {
      tender,
      charges,
      totalCharges: charges.reduce((sum, item) => sum + item.amount, 0),
      totalCost: charges.reduce((sum, item) => sum + item.amount, 0),
      payOrders,
      creditCommitmentCertificates,
      result: resResult,
      noa: resNoa,
      performanceSecurity: resSec,
      contractAgreement: resContract,
    };
  }

  async resultCache(): Promise<Array<{ tenderId: string; result?: TenderResult }>> {
    const tenders = await this.tenders.list();
    return Promise.all(
      tenders.map(async (tender) => ({
        tenderId: tender.id,
        result: await this.result(tender.id),
      }))
    );
  }

  async listCharges(tenderId: string): Promise<Charge[]> {
    const details = await this.details(tenderId);
    return details?.charges ?? [];
  }

  async createCharge(tenderId: string, input: ChargeInput): Promise<Charge> {
    await this.requireTender(tenderId);
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO charges (id, tender_id, purchase_sheet_id, type, amount, charged_at, reference, remarks, description, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        tenderId,
        input.purchaseSheetId ?? null,
        input.type,
        input.amount,
        iso(input.chargedAt),
        optional(input.reference),
        optional(input.remarks ?? input.description),
        optional(input.description),
        input.status ?? "Completed",
        now,
        now,
      ]
    );
    const res = await this.pool.query("SELECT * FROM charges WHERE id = $1", [id]);
    return this.toCharge(res.rows[0]);
  }

  async updateCharge(id: string, input: Partial<ChargeInput>): Promise<Charge | undefined> {
    return this.updateSimple("charges", id, input, (row) => this.toCharge(row), {
      chargedAt: "charged_at",
      purchaseSheetId: "purchase_sheet_id",
      type: "type",
      amount: "amount",
      reference: "reference",
      remarks: "remarks",
      description: "description",
      status: "status",
    }, ["chargedAt"]);
  }

  async deleteCharge(id: string): Promise<boolean> {
    return this.deleteSimple("charges", id);
  }

  async listPayOrders(tenderId: string): Promise<PayOrder[]> {
    const details = await this.details(tenderId);
    return details?.payOrders ?? [];
  }

  async listAllPayOrders(): Promise<PayOrder[]> {
    const sql = `
      SELECT p.*, t.tender_id AS tender_reference,
             COALESCE(pc.name, lc.name, tc.name) AS company_name,
             COALESCE(p.company_id, psl.company_id, t.company_id) AS resolved_company_id
      FROM pay_orders p
      JOIN tenders t ON t.id = p.tender_id
      LEFT JOIN companies pc ON pc.id = p.company_id
      LEFT JOIN purchase_sheet_lines psl ON psl.purchase_sheet_id = p.purchase_sheet_id AND psl.tender_id = p.tender_id
      LEFT JOIN companies lc ON lc.id = psl.company_id
      LEFT JOIN companies tc ON tc.id = t.company_id
      ORDER BY p.issued_at DESC, p.created_at DESC
    `;
    const res = await this.pool.query(sql);
    return res.rows.map((row) => ({
      ...this.toPayOrder(row),
      tenderReference: row.tender_reference,
      company: row.company_name ?? "Unassigned",
    }));
  }

  async createPayOrder(tenderId: string, input: PayOrderInput): Promise<PayOrder> {
    await this.requireTender(tenderId);
    await this.requireCompany(input.companyId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? input.returnStatus ?? "Pending";
    await this.pool.query(
      `INSERT INTO pay_orders (id, tender_id, purchase_sheet_id, company_id, order_number, amount, payee, issued_at, expires_at, bank, return_status, return_due_at, returned_at, status, remarks, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        id,
        tenderId,
        input.purchaseSheetId ?? null,
        input.companyId,
        input.orderNumber,
        input.amount,
        input.payee,
        iso(input.issuedAt),
        iso(input.expiresAt),
        optional(input.bank),
        input.returnStatus ?? status,
        iso(input.returnDueAt),
        iso(input.returnedAt),
        status,
        optional(input.remarks ?? input.notes),
        optional(input.notes),
        now,
        now,
      ]
    );
    const res = await this.pool.query("SELECT * FROM pay_orders WHERE id = $1", [id]);
    return this.toPayOrder(res.rows[0]);
  }

  async updatePayOrder(id: string, input: Partial<PayOrderInput>): Promise<PayOrder | undefined> {
    if (input.companyId !== undefined) await this.requireCompany(input.companyId);
    return this.updateSimple("pay_orders", id, input, (row) => this.toPayOrder(row), {
      purchaseSheetId: "purchase_sheet_id",
      companyId: "company_id",
      orderNumber: "order_number",
      amount: "amount",
      payee: "payee",
      issuedAt: "issued_at",
      expiresAt: "expires_at",
      bank: "bank",
      returnStatus: "return_status",
      returnDueAt: "return_due_at",
      returnedAt: "returned_at",
      status: "status",
      remarks: "remarks",
      notes: "notes",
    }, ["issuedAt", "expiresAt", "returnDueAt", "returnedAt"]);
  }

  async deletePayOrder(id: string): Promise<boolean> {
    return this.deleteSimple("pay_orders", id);
  }

  async listCertificates(tenderId: string): Promise<CreditCommitmentCertificate[]> {
    const details = await this.details(tenderId);
    return details?.creditCommitmentCertificates ?? [];
  }

  async createCertificate(tenderId: string, input: CreditCommitmentCertificateInput): Promise<CreditCommitmentCertificate> {
    await this.requireTender(tenderId);
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO credit_commitment_certificates (id, tender_id, certificate_number, amount, value, issued_at, expires_at, return_date, issuing_bank, status, remarks, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        tenderId,
        input.certificateNumber,
        input.amount,
        input.value ?? input.amount,
        iso(input.issuedAt),
        iso(input.expiresAt),
        iso(input.returnDate),
        optional(input.issuingBank),
        input.status ?? "Pending",
        optional(input.remarks ?? input.notes),
        optional(input.notes),
        now,
        now,
      ]
    );
    const res = await this.pool.query("SELECT * FROM credit_commitment_certificates WHERE id = $1", [id]);
    return this.toCertificate(res.rows[0]);
  }

  async updateCertificate(id: string, input: Partial<CreditCommitmentCertificateInput>): Promise<CreditCommitmentCertificate | undefined> {
    return this.updateSimple("credit_commitment_certificates", id, input, (row) => this.toCertificate(row), {
      certificateNumber: "certificate_number",
      amount: "amount",
      value: "value",
      issuedAt: "issued_at",
      expiresAt: "expires_at",
      returnDate: "return_date",
      issuingBank: "issuing_bank",
      status: "status",
      remarks: "remarks",
      notes: "notes",
    }, ["issuedAt", "expiresAt", "returnDate"]);
  }

  async deleteCertificate(id: string): Promise<boolean> {
    return this.deleteSimple("credit_commitment_certificates", id);
  }

  async result(tenderId: string): Promise<TenderResult | undefined> {
    const res = await this.pool.query("SELECT * FROM results WHERE tender_id = $1 ORDER BY updated_at DESC LIMIT 1", [tenderId]);
    return res.rows[0] ? this.toResult(res.rows[0]) : undefined;
  }

  async upsertResult(tenderId: string, input: TenderResultInput): Promise<TenderResult> {
    await this.requireTender(tenderId);
    const existing = await this.result(tenderId);
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const values = [
      id,
      tenderId,
      input.outcome,
      iso(input.announcedAt ?? input.resultDate),
      iso(input.resultDate ?? input.announcedAt),
      input.quotedAmount ?? null,
      input.rank ?? null,
      optional(input.awardedCompany),
      optional(input.remarks ?? input.notes),
      optional(input.notes),
      existing?.createdAt ?? now,
      now,
    ];
    await this.pool.query(
      `INSERT INTO results (id, tender_id, outcome, announced_at, result_date, quoted_amount, rank, awarded_company, remarks, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tender_id) DO UPDATE SET
         outcome = EXCLUDED.outcome,
         announced_at = EXCLUDED.announced_at,
         result_date = EXCLUDED.result_date,
         quoted_amount = EXCLUDED.quoted_amount,
         rank = EXCLUDED.rank,
         awarded_company = EXCLUDED.awarded_company,
         remarks = EXCLUDED.remarks,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at`,
      values
    );
    return (await this.result(tenderId))!;
  }

  async noa(tenderId: string): Promise<NOA | undefined> {
    const res = await this.pool.query("SELECT * FROM noa WHERE tender_id = $1 ORDER BY updated_at DESC LIMIT 1", [tenderId]);
    return res.rows[0] ? this.toNoa(res.rows[0]) : undefined;
  }

  async upsertNoa(tenderId: string, input: NOAInput): Promise<NOA> {
    await this.requireTender(tenderId);
    const existing = await this.noa(tenderId);
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const values = [
      id,
      tenderId,
      input.noaNumber,
      iso(input.issuedAt),
      iso(input.acceptanceDeadline),
      input.contractValue ?? null,
      input.status ?? "Pending",
      optional(input.remarks ?? input.notes),
      optional(input.notes),
      existing?.createdAt ?? now,
      now,
    ];
    await this.pool.query(
      `INSERT INTO noa (id, tender_id, noa_number, issued_at, acceptance_deadline, contract_value, status, remarks, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tender_id) DO UPDATE SET
         noa_number = EXCLUDED.noa_number,
         issued_at = EXCLUDED.issued_at,
         acceptance_deadline = EXCLUDED.acceptance_deadline,
         contract_value = EXCLUDED.contract_value,
         status = EXCLUDED.status,
         remarks = EXCLUDED.remarks,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at`,
      values
    );
    return (await this.noa(tenderId))!;
  }

  private async security(tenderId: string): Promise<PerformanceSecurity | undefined> {
    const res = await this.pool.query("SELECT * FROM performance_securities WHERE tender_id = $1 ORDER BY updated_at DESC LIMIT 1", [tenderId]);
    return res.rows[0] ? this.toSecurity(res.rows[0]) : undefined;
  }

  async upsertSecurity(tenderId: string, input: PerformanceSecurityInput): Promise<PerformanceSecurity> {
    await this.requireTender(tenderId);
    const existing = await this.security(tenderId);
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const values = [
      id,
      tenderId,
      input.securityNumber,
      input.amount,
      iso(input.issuedAt),
      iso(input.expiresAt),
      iso(input.returnDate),
      input.returnStatus ?? null,
      optional(input.returnRemarks),
      optional(input.provider),
      input.status ?? "Pending",
      optional(input.remarks ?? input.notes),
      optional(input.notes),
      existing?.createdAt ?? now,
      now,
    ];
    await this.pool.query(
      `INSERT INTO performance_securities (id, tender_id, security_number, amount, issued_at, expires_at, return_date, return_status, return_remarks, provider, status, remarks, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (tender_id) DO UPDATE SET
         security_number = EXCLUDED.security_number,
         amount = EXCLUDED.amount,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         return_date = EXCLUDED.return_date,
         return_status = EXCLUDED.return_status,
         return_remarks = EXCLUDED.return_remarks,
         provider = EXCLUDED.provider,
         status = EXCLUDED.status,
         remarks = EXCLUDED.remarks,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at`,
      values
    );
    return (await this.security(tenderId))!;
  }

  async listAllPerformanceSecurities(): Promise<PerformanceSecurity[]> {
    const sql = `
      SELECT p.*, t.tender_id AS tender_reference, c.name AS tender_company
      FROM performance_securities p
      JOIN tenders t ON t.id = p.tender_id
      JOIN companies c ON c.id = t.company_id
      ORDER BY p.issued_at DESC, p.created_at DESC
    `;
    const res = await this.pool.query(sql);
    return res.rows.map((row) => ({
      ...this.toSecurity(row),
      tenderReference: row.tender_reference,
      company: row.tender_company,
    }));
  }

  async contractAgreement(tenderId: string): Promise<ContractAgreement | undefined> {
    const res = await this.pool.query("SELECT * FROM contract_agreements WHERE tender_id = $1 ORDER BY updated_at DESC LIMIT 1", [tenderId]);
    return res.rows[0] ? this.toContractAgreement(res.rows[0]) : undefined;
  }

  async upsertContractAgreement(tenderId: string, input: ContractAgreementInput): Promise<ContractAgreement> {
    await this.requireTender(tenderId);
    const existing = await this.contractAgreement(tenderId);
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const signedAt = input.signedAt ?? input.agreementDate ?? input.signUpDate;
    const values = [
      id,
      tenderId,
      input.contractNumber,
      iso(signedAt),
      iso(input.startDate),
      iso(input.endDate),
      input.contractValue,
      input.status ?? "Pending",
      optional(input.remarks ?? input.notes),
      optional(input.notes),
      existing?.createdAt ?? now,
      now,
    ];
    await this.pool.query(
      `INSERT INTO contract_agreements (id, tender_id, contract_number, signed_at, start_date, end_date, contract_value, status, remarks, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tender_id) DO UPDATE SET
         contract_number = EXCLUDED.contract_number,
         signed_at = EXCLUDED.signed_at,
         start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date,
         contract_value = EXCLUDED.contract_value,
         status = EXCLUDED.status,
         remarks = EXCLUDED.remarks,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at`,
      values
    );
    return (await this.contractAgreement(tenderId))!;
  }

  async updateContractAgreement(id: string, input: Partial<ContractAgreementInput>): Promise<ContractAgreement | undefined> {
    return this.updateSimple("contract_agreements", id, input, (row) => this.toContractAgreement(row), {
      contractNumber: "contract_number",
      signedAt: "signed_at",
      startDate: "start_date",
      endDate: "end_date",
      contractValue: "contract_value",
      status: "status",
      remarks: "remarks",
      notes: "notes",
    }, ["signedAt", "startDate", "endDate"]);
  }

  private async updateSimple<T>(
    table: string,
    id: string,
    input: Record<string, any>,
    map: (row: Record<string, any>) => T,
    fields: Record<string, string>,
    dateFields: string[] = []
  ): Promise<T | undefined> {
    const current = await this.pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    if (current.rows.length === 0) return undefined;

    const values: Array<[string, any]> = [];
    for (const [key, column] of Object.entries(fields)) {
      if (input[key] !== undefined) {
        values.push([column, dateFields.includes(key) ? iso(input[key]) : (input[key] || null)]);
      }
    }
    values.push(["updated_at", new Date().toISOString()]);

    const assignments = values.map(([field], idx) => `"${field}" = $${idx + 1}`).join(", ");
    await this.pool.query(
      `UPDATE ${table} SET ${assignments} WHERE id = $${values.length + 1}`,
      [...values.map(([, val]) => val), id]
    );
    const updated = await this.pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return map(updated.rows[0]);
  }

  private async deleteSimple(table: string, id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return Number(res.rowCount ?? 0) > 0;
  }
}
