# Tender Tracker delivery outcomes

- [ ] **Foundation and navigation:** A React/Vite client provides Dashboard, Tenders, Issue Batches, Purchase Sheets, Companies, Reports, and Settings navigation with the approved editorial operations dashboard design direction.
- [x] **Tender lifecycle data model:** Shared types and relational tables now preserve per-company separation when Tender IDs repeat and include tender, submission, payment, pay order, credit commitment, result, NOA, performance security, and contract agreement records.
- [x] **Tender CRUD/API slice:** The Express API has an in-memory repository/service boundary, zod validation, tender list/create/read/update/delete routes, and a deadline summary route.
- [ ] **Offline-first workflow:** The PWA supports offline viewing and entry, queues mutations, displays sync state, and reconciles changes when online without silently discarding mobile edits.
- [ ] **Import and reporting:** Historical Excel import supports duplicate review choices (keep old, replace/update, keep both, skip); reports export to PDF and Excel with filters and totals.
- [ ] **Security and backups:** One owner is protected by a Master Password, sensitive e-Tender credentials remain masked/encrypted, and Backup Now plus self-service Restore are available.
