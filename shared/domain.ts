import { z } from "zod";
export * from "./bank-domain";

export const workflowStages = [
  "New", "Purchase Pending", "Purchased", "Submitted", "Result Pending", "Win/Lost", "NOA", "Performance Security", "Contract Agreement",
] as const;
export type WorkflowStage = (typeof workflowStages)[number];
export const tenderStatuses = ["Draft", "Active", "Closed"] as const;
export type TenderStatus = (typeof tenderStatuses)[number];
export const entityStatuses = ["Pending", "Active", "Completed", "Cancelled", "Expired", "Returned"] as const;
export type EntityStatus = (typeof entityStatuses)[number];
export const issueBatchStatuses = ["Draft", "Issued", "Completed", "Cancelled"] as const;
export type IssueBatchStatus = (typeof issueBatchStatuses)[number];
export const purchaseSheetStatuses = ["Draft", "Sent to Bank", "Purchased", "Completed"] as const;
export type PurchaseSheetStatus = (typeof purchaseSheetStatuses)[number];
export const purchaseSheetViewModes = ["flat", "company-grouped"] as const;
export type PurchaseSheetViewMode = (typeof purchaseSheetViewModes)[number];
export const resultOutcomes = ["Won", "Lost", "Cancelled", "Pending"] as const;
export type ResultOutcome = (typeof resultOutcomes)[number];

