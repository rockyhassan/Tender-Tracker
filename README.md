# Tender Tracker

Tender Tracker is an English-language, offline-first PWA for managing the full tender lifecycle in exact BDT. The repository contains a runnable React dashboard shell plus the first normalized lifecycle/API slice.

## Run locally

```bash
pnpm install
pnpm dev
```

The client runs on Vite's default port. Start the local API separately with `pnpm server` (default `8787`). It binds to `0.0.0.0` for local/mobile testing and persists data in `data/tender-tracker.sqlite`.

The server uses Node 22's built-in `node:sqlite` driver, so no database service or native dependency is required. The database and all lifecycle tables are initialized automatically from the SQL shape represented by [`drizzle/schema.ts`](./drizzle/schema.ts). Set `TENDER_DB_PATH` to use another file (or `:memory:` for an isolated process).

To load the idempotent demo tender and default company profiles on a new/empty database, run:

```bash
TENDER_DB_SEED=1 pnpm server
# equivalent
pnpm server:seed
```

Seeding adds these company profiles exactly once: **Semu Enterprise**, **Kashfia Jerin Enterprise**, and **Weply**. It uses stable IDs and case-insensitive name checks, so rerunning `server:seed` does not duplicate profiles or overwrite an owner edit. It also never overwrites existing tenders. Remove `data/tender-tracker.sqlite` to start over; its SQLite sidecar files are ignored by git.

## Lifecycle foundation

`shared/domain.ts` and `drizzle/schema.ts` now cover:

- companies and issue batches;
- tenders and tender submissions;
- purchase sheets, charges, pay orders, and credit commitment certificates;
- results, notices of award (NOA), performance securities, and contract agreements.

The server uses typed SQLite repository/service boundaries. Tender and lifecycle writes are validated with zod before normalization and storage; the detail route calculates tender-wise bank-charge total cost.

### API routes

- `GET /api/health`
- `GET /api/tenders` (supports `q`, `companyId`, `status`, and `stage` filters)
- `POST /api/tenders`
- `GET /api/tenders/:id`
- `PATCH /api/tenders/:id`
- `DELETE /api/tenders/:id`
- `GET /api/deadlines/summary`
- `GET /api/tenders/:id/details` (tender, charges, calculated `totalCost`, Pay Orders, certificates, result, NOA, and performance security)
- `POST/PATCH/DELETE /api/tenders/:id/charges/:chargeId?`
- `POST/PATCH/DELETE /api/tenders/:id/pay-orders/:orderId?`
- `POST/PATCH/DELETE /api/tenders/:id/credit-commitment-certificates/:certificateId?`
- `PUT /api/tenders/:id/result`, `PUT /api/tenders/:id/noa`, `PUT /api/tenders/:id/performance-security`

Example create payload:

```json
{
  "tenderId": "e-GP/2026/114",
  "company": "Delta Infrastructure Ltd.",
  "authority": "LGED · Dhaka",
  "packageName": "Road rehabilitation package 04",
  "closingAt": "2026-10-04T08:00:00.000Z",
  "tenderValue": 8420000,
  "stage": "New",
  "status": "Active"
}
```

## Validate

```bash
pnpm check
pnpm build
pnpm smoke
```

See [`plan.md`](./plan.md) for the approved product direction and [`TODO.md`](./TODO.md) for the remaining delivery outcomes.


## Authority profiles, attachments, and local backups

The **Authorities** module stores authority name, zone, contact/reference notes, and optional e-Tender portal/reference metadata. Authorities and tenders can each have local document attachments through the UI or these API routes:

- `GET/POST /api/authorities`, `GET/PATCH/DELETE /api/authorities/:id`
- `GET /api/documents?tenderId=...` or `?authorityId=...`
- `POST /api/documents` with `{ fileName, mimeType, data: "data:<mime>;base64,...", tenderId | authorityId }`
- `GET /api/documents/:id/download`, `DELETE /api/documents/:id`

Uploads are stored under a random generated filename (never a user path), with `0600` permissions and metadata in SQLite. The allowlist includes PDF, text/CSV, common image, ZIP, DOCX, XLSX, and PPTX files; the maximum upload size is **10 MiB**. Exactly one tender or authority target is required.

### Automatic local backup configuration

On server startup and when the calendar day changes, the server writes a validated JSON data snapshot to the local backup directory. It writes atomically, uses restrictive file permissions, and removes files beyond the retention count. The Settings **Backup Now** action also writes a retained snapshot and downloads the existing portable export. Configure before starting the server:

```bash
TENDER_BACKUP_DIR=/absolute/path/to/backups \
TENDER_BACKUP_RETENTION=7 \
TENDER_DOCUMENTS_DIR=/absolute/path/to/documents \
TENDER_DB_PATH=/absolute/path/to/tender-tracker.sqlite \
pnpm server
```

`GET /api/backup/automatic` reports the configured directory, retention, and files; `POST /api/backup/now` writes one immediately; `GET /api/backup/automatic/:fileName` downloads a retained snapshot. Existing `/api/backup/export` and `/api/backup/restore` remain available.

These are **app-native local backups only**: no cloud backup, remote replication, external deployment, email sending, or external service contact is implemented. Automatic snapshots contain SQLite rows and document metadata; binary document files remain in `TENDER_DOCUMENTS_DIR` and must be copied separately for a complete attachment backup. Backups are not encrypted at rest by this module, so protect the local directories and portable exports. Restore validation rejects unknown tables/columns, malformed values, and oversized row sets.
