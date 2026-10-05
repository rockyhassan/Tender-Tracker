import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { TenderRepository, SqliteTenderRepository } from "./repository";
import type { Charge, ChargeInput, ContractAgreement, ContractAgreementInput, CreditCommitmentCertificate, CreditCommitmentCertificateInput, NOA, NOAInput, PayOrder, PayOrderInput, PerformanceSecurity, PerformanceSecurityInput, TenderDetails, TenderResult, TenderResultInput } from "../shared/domain";

const iso = (value?: string) => value ? new Date(value).toISOString() : null;
const optional = (value?: string) => value || null;
const common = (id: string, tenderId: string, createdAt: string, updatedAt: string) => ({ id, tender_id: tenderId, created_at: createdAt, updated_at: updatedAt });
const asRows = (rows: Record<string, SQLOutputValue>[]) => rows as unknown as Record<string, any>[];

export class LifecycleRepository {
  constructor(private readonly database: DatabaseSync, private readonly tenders: SqliteTenderRepository) {}

  details(tenderId: string): TenderDetails | undefined {
    const tender = this.tenders.findById(tenderId);
    if (!tender) return undefined;
    const charges = asRows(this.database.prepare("SELECT * FROM charges WHERE tender_id = ? ORDER BY charged_at DESC, created_at DESC").all(tenderId)).map(this.toCharge);
    return {
      tender,
      charges,
      totalCharges: charges.reduce((sum, item) => sum + item.amount, 0),
      totalCost: charges.reduce((sum, item) => sum + item.amount, 0),
      payOrders: asRows(this.database.prepare("SELECT p.*, COALESCE(pc.name, lc.name, tc.name) AS company_name, COALESCE(p.company_id, psl.company_id, t.company_id) AS resolved_company_id FROM pay_orders p JOIN tenders t ON t.id = p.tender_id LEFT JOIN companies pc ON pc.id = p.company_id LEFT JOIN purchase_sheet_lines psl ON psl.purchase_sheet_id = p.purchase_sheet_id AND psl.tender_id = p.tender_id LEFT JOIN companies lc ON lc.id = psl.company_id LEFT JOIN companies tc ON tc.id = t.company_id WHERE p.tender_id = ? ORDER BY p.issued_at DESC, p.created_at DESC").all(tenderId)).map(this.toPayOrder),
      creditCommitmentCertificates: asRows(this.database.prepare("SELECT * FROM credit_commitment_certificates WHERE tender_id = ? ORDER BY issued_at DESC, created_at DESC").all(tenderId)).map(this.toCertificate),
      result: this.result(tenderId),
      noa: this.noa(tenderId),
      performanceSecurity: this.security(tenderId),
      contractAgreement: this.contractAgreement(tenderId),
    };
  }

  resultCache(): Array<{ tenderId: string; result?: TenderResult }> {
    return this.tenders.list().map((tender) => ({ tenderId: tender.id, result: this.result(tender.id) }));
  }

  private exists(tenderId: string) { return Boolean(this.tenders.findById(tenderId)); }

