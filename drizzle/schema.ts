import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code"),
  contact: text("contact"),
  notes: text("notes"),
  archivedAt: text("archived_at"),
  tenderUsername: text("tender_username"),
  tenderUsernameCiphertext: text("tender_username_ciphertext"),
  tenderPasswordCiphertext: text("tender_password_ciphertext"),
  ...timestamps,
});

export const appSecurity = sqliteTable("app_security", {
  id: integer("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  recoveryEmail: text("recovery_email"),
  recoveryResetRequestedAt: text("recovery_reset_requested_at"),
  recoveryResetRequestId: text("recovery_reset_request_id"),
  ...timestamps,
});

export const bankProfiles = sqliteTable("bank_profiles", {
  id: integer("id").primaryKey(),
  accountName: text("account_name").notNull(),
  accountNumberCiphertext: text("account_number_ciphertext").notNull(),
  branch: text("branch").notNull(),
  ...timestamps,
});

export const emailTemplates = sqliteTable("email_templates", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  companyId: text("company_id").references(() => companies.id, { onDelete: "set null" }),
  emailTo: text("email_to").notNull(),
  emailCc: text("email_cc"),
  subject: text("subject").notNull(),
  selected: integer("selected").notNull().default(0),
  ...timestamps,
});

export const issueBatches = sqliteTable("issue_batches", {
  id: text("id").primaryKey(),
  companyId: text("company_id").references(() => companies.id),
  authorityId: text("authority_id").references(() => authorities.id, { onDelete: "set null" }),
  issueDate: text("issue_date").notNull(),
  authorityZone: text("authority_zone").notNull(),
  reference: text("reference"),
  notes: text("notes"),
  status: text("status").notNull(),
  ...timestamps,
});

export const tenders = sqliteTable("tenders", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull(),
  referenceNo: text("reference_no"),
  companyId: text("company_id").references(() => companies.id),
  issueBatchId: text("issue_batch_id").references(() => issueBatches.id),
  authority: text("authority").notNull(),
  authorityZone: text("authority_zone"),
  packageName: text("package_name").notNull(),
  closingAt: text("closing_at").notNull(),
  submissionAt: text("submission_at"),
  tenderValue: integer("tender_value"),
  submittedValue: integer("submitted_value"),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  ...timestamps,
});

export const tenderSubmissions = sqliteTable("tender_submissions", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }),
  submittedAt: text("submitted_at").notNull(),
  submittedValue: integer("submitted_value").notNull(),
  submissionReference: text("submission_reference"),
  status: text("status").notNull(),
  notes: text("notes"),
  ...timestamps,
});

export const purchaseSheets = sqliteTable("purchase_sheets", {
  id: text("id").primaryKey(),
  issueBatchId: text("issue_batch_id").notNull().references(() => issueBatches.id, { onDelete: "cascade" }),
  sheetNumber: text("sheet_number"),
  purchasedAt: text("purchased_at"),
  purchaseAmount: integer("purchase_amount"),
  paymentMethod: text("payment_method"),
  status: text("status").notNull(),
  viewMode: text("view_mode").notNull(),
  bankEmailTo: text("bank_email_to"),
  bankEmailCc: text("bank_email_cc"),
  bankEmailSubject: text("bank_email_subject"),
  notes: text("notes"),
  ...timestamps,
});

export const purchaseSheetLines = sqliteTable("purchase_sheet_lines", {
  id: text("id").primaryKey(),
  purchaseSheetId: text("purchase_sheet_id").notNull().references(() => purchaseSheets.id, { onDelete: "cascade" }),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }),
  companyId: text("company_id").references(() => companies.id, { onDelete: "set null" }),
  lineOrder: integer("line_order").notNull(),
});

export const charges = sqliteTable("charges", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }),
  purchaseSheetId: text("purchase_sheet_id").references(() => purchaseSheets.id),
  type: text("type").notNull(),
  amount: integer("amount").notNull(),
  chargedAt: text("charged_at").notNull(),
  reference: text("reference"),
  remarks: text("remarks"),
  description: text("description"),
  status: text("status").notNull(),
  ...timestamps,
});

