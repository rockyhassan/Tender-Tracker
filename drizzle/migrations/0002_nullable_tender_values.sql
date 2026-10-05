-- Tender values are unknown at initial intake; preserve NULL rather than coercing to 0.
PRAGMA foreign_keys = OFF;
BEGIN;
ALTER TABLE tenders RENAME TO tenders_legacy_nullable_values;
CREATE TABLE tenders (
  id TEXT PRIMARY KEY, tender_id TEXT NOT NULL, company_id TEXT NOT NULL REFERENCES companies(id),
  issue_batch_id TEXT REFERENCES issue_batches(id), authority TEXT NOT NULL, authority_zone TEXT, package_name TEXT NOT NULL,
  closing_at TEXT NOT NULL, submission_at TEXT, tender_value INTEGER, submitted_value INTEGER,
  stage TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO tenders (id,tender_id,company_id,issue_batch_id,authority,authority_zone,package_name,closing_at,submission_at,tender_value,submitted_value,stage,status,created_at,updated_at)
SELECT id,tender_id,company_id,issue_batch_id,authority,authority_zone,package_name,closing_at,submission_at,tender_value,submitted_value,stage,status,created_at,updated_at FROM tenders_legacy_nullable_values;
DROP TABLE tenders_legacy_nullable_values;
CREATE INDEX IF NOT EXISTS tenders_company_id_idx ON tenders(company_id);
CREATE INDEX IF NOT EXISTS tenders_status_idx ON tenders(status);
CREATE INDEX IF NOT EXISTS tenders_stage_idx ON tenders(stage);
CREATE INDEX IF NOT EXISTS tenders_closing_at_idx ON tenders(closing_at);
COMMIT;
PRAGMA foreign_keys = ON;