  private readonly toCharge = (row: Record<string, any>): Charge => ({ id: row.id, tenderId: row.tender_id, purchaseSheetId: row.purchase_sheet_id ?? undefined, type: row.type, chargeType: row.type, amount: Number(row.amount), chargedAt: row.charged_at, reference: row.reference ?? undefined, remarks: row.remarks ?? undefined, description: row.description ?? undefined, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
  private readonly toPayOrder = (row: Record<string, any>): PayOrder => ({ id: row.id, tenderId: row.tender_id, purchaseSheetId: row.purchase_sheet_id ?? undefined, companyId: row.company_id ?? row.resolved_company_id ?? row.line_company_id ?? row.tender_company_id ?? undefined, company: row.company_name ?? undefined, orderNumber: row.order_number, amount: Number(row.amount), payee: row.payee ?? "", issuedAt: row.issued_at, expiresAt: row.expires_at ?? undefined, bank: row.bank ?? undefined, returnStatus: row.return_status ?? row.status ?? undefined, returnDueAt: row.return_due_at ?? undefined, returnedAt: row.returned_at ?? undefined, status: row.status, remarks: row.remarks ?? undefined, notes: row.notes ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
  private readonly toCertificate = (row: Record<string, any>): CreditCommitmentCertificate => ({ id: row.id, tenderId: row.tender_id, certificateNumber: row.certificate_number, amount: Number(row.amount), value: row.value == null ? undefined : Number(row.value), issuedAt: row.issued_at, expiresAt: row.expires_at ?? undefined, returnDate: row.return_date ?? undefined, issuingBank: row.issuing_bank ?? undefined, status: row.status, remarks: row.remarks ?? undefined, notes: row.notes ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
  private readonly toResult = (row: Record<string, any>): TenderResult => ({ id: row.id, tenderId: row.tender_id, outcome: row.outcome, announcedAt: row.announced_at ?? undefined, resultDate: row.result_date ?? row.announced_at ?? undefined, quotedAmount: row.quoted_amount == null ? undefined : Number(row.quoted_amount), rank: row.rank == null ? undefined : Number(row.rank), awardedCompany: row.awarded_company ?? undefined, remarks: row.remarks ?? undefined, notes: row.notes ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
  private readonly toNoa = (row: Record<string, any>): NOA => ({ id: row.id, tenderId: row.tender_id, noaNumber: row.noa_number, issuedAt: row.issued_at, acceptanceDeadline: row.acceptance_deadline ?? undefined, contractValue: row.contract_value == null ? undefined : Number(row.contract_value), status: row.status, remarks: row.remarks ?? undefined, notes: row.notes ?? undefined });
  private readonly toSecurity = (row: Record<string, any>): PerformanceSecurity => ({ id: row.id, tenderId: row.tender_id, securityNumber: row.security_number, amount: Number(row.amount), issuedAt: row.issued_at, expiresAt: row.expires_at, returnDate: row.return_date ?? undefined, returnStatus: row.return_status ?? undefined, returnRemarks: row.return_remarks ?? undefined, provider: row.provider ?? undefined, status: row.status, remarks: row.remarks ?? undefined, notes: row.notes ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
  private readonly toContractAgreement = (row: Record<string, any>): ContractAgreement => ({ id: row.id, tenderId: row.tender_id, contractNumber: row.contract_number, signedAt: row.signed_at, agreementDate: row.signed_at, signUpDate: row.signed_at, startDate: row.start_date ?? undefined, endDate: row.end_date ?? undefined, contractValue: Number(row.contract_value), status: row.status, remarks: row.remarks ?? undefined, notes: row.notes ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });

  listCharges(tenderId: string) { return this.details(tenderId)?.charges ?? []; }
  createCharge(tenderId: string, input: ChargeInput): Charge {
    this.requireTender(tenderId); const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare("INSERT INTO charges (id,tender_id,purchase_sheet_id,type,amount,charged_at,reference,remarks,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id,tenderId,input.purchaseSheetId ?? null,input.type,input.amount,iso(input.chargedAt),optional(input.reference),optional(input.remarks ?? input.description),optional(input.description),input.status ?? "Completed",now,now);
    return this.toCharge(this.database.prepare("SELECT * FROM charges WHERE id = ?").get(id) as any);
  }
  updateCharge(id: string, input: Partial<ChargeInput>) { return this.updateSimple("charges", id, input, (row) => this.toCharge(row), { chargedAt: "charged_at", purchaseSheetId: "purchase_sheet_id", type: "type", amount: "amount", reference: "reference", remarks: "remarks", description: "description", status: "status" }); }
  deleteCharge(id: string) { return this.deleteSimple("charges", id); }

  listPayOrders(tenderId: string) { return this.details(tenderId)?.payOrders ?? []; }
  listAllPayOrders() { return (this.database.prepare("SELECT p.*, t.tender_id AS tender_reference, COALESCE(pc.name, lc.name, tc.name) AS company_name, COALESCE(p.company_id, psl.company_id, t.company_id) AS resolved_company_id FROM pay_orders p JOIN tenders t ON t.id = p.tender_id LEFT JOIN companies pc ON pc.id = p.company_id LEFT JOIN purchase_sheet_lines psl ON psl.purchase_sheet_id = p.purchase_sheet_id AND psl.tender_id = p.tender_id LEFT JOIN companies lc ON lc.id = psl.company_id LEFT JOIN companies tc ON tc.id = t.company_id ORDER BY p.issued_at DESC, p.created_at DESC").all() as Array<Record<string, any>>).map((row) => ({ ...this.toPayOrder(row), tenderReference: row.tender_reference, company: row.company_name ?? "Unassigned" })); }
  createPayOrder(tenderId: string, input: PayOrderInput): PayOrder {
    this.requireTender(tenderId); this.requireCompany(input.companyId); const id=randomUUID(); const now=new Date().toISOString(); const status=input.status ?? input.returnStatus ?? "Pending";
    this.database.prepare("INSERT INTO pay_orders (id,tender_id,purchase_sheet_id,company_id,order_number,amount,payee,issued_at,expires_at,bank,return_status,return_due_at,returned_at,status,remarks,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,tenderId,input.purchaseSheetId ?? null,input.companyId,input.orderNumber,input.amount,input.payee,iso(input.issuedAt),iso(input.expiresAt),optional(input.bank),input.returnStatus ?? status,iso(input.returnDueAt),iso(input.returnedAt),status,optional(input.remarks ?? input.notes),optional(input.notes),now,now);
    return this.toPayOrder(this.database.prepare("SELECT * FROM pay_orders WHERE id = ?").get(id) as any);
  }
  updatePayOrder(id: string, input: Partial<PayOrderInput>) { if (input.companyId !== undefined) this.requireCompany(input.companyId); return this.updateSimple("pay_orders", id, input, (row) => this.toPayOrder(row), { purchaseSheetId:"purchase_sheet_id",companyId:"company_id",orderNumber:"order_number",amount:"amount",payee:"payee",issuedAt:"issued_at",expiresAt:"expires_at",bank:"bank",returnStatus:"return_status",returnDueAt:"return_due_at",returnedAt:"returned_at",status:"status",remarks:"remarks",notes:"notes" }, ["issuedAt","expiresAt","returnDueAt","returnedAt"]); }
  deletePayOrder(id: string) { return this.deleteSimple("pay_orders", id); }

  listCertificates(tenderId: string) { return this.details(tenderId)?.creditCommitmentCertificates ?? []; }
  createCertificate(tenderId: string, input: CreditCommitmentCertificateInput): CreditCommitmentCertificate {
    this.requireTender(tenderId); const id=randomUUID(); const now=new Date().toISOString();
    this.database.prepare("INSERT INTO credit_commitment_certificates (id,tender_id,certificate_number,amount,value,issued_at,expires_at,return_date,issuing_bank,status,remarks,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,tenderId,input.certificateNumber,input.amount,input.value ?? input.amount,iso(input.issuedAt),iso(input.expiresAt),iso(input.returnDate),optional(input.issuingBank),input.status ?? "Pending",optional(input.remarks ?? input.notes),optional(input.notes),now,now);
    return this.toCertificate(this.database.prepare("SELECT * FROM credit_commitment_certificates WHERE id = ?").get(id) as any);
  }
  updateCertificate(id: string, input: Partial<CreditCommitmentCertificateInput>) { return this.updateSimple("credit_commitment_certificates", id, input, (row) => this.toCertificate(row), {certificateNumber:"certificate_number",amount:"amount",value:"value",issuedAt:"issued_at",expiresAt:"expires_at",returnDate:"return_date",issuingBank:"issuing_bank",status:"status",remarks:"remarks",notes:"notes"}, ["issuedAt","expiresAt","returnDate"]); }
  deleteCertificate(id: string) { return this.deleteSimple("credit_commitment_certificates", id); }

  result(tenderId: string) { const row=this.database.prepare("SELECT * FROM results WHERE tender_id = ? ORDER BY updated_at DESC LIMIT 1").get(tenderId); return row ? this.toResult(row as any) : undefined; }
  upsertResult(tenderId: string, input: TenderResultInput): TenderResult {
    this.requireTender(tenderId); const existing=this.result(tenderId); const id=existing?.id ?? randomUUID(); const now=new Date().toISOString();
    const values=[id,tenderId,input.outcome,iso(input.announcedAt ?? input.resultDate),iso(input.resultDate ?? input.announcedAt),input.quotedAmount ?? null,input.rank ?? null,optional(input.awardedCompany),optional(input.remarks ?? input.notes),optional(input.notes),existing?.createdAt ?? now,now];
    this.database.prepare(`INSERT INTO results (id,tender_id,outcome,announced_at,result_date,quoted_amount,rank,awarded_company,remarks,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tender_id) DO UPDATE SET outcome=excluded.outcome,announced_at=excluded.announced_at,result_date=excluded.result_date,quoted_amount=excluded.quoted_amount,rank=excluded.rank,awarded_company=excluded.awarded_company,remarks=excluded.remarks,notes=excluded.notes,updated_at=excluded.updated_at`).run(...values);
    return this.result(tenderId)!;
  }

  noa(tenderId: string) { const row=this.database.prepare("SELECT * FROM noa WHERE tender_id = ? ORDER BY updated_at DESC LIMIT 1").get(tenderId); return row ? this.toNoa(row as any) : undefined; }
  upsertNoa(tenderId: string, input: NOAInput): NOA {
    this.requireTender(tenderId); const existing=this.noa(tenderId); const id=existing?.id ?? randomUUID(); const now=new Date().toISOString(); const values=[id,tenderId,input.noaNumber,iso(input.issuedAt),iso(input.acceptanceDeadline),input.contractValue ?? null,input.status ?? "Pending",optional(input.remarks ?? input.notes),optional(input.notes),existing?.createdAt ?? now,now];
    this.database.prepare(`INSERT INTO noa (id,tender_id,noa_number,issued_at,acceptance_deadline,contract_value,status,remarks,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tender_id) DO UPDATE SET noa_number=excluded.noa_number,issued_at=excluded.issued_at,acceptance_deadline=excluded.acceptance_deadline,contract_value=excluded.contract_value,status=excluded.status,remarks=excluded.remarks,notes=excluded.notes,updated_at=excluded.updated_at`).run(...values);
    return this.noa(tenderId)!;
  }
  upsertSecurity(tenderId: string, input: PerformanceSecurityInput): PerformanceSecurity {
    this.requireTender(tenderId); const existing=this.security(tenderId); const id=existing?.id ?? randomUUID(); const now=new Date().toISOString(); const values=[id,tenderId,input.securityNumber,input.amount,iso(input.issuedAt),iso(input.expiresAt),iso(input.returnDate),input.returnStatus ?? null,optional(input.returnRemarks),optional(input.provider),input.status ?? "Pending",optional(input.remarks ?? input.notes),optional(input.notes),existing?.createdAt ?? now,now];
    this.database.prepare(`INSERT INTO performance_securities (id,tender_id,security_number,amount,issued_at,expires_at,return_date,return_status,return_remarks,provider,status,remarks,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tender_id) DO UPDATE SET security_number=excluded.security_number,amount=excluded.amount,issued_at=excluded.issued_at,expires_at=excluded.expires_at,return_date=excluded.return_date,return_status=excluded.return_status,return_remarks=excluded.return_remarks,provider=excluded.provider,status=excluded.status,remarks=excluded.remarks,notes=excluded.notes,updated_at=excluded.updated_at`).run(...values);
    return this.security(tenderId)!;
  }
  private security(tenderId: string) { const row=this.database.prepare("SELECT * FROM performance_securities WHERE tender_id = ? ORDER BY updated_at DESC LIMIT 1").get(tenderId); return row ? this.toSecurity(row as any) : undefined; }
  listAllPerformanceSecurities() { return (this.database.prepare("SELECT p.*, t.tender_id AS tender_reference, c.name AS tender_company FROM performance_securities p JOIN tenders t ON t.id = p.tender_id JOIN companies c ON c.id = t.company_id ORDER BY p.issued_at DESC, p.created_at DESC").all() as Array<Record<string, any>>).map((row) => ({ ...this.toSecurity(row), tenderReference: row.tender_reference, company: row.tender_company })); }
  contractAgreement(tenderId: string) { const row=this.database.prepare("SELECT * FROM contract_agreements WHERE tender_id = ? ORDER BY updated_at DESC LIMIT 1").get(tenderId); return row ? this.toContractAgreement(row as any) : undefined; }
  upsertContractAgreement(tenderId: string, input: ContractAgreementInput): ContractAgreement {
    this.requireTender(tenderId); const existing=this.contractAgreement(tenderId); const id=existing?.id ?? randomUUID(); const now=new Date().toISOString();
    const signedAt=input.signedAt ?? input.agreementDate ?? input.signUpDate;
    const values=[id,tenderId,input.contractNumber,iso(signedAt),iso(input.startDate),iso(input.endDate),input.contractValue,input.status ?? "Pending",optional(input.remarks ?? input.notes),optional(input.notes),existing?.createdAt ?? now,now];
    this.database.prepare(`INSERT INTO contract_agreements (id,tender_id,contract_number,signed_at,start_date,end_date,contract_value,status,remarks,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tender_id) DO UPDATE SET contract_number=excluded.contract_number,signed_at=excluded.signed_at,start_date=excluded.start_date,end_date=excluded.end_date,contract_value=excluded.contract_value,status=excluded.status,remarks=excluded.remarks,notes=excluded.notes,updated_at=excluded.updated_at`).run(...values);
    return this.contractAgreement(tenderId)!;
  }
  updateContractAgreement(id: string, input: Partial<ContractAgreementInput>) { return this.updateSimple("contract_agreements", id, input, (row) => this.toContractAgreement(row), { contractNumber:"contract_number", signedAt:"signed_at", startDate:"start_date", endDate:"end_date", contractValue:"contract_value", status:"status", remarks:"remarks", notes:"notes" }, ["signedAt","startDate","endDate"]); }

  private requireTender(tenderId: string) { if (!this.exists(tenderId)) throw new Error("Tender not found"); }
  private requireCompany(companyId: string) { if (!this.database.prepare("SELECT 1 FROM companies WHERE id = ?").get(companyId)) throw new Error("Selected company was not found"); }
  private updateSimple<T>(table: string, id: string, input: Record<string, any>, map: (row: Record<string, any>) => T, fields: Record<string,string>, dateFields: string[] = []): T | undefined {
    const current=this.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id); if (!current) return undefined; const values: Array<[string, SQLOutputValue]> = [];
    for (const [key,column] of Object.entries(fields)) if (input[key] !== undefined) values.push([column, dateFields.includes(key) ? iso(input[key]) : (input[key] || null)]);
    values.push(["updated_at",new Date().toISOString()]); this.database.prepare(`UPDATE ${table} SET ${values.map(([field])=>`${field} = ?`).join(", ")} WHERE id = ?`).run(...values.map(([,value])=>value),id); return map(this.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any);
  }
  private deleteSimple(table: string, id: string) { return (this.database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id) as { changes: number }).changes > 0; }
}

export { PgLifecycleRepository } from "./pg-lifecycle-repository";