export interface Company { id: string; name: string; code?: string; contact?: string; notes?: string; archivedAt?: string; tenderUsername?: string; tenderUsernameCiphertext?: string; tenderPasswordCiphertext?: string; createdAt?: string; updatedAt?: string; }
export interface CompanySecuritySummary { id: string; name: string; code?: string; contact?: string; notes?: string; archivedAt?: string; hasCredentials: boolean; usernameMasked?: string; updatedAt?: string; }
export interface IssueBatch { id: string; issueDate: string; authorityZone: string; authorityId?: string; authorityName?: string; reference?: string; notes?: string; status: IssueBatchStatus; createdAt?: string; updatedAt?: string; tenderCount?: number; purchaseSheetCount?: number; }
export interface IssueBatchTenderRow { tenderId: string; packageName: string; closingAt: string; submissionAt?: string; tenderValue?: number; submittedValue?: number; stage: WorkflowStage; status: TenderStatus; }
export interface IssueBatchWithTendersResult { batch: IssueBatch; tenders: Tender[]; }
export interface Tender { id: string; tenderId: string; referenceNo?: string | null; company: string; authority: string; packageName: string; closingAt: string; submissionAt?: string; tenderValue?: number; submittedValue?: number; stage: WorkflowStage; status: TenderStatus; companyId?: string; authorityZone?: string; issueBatchId?: string; createdAt?: string; updatedAt?: string; }
export interface TenderSubmission { id: string; tenderId: string; submittedAt: string; submittedValue: number; submissionReference?: string; status?: EntityStatus; notes?: string; createdAt?: string; updatedAt?: string; }
export interface PurchaseSheetLine { tenderId: string; companyId?: string; company: string; }
export interface PurchaseSheetViewMetadata { mode: PurchaseSheetViewMode; lineCount: number; companyCount: number; companies: string[]; }
export interface PurchaseSheet { id: string; issueBatchId: string; sheetNumber?: string; purchasedAt?: string; purchaseAmount?: number; paymentMethod?: string; status: PurchaseSheetStatus; viewMode: PurchaseSheetViewMode; bankEmailTo?: string; bankEmailCc?: string; bankEmailSubject?: string; notes?: string; selectedTenderIds: string[]; lineAssignments?: PurchaseSheetLine[]; tenders: Tender[]; viewMetadata: PurchaseSheetViewMetadata; createdAt?: string; updatedAt?: string; }
export interface Charge { id: string; tenderId: string; purchaseSheetId?: string; type: string; chargeType?: string; amount: number; chargedAt: string; reference?: string; remarks?: string; description?: string; status?: EntityStatus; createdAt?: string; updatedAt?: string; }
export interface PayOrder { id: string; tenderId: string; purchaseSheetId?: string; companyId?: string; company?: string; orderNumber: string; amount: number; payee: string; issuedAt: string; expiresAt?: string; bank?: string; returnStatus?: EntityStatus; returnDueAt?: string; returnedAt?: string; status?: EntityStatus; remarks?: string; notes?: string; createdAt?: string; updatedAt?: string; }
export interface CreditCommitmentCertificate { id: string; tenderId: string; certificateNumber: string; amount: number; value?: number; issuedAt: string; expiresAt?: string; returnDate?: string; issuingBank?: string; status?: EntityStatus; remarks?: string; notes?: string; createdAt?: string; updatedAt?: string; }
export interface TenderResult { id: string; tenderId: string; outcome: ResultOutcome; announcedAt?: string; resultDate?: string; quotedAmount?: number; rank?: number; awardedCompany?: string; remarks?: string; notes?: string; createdAt?: string; updatedAt?: string; }
export type Result = TenderResult;
export interface NOA { id: string; tenderId: string; noaNumber: string; issuedAt: string; acceptanceDeadline?: string; contractValue?: number; status?: EntityStatus; remarks?: string; notes?: string; createdAt?: string; updatedAt?: string; }
export interface PerformanceSecurity { id: string; tenderId: string; securityNumber: string; amount: number; issuedAt: string; expiresAt: string; returnDate?: string; returnStatus?: EntityStatus; returnRemarks?: string; provider?: string; status?: EntityStatus; remarks?: string; notes?: string; createdAt?: string; updatedAt?: string; }
export interface PayOrderRegisterRecord extends PayOrder { tenderReference: string; company: string; }
export interface PerformanceSecurityRegisterRecord extends PerformanceSecurity { tenderReference: string; company: string; }
export interface ContractAgreement { id: string; tenderId: string; contractNumber: string; signedAt: string; /** Alias used by sign-up workflows; mirrors signedAt when supplied. */ agreementDate?: string; signUpDate?: string; startDate?: string; endDate?: string; contractValue: number; status?: EntityStatus; remarks?: string; notes?: string; createdAt?: string; updatedAt?: string; }
export interface TenderDetails { tender: Tender; charges: Charge[]; totalCharges: number; totalCost: number; payOrders: PayOrder[]; creditCommitmentCertificates: CreditCommitmentCertificate[]; result?: TenderResult; noa?: NOA; performanceSecurity?: PerformanceSecurity; contractAgreement?: ContractAgreement; }
export type DeadlineKind = "closing" | "submission" | "pay-order-return" | "acceptance" | "security-expiry" | "performance-security-return" | "result" | "performance-security" | "contract-agreement" | "credit-commitment-return";
export interface DeadlineItem { label: string; tenderId: string; dueAt: string; urgency: "urgent" | "soon" | "normal"; kind?: DeadlineKind; }
export interface DeadlineSummary { generatedAt: string; items: DeadlineItem[]; totals: { urgent: number; soon: number; normal: number; }; }
export interface PendingWorkItem { tenderId: string; company: string; dueAt?: string; status: "pending"; }
export interface PendingWorkSection { key: string; label: string; count: number; items: PendingWorkItem[]; }
export interface PendingWorkSummary { generatedAt: string; total: number; counts: Record<string, number>; sections: PendingWorkSection[]; }
export interface DashboardSummary extends DeadlineSummary { pendingWork: PendingWorkSummary; }

const isoDateTime = z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), { message: "Expected a valid ISO date/time string" });
const isoDate = z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), { message: "Expected a valid date string" });
const nonNegativeMoney = z.number().finite().nonnegative();
const nonEmpty = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
const optionalDate = isoDateTime.optional();

