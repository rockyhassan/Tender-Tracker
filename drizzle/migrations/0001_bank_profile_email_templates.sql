CREATE TABLE IF NOT EXISTS bank_profiles (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_name TEXT NOT NULL,
  account_number_ciphertext TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('purchase-sheet-bank', 'company-noa')),
  name TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  email_to TEXT NOT NULL,
  email_cc TEXT,
  subject TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS email_templates_type_company_idx ON email_templates(type, company_id);