export const payOrders = sqliteTable("pay_orders", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }),
  purchaseSheetId: text("purchase_sheet_id").references(() => purchaseSheets.id),
  companyId: text("company_id").references(() => companies.id, { onDelete: "set null" }),
  orderNumber: text("order_number").notNull(),
  amount: integer("amount").notNull(),
  payee: text("payee").notNull().default(""),
  issuedAt: text("issued_at").notNull(),
  expiresAt: text("expires_at"),
  bank: text("bank"),
  returnStatus: text("return_status"),
  returnDueAt: text("return_due_at"),
  returnedAt: text("returned_at"),
  status: text("status").notNull(),
  remarks: text("remarks"),
  notes: text("notes"),
  ...timestamps,
});

export const creditCommitmentCertificates = sqliteTable("credit_commitment_certificates", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }),
  certificateNumber: text("certificate_number").notNull(),
  amount: integer("amount").notNull(),
  value: integer("value"),
  issuedAt: text("issued_at").notNull(),
  expiresAt: text("expires_at"),
  returnDate: text("return_date"),
  issuingBank: text("issuing_bank"),
  status: text("status").notNull(),
  remarks: text("remarks"),
  notes: text("notes"),
  ...timestamps,
});

export const results = sqliteTable("results", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }).unique(),
  outcome: text("outcome").notNull(),
  announcedAt: text("announced_at"),
  resultDate: text("result_date"),
  quotedAmount: integer("quoted_amount"),
  rank: integer("rank"),
  awardedCompany: text("awarded_company"),
  remarks: text("remarks"),
  notes: text("notes"),
  ...timestamps,
});
export const tenderResults = results;

export const noa = sqliteTable("noa", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }).unique(),
  noaNumber: text("noa_number").notNull(),
  issuedAt: text("issued_at").notNull(),
  acceptanceDeadline: text("acceptance_deadline"),
  contractValue: integer("contract_value"),
  status: text("status").notNull(),
  remarks: text("remarks"),
  notes: text("notes"),
  ...timestamps,
});
export const noas = noa;
export const noticesOfAward = noa;

export const performanceSecurities = sqliteTable("performance_securities", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }).unique(),
  securityNumber: text("security_number").notNull(),
  amount: integer("amount").notNull(),
  issuedAt: text("issued_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  returnDate: text("return_date"),
  returnStatus: text("return_status"),
  returnRemarks: text("return_remarks"),
  provider: text("provider"),
  status: text("status").notNull(),
  remarks: text("remarks"),
  notes: text("notes"),
  ...timestamps,
});

export const contractAgreements = sqliteTable("contract_agreements", {
  id: text("id").primaryKey(),
  tenderId: text("tender_id").notNull().references(() => tenders.id, { onDelete: "cascade" }).unique(),
  contractNumber: text("contract_number").notNull(),
  signedAt: text("signed_at").notNull(),
  startDate: text("start_date"),
  endDate: text("end_date"),
  contractValue: integer("contract_value").notNull(),
  status: text("status").notNull(),
  remarks: text("remarks"),
  notes: text("notes"),
  ...timestamps,
});


export const authorities = sqliteTable("authorities", {
  id: text("id").primaryKey(), name: text("name").notNull(), zone: text("zone"), contact: text("contact"), referenceNotes: text("reference_notes"), etenderPortal: text("etender_portal"), etenderReference: text("etender_reference"), etenderNotes: text("etender_notes"), ...timestamps,
});
export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(), tenderId: text("tender_id").references(() => tenders.id, { onDelete: "cascade" }), authorityId: text("authority_id").references(() => authorities.id, { onDelete: "cascade" }), fileName: text("file_name").notNull(), storageName: text("storage_name").notNull(), mimeType: text("mime_type").notNull(), sizeBytes: integer("size_bytes").notNull(), sha256: text("sha256").notNull(), createdAt: text("created_at").notNull(),
});