const optionalMoney = z.preprocess((value) => value === "" || value === null || value === undefined ? undefined : typeof value === "string" ? Number(value) : value, nonNegativeMoney.optional());
const tenderInputFields = { clientId: nonEmpty.optional(), tenderId: nonEmpty, referenceNo: z.preprocess((val) => val === "" ? null : val, z.string().trim().nullable().optional()), company: optionalText, companyId: nonEmpty.optional(), authority: nonEmpty, authorityZone: nonEmpty.optional(), packageName: nonEmpty, closingAt: isoDateTime, submissionAt: optionalDate, tenderValue: optionalMoney, submittedValue: optionalMoney, issueBatchId: nonEmpty.optional(), stage: z.enum(workflowStages), status: z.enum(tenderStatuses) };
export const createTenderSchema = z.object({ ...tenderInputFields, authority: z.preprocess((val) => val === undefined || val === null || (typeof val === "string" && !val.trim()) ? "Unassigned" : val, nonEmpty), stage: z.enum(workflowStages).default("New"), status: z.enum(tenderStatuses).default("Draft") });
export const updateTenderSchema = z.object(tenderInputFields).partial();
const queryDate = z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), { message: "Expected a valid date or date/time string" });
const queryMoney = z.preprocess((value) => typeof value === "string" ? Number(value) : value, z.number().finite().nonnegative().optional());
const tenderResultFilters = z.enum(["Won", "Win", "Lost", "Pending"]);
export const tenderListQuerySchema = z.object({
  q: nonEmpty.optional(),
  tenderId: nonEmpty.optional(),
  referenceNo: nonEmpty.optional(),
  company: nonEmpty.optional(),
  companyId: nonEmpty.optional(),
  authority: nonEmpty.optional(),
  authorityZone: nonEmpty.optional(),
  packageName: nonEmpty.optional(),
  status: z.enum(tenderStatuses).optional(),
  stage: z.enum(workflowStages).optional(),
  closingFrom: queryDate.optional(),
  closingTo: queryDate.optional(),
  closingDateFrom: queryDate.optional(),
  closingDateTo: queryDate.optional(),
  submissionFrom: queryDate.optional(),
  submissionTo: queryDate.optional(),
  submissionDateFrom: queryDate.optional(),
  submissionDateTo: queryDate.optional(),
  result: tenderResultFilters.optional(),
  valueMin: queryMoney,
  valueMax: queryMoney,
  tenderValueMin: queryMoney,
  tenderValueMax: queryMoney,
}).superRefine((value, context) => {
  const closingFrom = value.closingFrom ?? value.closingDateFrom;
  const closingTo = value.closingTo ?? value.closingDateTo;
  const submissionFrom = value.submissionFrom ?? value.submissionDateFrom;
  const submissionTo = value.submissionTo ?? value.submissionDateTo;
  const valueMin = value.valueMin ?? value.tenderValueMin;
  const valueMax = value.valueMax ?? value.tenderValueMax;
  if (closingFrom && closingTo && Date.parse(closingFrom) > Date.parse(closingTo)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["closingTo"], message: "closingTo must be on or after closingFrom" });
  if (submissionFrom && submissionTo && Date.parse(submissionFrom) > Date.parse(submissionTo)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["submissionTo"], message: "submissionTo must be on or after submissionFrom" });
  if (valueMin !== undefined && valueMax !== undefined && valueMin > valueMax) context.addIssue({ code: z.ZodIssueCode.custom, path: ["valueMax"], message: "valueMax must be greater than or equal to valueMin" });
});
export type CreateTenderInput = z.infer<typeof createTenderSchema>;
export type UpdateTenderInput = z.infer<typeof updateTenderSchema>;
export const bulkTenderRowSchema = z.object({
  tenderId: nonEmpty,
  company: optionalText,
  packageName: nonEmpty,
  closingAt: isoDateTime,
  submissionAt: optionalDate,
  tenderValue: optionalMoney,
  submittedValue: optionalMoney,
  stage: z.enum(workflowStages).default("New"),
  status: z.enum(tenderStatuses).default("Draft"),
});
export const bulkTenderCreateSchema = z.object({ rows: z.array(bulkTenderRowSchema).min(1).max(500) });
export type BulkTenderRowInput = z.infer<typeof bulkTenderRowSchema>;
export interface BulkTenderRowError { rowIndex: number; tenderId?: string; errors: string[]; duplicate?: boolean; }
export interface BulkTenderCreateResult { created: Tender[]; errors: BulkTenderRowError[]; total: number; createdCount: number; rejectedCount: number; }
export const companySchema = z.object({ name: nonEmpty, code: optionalText, contact: optionalText, notes: optionalText, archived: z.boolean().optional() });
export const updateCompanySchema = companySchema.partial();
export type CreateCompanyInput = z.infer<typeof companySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export type TenderListQuery = z.infer<typeof tenderListQuerySchema>;

