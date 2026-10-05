import type { Authority, DocumentMetadata, BankProfile, BulkTenderCreateResult, Charge, Company, CompanySecuritySummary, ContractAgreement, CreditCommitmentCertificate, DashboardSummary, DeadlineSummary, EmailTemplate, IssueBatch, IssueBatchWithTendersResult, NOA, PayOrder, PayOrderRegisterRecord, PerformanceSecurity, PerformanceSecurityRegisterRecord, PurchaseSheet, Tender, TenderDetails, TenderListQuery, TenderResult } from "../shared/domain";

export class ApiError extends Error { constructor(message: string, public readonly status: number) { super(message); this.name = "ApiError"; } }
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const sessionToken = typeof window !== "undefined" ? window.sessionStorage.getItem("tender-tracker-session") : null;
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(sessionToken ? { "x-session-token": sessionToken } : {}), ...(options?.headers ?? {}) } });
  if (!response.ok) { let message = `Request failed (${response.status})`; try { const body = (await response.json()) as { error?: string }; if (body.error) message = body.error; } catch { /* status message */ } throw new ApiError(message, response.status); }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
async function requestBlob(path: string): Promise<Blob> {
  const sessionToken = typeof window !== "undefined" ? window.sessionStorage.getItem("tender-tracker-session") : null;
  const response = await fetch(path, { headers: sessionToken ? { "x-session-token": sessionToken } : undefined });
  if (!response.ok) throw new ApiError(`Download failed (${response.status})`, response.status);
  return response.blob();
}
const send = <T>(path: string, method: string, payload?: Record<string, unknown>) => request<T>(path, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) });
export function listTenders(query: string | TenderListQuery = "") {
  const params = new URLSearchParams();
  if (typeof query === "string") {
    if (query.trim()) params.set("q", query.trim());
  } else {
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return request<Tender[]>(`/api/tenders${search ? `?${search}` : ""}`);
}
export function getDeadlineSummary() { return request<DeadlineSummary>("/api/deadlines/summary"); }
export function createTender(payload: Record<string, unknown>) { return send<Tender>("/api/tenders", "POST", payload); }
export function createBulkTenders(issueBatchId: string, rows: Array<Record<string, unknown>>) { return send<BulkTenderCreateResult>(`/api/issue-batches/${encodeURIComponent(issueBatchId)}/tenders/bulk`, "POST", { rows }); }
export function updateTender(id: string, payload: Record<string, unknown>) { return send<Tender>(`/api/tenders/${encodeURIComponent(id)}`, "PATCH", payload); }
export function deleteTender(id: string) { return request<void>(`/api/tenders/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function listIssueBatches() { return request<IssueBatch[]>("/api/issue-batches"); }
export function createIssueBatch(payload: Record<string, unknown>) { return send<IssueBatch>("/api/issue-batches", "POST", payload); }
export function createIssueBatchWithTenders(payload: Record<string, unknown>) { return send<IssueBatchWithTendersResult>("/api/issue-batches/with-tenders", "POST", payload); }
export function updateIssueBatch(id: string, payload: Record<string, unknown>) { return send<IssueBatch>(`/api/issue-batches/${encodeURIComponent(id)}`, "PATCH", payload); }
export function deleteIssueBatch(id: string) { return request<void>(`/api/issue-batches/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function listPurchaseSheets(issueBatchId?: string) { const query = issueBatchId ? `?issueBatchId=${encodeURIComponent(issueBatchId)}` : ""; return request<PurchaseSheet[]>(`/api/purchase-sheets${query}`); }
export function createPurchaseSheet(payload: Record<string, unknown>) { return send<PurchaseSheet>("/api/purchase-sheets", "POST", payload); }
export function updatePurchaseSheet(id: string, payload: Record<string, unknown>) { return send<PurchaseSheet>(`/api/purchase-sheets/${encodeURIComponent(id)}`, "PATCH", payload); }
export function deletePurchaseSheet(id: string) { return request<void>(`/api/purchase-sheets/${encodeURIComponent(id)}`, { method: "DELETE" }); }

export function getTenderDetails(id: string) { return request<TenderDetails>(`/api/tenders/${encodeURIComponent(id)}/details`); }
export function getTenderLifecycleCache() { return request<Array<{ tenderId: string; result?: TenderResult }>>("/api/tender-lifecycle"); }
export function createCharge(id: string, payload: Record<string, unknown>) { return send<Charge>(`/api/tenders/${encodeURIComponent(id)}/charges`, "POST", payload); }
export function createPayOrder(id: string, payload: Record<string, unknown>) { return send<PayOrder>(`/api/tenders/${encodeURIComponent(id)}/pay-orders`, "POST", payload); }
export function listPayOrders() { return request<PayOrderRegisterRecord[]>("/api/pay-orders"); }
export function updatePayOrder(tenderId: string, orderId: string, payload: Record<string, unknown>) { return send<PayOrder>(`/api/tenders/${encodeURIComponent(tenderId)}/pay-orders/${encodeURIComponent(orderId)}`, "PATCH", payload); }
export function createCertificate(id: string, payload: Record<string, unknown>) { return send<CreditCommitmentCertificate>(`/api/tenders/${encodeURIComponent(id)}/credit-commitment-certificates`, "POST", payload); }
export function updateTenderResult(id: string, payload: Record<string, unknown>) { return send<TenderResult>(`/api/tenders/${encodeURIComponent(id)}/result`, "PUT", payload); }
export function updateTenderNoa(id: string, payload: Record<string, unknown>) { return send<NOA>(`/api/tenders/${encodeURIComponent(id)}/noa`, "PUT", payload); }
export function updatePerformanceSecurity(id: string, payload: Record<string, unknown>) { return send<PerformanceSecurity>(`/api/tenders/${encodeURIComponent(id)}/performance-security`, "PUT", payload); }
export function listPerformanceSecurities() { return request<PerformanceSecurityRegisterRecord[]>("/api/performance-securities"); }
export function updateContractAgreement(id: string, payload: Record<string, unknown>) { return send<ContractAgreement>(`/api/tenders/${encodeURIComponent(id)}/contract-agreement`, "PUT", payload); }
export function editContractAgreement(tenderId: string, agreementId: string, payload: Record<string, unknown>) { return send<ContractAgreement>(`/api/tenders/${encodeURIComponent(tenderId)}/contract-agreement/${encodeURIComponent(agreementId)}`, "PATCH", payload); }
export function getDashboardSummary() { return request<DashboardSummary>("/api/dashboard/summary"); }
export function getPendingWorkSummary() { return request<DashboardSummary["pendingWork"]>("/api/dashboard/pending-work"); }

export type DuplicateDecision = "keep-old" | "replace" | "keep-both" | "skip";
export interface ImportPreviewRow { rowIndex: number; tender: Partial<Tender>; valid: boolean; errors: string[]; duplicateOf?: Tender; duplicateRow?: number; }
export interface ImportPreview { filename?: string; rows: ImportPreviewRow[]; duplicates: ImportPreviewRow[]; validCount: number; invalidCount: number; }
export function previewImport(payload: { filename: string; data: string }) { return send<ImportPreview>("/api/import/preview", "POST", payload as Record<string, unknown>); }
export function commitImport(preview: ImportPreview, decisions: Record<string, DuplicateDecision>) { return send<{ imported: Tender[]; updated: Tender[]; skipped: number[]; errors: Array<{ rowIndex: number; error: string }>; total: number }>("/api/import/commit", "POST", { preview, decisions }); }
export interface ReportData { title: string; columns: string[]; rows: Array<Record<string, unknown>>; }
export function getReport(type: string) { return request<ReportData>(`/api/reports/${encodeURIComponent(type)}`); }
export function getReportCsv(type: string, filters: Record<string, string | number | undefined> = {}) { const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)])); return requestBlob(`/api/reports/${encodeURIComponent(type)}.csv${query.toString() ? `?${query}` : ""}`); }
export function getReportPdf(type: string, filters: Record<string, string | number | undefined> = {}) { const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)])); return requestBlob(`/api/reports/${encodeURIComponent(type)}.pdf${query.toString() ? `?${query}` : ""}`); }

