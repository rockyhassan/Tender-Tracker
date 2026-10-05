-- =============================================================================
-- Tender Tracker — Supabase PostgreSQL Foundation Schema
-- 
-- Preserves all 18 tables, relationships, data types, indexes, and safety guards:
-- - A-1: Tender deletion protection (relations and parent-child constraints)
-- - A-2: Case-insensitive company deduplication index (LOWER(name))
-- - A-3: UNIQUE(tender_id) constraints on results, noa, performance_securities, contract_agreements
-- - A-4: Purchase sheet tender assignment protection (UNIQUE(purchase_sheet_id, tender_id))
-- =============================================================================

-- 1. companies
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  contact TEXT,
  notes TEXT,
  archived_at TIMESTAMPTZ,
  tender_username TEXT,
  tender_username_ciphertext TEXT,
  tender_password_ciphertext TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Safety A-2: Case-insensitive company uniqueness/deduplication index
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_lower_idx ON companies (LOWER(name));

-- 2. app_security (Singleton table)
CREATE TABLE IF NOT EXISTS app_security (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  recovery_email TEXT,
  recovery_reset_requested_at TIMESTAMPTZ,
  recovery_reset_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. bank_profiles (Singleton table)
CREATE TABLE IF NOT EXISTS bank_profiles (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_name TEXT NOT NULL,
  account_number_ciphertext TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. email_templates
CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('purchase-sheet-bank', 'company-noa')),
  name TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  email_to TEXT NOT NULL,
  email_cc TEXT,
  subject TEXT NOT NULL,
  selected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS email_templates_type_company_idx ON email_templates(type, company_id);

-- 5. authorities
CREATE TABLE IF NOT EXISTS authorities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone TEXT,
  contact TEXT,
  reference_notes TEXT,
  etender_portal TEXT,
  etender_reference TEXT,
  etender_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS authorities_name_idx ON authorities(name);
CREATE INDEX IF NOT EXISTS authorities_name_lower_idx ON authorities(LOWER(name));

-- 6. issue_batches
CREATE TABLE IF NOT EXISTS issue_batches (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  authority_id TEXT REFERENCES authorities(id) ON DELETE SET NULL,
  issue_date TIMESTAMPTZ NOT NULL,
  authority_zone TEXT NOT NULL,
  reference TEXT,
  notes TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS issue_batches_issue_date_idx ON issue_batches(issue_date);
CREATE INDEX IF NOT EXISTS issue_batches_authority_id_idx ON issue_batches(authority_id);
CREATE INDEX IF NOT EXISTS issue_batches_company_id_idx ON issue_batches(company_id);

-- 7. tenders
CREATE TABLE IF NOT EXISTS tenders (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id),
  issue_batch_id TEXT REFERENCES issue_batches(id),
  authority TEXT NOT NULL,
  authority_zone TEXT,
  package_name TEXT NOT NULL,
  closing_at TIMESTAMPTZ NOT NULL,
  submission_at TIMESTAMPTZ,
  tender_value BIGINT,
  submitted_value BIGINT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS tenders_company_id_idx ON tenders(company_id);
CREATE INDEX IF NOT EXISTS tenders_status_idx ON tenders(status);
CREATE INDEX IF NOT EXISTS tenders_stage_idx ON tenders(stage);
CREATE INDEX IF NOT EXISTS tenders_closing_at_idx ON tenders(closing_at);
CREATE INDEX IF NOT EXISTS tenders_issue_batch_id_idx ON tenders(issue_batch_id);
CREATE INDEX IF NOT EXISTS tenders_tender_id_idx ON tenders(tender_id);

-- 8. documents (polymorphic attachment)
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tender_id TEXT REFERENCES tenders(id) ON DELETE CASCADE,
  authority_id TEXT REFERENCES authorities(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((tender_id IS NOT NULL AND authority_id IS NULL) OR (tender_id IS NULL AND authority_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS documents_tender_id_idx ON documents(tender_id);
CREATE INDEX IF NOT EXISTS documents_authority_id_idx ON documents(authority_id);

-- 9. tender_submissions
CREATE TABLE IF NOT EXISTS tender_submissions (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  submitted_at TIMESTAMPTZ NOT NULL,
  submitted_value BIGINT NOT NULL,
  submission_reference TEXT,
  status TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS tender_submissions_tender_id_idx ON tender_submissions(tender_id);

-- 10. purchase_sheets
CREATE TABLE IF NOT EXISTS purchase_sheets (
  id TEXT PRIMARY KEY,
  issue_batch_id TEXT NOT NULL REFERENCES issue_batches(id) ON DELETE CASCADE,
  sheet_number TEXT,
  purchased_at TIMESTAMPTZ,
  purchase_amount BIGINT,
  payment_method TEXT,
  status TEXT NOT NULL,
  view_mode TEXT NOT NULL,
  bank_email_to TEXT,
  bank_email_cc TEXT,
  bank_email_subject TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS purchase_sheets_issue_batch_id_idx ON purchase_sheets(issue_batch_id);
CREATE INDEX IF NOT EXISTS purchase_sheets_status_idx ON purchase_sheets(status);

-- 11. purchase_sheet_lines
-- Safety A-4: purchase-sheet tender assignment protection
CREATE TABLE IF NOT EXISTS purchase_sheet_lines (
  id TEXT PRIMARY KEY,
  purchase_sheet_id TEXT NOT NULL REFERENCES purchase_sheets(id) ON DELETE CASCADE,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  line_order INTEGER NOT NULL,
  CONSTRAINT purchase_sheet_lines_sheet_tender_unique UNIQUE (purchase_sheet_id, tender_id)
);
CREATE INDEX IF NOT EXISTS purchase_sheet_lines_sheet_id_idx ON purchase_sheet_lines(purchase_sheet_id);
CREATE INDEX IF NOT EXISTS purchase_sheet_lines_tender_id_idx ON purchase_sheet_lines(tender_id);

-- 12. charges
CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  purchase_sheet_id TEXT REFERENCES purchase_sheets(id),
  type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  charged_at TIMESTAMPTZ NOT NULL,
  reference TEXT,
  remarks TEXT,
  description TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS charges_tender_id_idx ON charges(tender_id);
CREATE INDEX IF NOT EXISTS charges_purchase_sheet_id_idx ON charges(purchase_sheet_id);

-- 13. pay_orders
CREATE TABLE IF NOT EXISTS pay_orders (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  purchase_sheet_id TEXT REFERENCES purchase_sheets(id),
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  amount BIGINT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  bank TEXT,
  return_status TEXT,
  return_due_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  remarks TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS pay_orders_tender_id_idx ON pay_orders(tender_id);
CREATE INDEX IF NOT EXISTS pay_orders_purchase_sheet_id_idx ON pay_orders(purchase_sheet_id);
CREATE INDEX IF NOT EXISTS pay_orders_company_id_idx ON pay_orders(company_id);

-- 14. credit_commitment_certificates
CREATE TABLE IF NOT EXISTS credit_commitment_certificates (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  certificate_number TEXT NOT NULL,
  amount BIGINT NOT NULL,
  value BIGINT,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  return_date TIMESTAMPTZ,
  issuing_bank TEXT,
  status TEXT NOT NULL,
  remarks TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS credit_commitment_certificates_tender_id_idx ON credit_commitment_certificates(tender_id);

-- 15. results
-- Safety A-3: UNIQUE(tender_id) on results
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  announced_at TIMESTAMPTZ,
  result_date TIMESTAMPTZ,
  quoted_amount BIGINT,
  rank INTEGER,
  awarded_company TEXT,
  remarks TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT results_tender_id_unique UNIQUE (tender_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS results_tender_id_idx ON results(tender_id);

-- 16. noa
-- Safety A-3: UNIQUE(tender_id) on noa
CREATE TABLE IF NOT EXISTS noa (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  noa_number TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  acceptance_deadline TIMESTAMPTZ,
  contract_value BIGINT,
  status TEXT NOT NULL,
  remarks TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT noa_tender_id_unique UNIQUE (tender_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS noa_tender_id_idx ON noa(tender_id);

-- 17. performance_securities
-- Safety A-3: UNIQUE(tender_id) on performance_securities
CREATE TABLE IF NOT EXISTS performance_securities (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  security_number TEXT NOT NULL,
  amount BIGINT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  return_date TIMESTAMPTZ,
  return_status TEXT,
  return_remarks TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  remarks TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT performance_securities_tender_id_unique UNIQUE (tender_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS performance_securities_tender_id_idx ON performance_securities(tender_id);

-- 18. contract_agreements
-- Safety A-3: UNIQUE(tender_id) on contract_agreements
CREATE TABLE IF NOT EXISTS contract_agreements (
  id TEXT PRIMARY KEY,
  tender_id TEXT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  contract_number TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  contract_value BIGINT NOT NULL,
  status TEXT NOT NULL,
  remarks TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT contract_agreements_tender_id_unique UNIQUE (tender_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS contract_agreements_tender_id_idx ON contract_agreements(tender_id);