const issueBatchInputFields = { issueDate: isoDateTime, authorityId: nonEmpty, authorityZone: optionalText, authorityName: optionalText, reference: optionalText, notes: optionalText, status: z.enum(issueBatchStatuses) };
export const createIssueBatchSchema = z.object({ ...issueBatchInputFields, status: z.enum(issueBatchStatuses).default("Draft") });
export const updateIssueBatchSchema = z.object(issueBatchInputFields).partial();
export const issueBatchListQuerySchema = z.object({ status: z.enum(issueBatchStatuses).optional() });
export type CreateIssueBatchInput = z.infer<typeof createIssueBatchSchema>;
export type UpdateIssueBatchInput = z.infer<typeof updateIssueBatchSchema>;
export type IssueBatchListQuery = z.infer<typeof issueBatchListQuerySchema>;
export const issueBatchTenderRowSchema = z.object({ tenderId: nonEmpty, packageName: nonEmpty, closingAt: isoDateTime, submissionAt: optionalDate, tenderValue: optionalMoney, submittedValue: optionalMoney, stage: z.enum(workflowStages).default("New"), status: z.enum(tenderStatuses).default("Draft") });
export const createIssueBatchWithTendersSchema = z.object({ ...issueBatchInputFields, status: z.enum(issueBatchStatuses).default("Draft"), rows: z.array(issueBatchTenderRowSchema).min(1, "Provide at least one tender row").max(500, "Provide no more than 500 tender rows") });
export type IssueBatchTenderRowInput = z.infer<typeof issueBatchTenderRowSchema>;
export type CreateIssueBatchWithTendersInput = z.infer<typeof createIssueBatchWithTendersSchema>;

const purchaseSheetLineSchema = z.object({ tenderId: nonEmpty, companyId: nonEmpty.optional() });
const purchaseSheetInputFields = { issueBatchId: nonEmpty, sheetNumber: optionalText, purchasedAt: isoDateTime.optional(), purchaseAmount: nonNegativeMoney.optional(), paymentMethod: optionalText, status: z.enum(purchaseSheetStatuses), viewMode: z.enum(purchaseSheetViewModes), bankEmailTo: optionalText, bankEmailCc: optionalText, bankEmailSubject: optionalText, notes: optionalText, selectedTenderIds: z.array(nonEmpty).min(1, "Select at least one tender line"), lineAssignments: z.array(purchaseSheetLineSchema).optional() };
export const createPurchaseSheetSchema = z.object({ ...purchaseSheetInputFields, status: z.enum(purchaseSheetStatuses).default("Draft"), viewMode: z.enum(purchaseSheetViewModes).default("flat") });
export const updatePurchaseSheetSchema = z.object(purchaseSheetInputFields).partial();
export const purchaseSheetListQuerySchema = z.object({ issueBatchId: nonEmpty.optional(), status: z.enum(purchaseSheetStatuses).optional() });
export type CreatePurchaseSheetInput = z.infer<typeof createPurchaseSheetSchema>;
export type UpdatePurchaseSheetInput = z.infer<typeof updatePurchaseSheetSchema>;
export type PurchaseSheetListQuery = z.infer<typeof purchaseSheetListQuerySchema>;