export interface BackupSnapshot { format: "tender-tracker-backup"; version: 1; exportedAt: string; tables: Record<string, Array<Record<string, unknown>>>; }
export async function downloadBackup(): Promise<Blob> {
  const response = await fetch("/api/backup/export");
  if (!response.ok) throw new ApiError(`Backup failed (${response.status})`, response.status);
  return response.blob();
}
export function restoreBackup(snapshot: BackupSnapshot) { return send<{ ok: true; restoredAt: string; tables: Record<string, number> }>("/api/backup/restore", "POST", snapshot as unknown as Record<string, unknown>); }

export interface SecurityStatus { configured: boolean; unlocked: boolean; recoveryEmail?: string; recoveryResetRequestedAt?: string; recoveryResetRequestId?: string; sessionExpiresAt?: string; }
export interface SecuritySession { token: string; status: SecurityStatus; }
export interface CompanyCredentials { companyId: string; companyName: string; username: string; password: string; }
export function getSecurityStatus() { return request<SecurityStatus>("/api/security/status"); }
export function setupMasterPassword(password: string, recoveryEmail?: string) { return send<SecuritySession>("/api/security/setup", "POST", { password, recoveryEmail }); }
export function unlockMasterPassword(password: string) { return send<SecuritySession>("/api/security/unlock", "POST", { password }); }
export function lockMasterPassword() { return request<{ ok: true }>("/api/security/lock", { method: "POST" }); }
export function changeMasterPassword(currentPassword: string, password: string) { return send<{ status: SecurityStatus }>("/api/security/master-password", "POST", { currentPassword, password }); }
export function updateRecoveryEmail(recoveryEmail: string) { return send<{ status: SecurityStatus }>("/api/security/recovery", "PUT", { recoveryEmail }); }
export function requestRecovery(recoveryEmail: string) { return send<{ requested: boolean; configured: boolean; requestedAt?: string; requestId?: string; emailConfigured: boolean }>("/api/security/recovery/request", "POST", { recoveryEmail }); }
export function listCompanySecurity() { return request<Array<Company & CompanySecuritySummary>>("/api/companies"); }
export function createCompany(payload: Record<string, unknown>) { return send<Company & CompanySecuritySummary>("/api/companies", "POST", payload); }
export function updateCompany(id: string, payload: Record<string, unknown>) { return send<Company & CompanySecuritySummary>(`/api/companies/${encodeURIComponent(id)}`, "PATCH", payload); }
export function archiveCompany(id: string, archived: boolean) { return send<Company>(`/api/companies/${encodeURIComponent(id)}/archive`, "POST", { archived }); }
export function deleteCompany(id: string) { return request<void>(`/api/companies/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function getCompanyCredentials(companyId: string) { return request<CompanyCredentials>(`/api/companies/${encodeURIComponent(companyId)}/credentials`); }
export function saveCompanyCredentials(companyId: string, username: string, password: string) { return send<CompanySecuritySummary>(`/api/companies/${encodeURIComponent(companyId)}/credentials`, "PUT", { username, password }); }
export function clearCompanyCredentials(companyId: string) { return request<void>(`/api/companies/${encodeURIComponent(companyId)}/credentials`, { method: "DELETE" }); }
export function getBankProfile() { return request<BankProfile | null>("/api/bank-profile"); }
export function saveBankProfile(payload: Record<string, unknown>) { return send<BankProfile>("/api/bank-profile", "PUT", payload); }
export function listEmailTemplates() { return request<EmailTemplate[]>("/api/email-templates"); }
export function createEmailTemplate(payload: Record<string, unknown>) { return send<EmailTemplate>("/api/email-templates", "POST", payload); }
export function updateEmailTemplate(id: string, payload: Record<string, unknown>) { return send<EmailTemplate>(`/api/email-templates/${encodeURIComponent(id)}`, "PATCH", payload); }
export function deleteEmailTemplate(id: string) { return request<void>(`/api/email-templates/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function selectEmailTemplate(id: string) { return send<EmailTemplate>(`/api/email-templates/${encodeURIComponent(id)}/select`, "PUT"); }


export function listAuthorities() { return request<Authority[]>("/api/authorities"); }
export function createAuthority(payload: Record<string, unknown>) { return send<Authority>("/api/authorities", "POST", payload); }
export function updateAuthority(id: string, payload: Record<string, unknown>) { return send<Authority>(`/api/authorities/${encodeURIComponent(id)}`, "PATCH", payload); }
export function deleteAuthority(id: string) { return request<void>(`/api/authorities/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function listDocuments(target: { tenderId?: string; authorityId?: string }) { const query = new URLSearchParams(target as Record<string, string>).toString(); return request<DocumentMetadata[]>(`/api/documents?${query}`); }
export function uploadDocument(payload: Record<string, unknown>) { return send<DocumentMetadata>("/api/documents", "POST", payload); }
export function deleteDocument(id: string) { return request<void>(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function downloadDocument(id: string) { return requestBlob(`/api/documents/${encodeURIComponent(id)}/download`); }
export function createAutomaticBackup() { return send<{ path: string; fileName: string; exportedAt: string }>("/api/backup/now", "POST"); }
export function getAutomaticBackupStatus() { return request<{ directory: string; retention: number; files: string[]; latest?: string }>("/api/backup/automatic"); }
export function downloadAutomaticBackup(fileName: string) { return requestBlob(`/api/backup/automatic/${encodeURIComponent(fileName)}`); }