export const chargeSchema = z.object({ type: nonEmpty, amount: nonNegativeMoney, chargedAt: isoDateTime, purchaseSheetId: nonEmpty.optional(), reference: optionalText, remarks: optionalText, description: optionalText, status: z.enum(entityStatuses).optional() });
export const payOrderSchema = z.object({ orderNumber: nonEmpty, amount: nonNegativeMoney, payee: nonEmpty, issuedAt: isoDateTime, expiresAt: optionalDate, bank: optionalText, returnStatus: z.enum(entityStatuses).optional(), returnDueAt: optionalDate, returnedAt: optionalDate, status: z.enum(entityStatuses).optional(), remarks: optionalText, notes: optionalText, purchaseSheetId: nonEmpty.optional(), companyId: nonEmpty });
export const creditCommitmentCertificateSchema = z.object({ certificateNumber: nonEmpty, amount: nonNegativeMoney, value: nonNegativeMoney.optional(), issuedAt: isoDateTime, expiresAt: optionalDate, returnDate: optionalDate, issuingBank: optionalText, status: z.enum(entityStatuses).optional(), remarks: optionalText, notes: optionalText });
export const tenderResultSchema = z.object({ outcome: z.enum(resultOutcomes), resultDate: optionalDate, announcedAt: optionalDate, quotedAmount: nonNegativeMoney.optional(), rank: z.number().int().positive().optional(), awardedCompany: optionalText, remarks: optionalText, notes: optionalText });
export const noaSchema = z.object({ noaNumber: nonEmpty, issuedAt: isoDateTime, acceptanceDeadline: optionalDate, contractValue: nonNegativeMoney.optional(), status: z.enum(entityStatuses).optional(), remarks: optionalText, notes: optionalText });
export const performanceSecuritySchema = z.object({ securityNumber: nonEmpty, amount: nonNegativeMoney, issuedAt: isoDateTime, expiresAt: isoDateTime, returnDate: optionalDate, returnStatus: z.enum(entityStatuses).optional(), returnRemarks: optionalText, provider: optionalText, status: z.enum(entityStatuses).optional(), remarks: optionalText, notes: optionalText });
const contractAgreementFields = { contractNumber: nonEmpty, signedAt: optionalDate, agreementDate: optionalDate, signUpDate: optionalDate, startDate: optionalDate, endDate: optionalDate, contractValue: nonNegativeMoney, status: z.enum(entityStatuses).optional(), remarks: optionalText, notes: optionalText };
export const contractAgreementSchema = z.object(contractAgreementFields).refine((value) => Boolean(value.signedAt || value.agreementDate || value.signUpDate), { message: "signedAt, agreementDate, or signUpDate is required", path: ["signedAt"] });
export type ChargeInput = z.infer<typeof chargeSchema>;
export type PayOrderInput = z.infer<typeof payOrderSchema>;
export type CreditCommitmentCertificateInput = z.infer<typeof creditCommitmentCertificateSchema>;
export type TenderResultInput = z.infer<typeof tenderResultSchema>;
export type NOAInput = z.infer<typeof noaSchema>;
export type PerformanceSecurityInput = z.infer<typeof performanceSecuritySchema>;
export type ContractAgreementInput = z.infer<typeof contractAgreementSchema>;


export interface Authority { id: string; name: string; zone?: string; contact?: string; referenceNotes?: string; etenderPortal?: string; etenderReference?: string; etenderNotes?: string; createdAt?: string; updatedAt?: string; }
export interface DocumentMetadata { id: string; tenderId?: string; authorityId?: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string; }
