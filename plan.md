# Tender Tracker — Initial Implementation Plan

## Goal
Build an English-language installable PWA for one owner to manage the full tender lifecycle on PC and mobile. The first repository milestone establishes a desktop-first editorial operations dashboard, shared domain model, API boundary, database schema foundation, and PWA route metadata.

## Design direction
Editorial operations dashboard: quietly authoritative, inspired by financial ledgers and modern command centers. Deep ink/navy structure, warm paper surfaces, a single deep-teal action color (`#0F766E`), and amber/red only for urgency. The interface uses a persistent left rail, a deadline-first workspace, compact status chips, ledger rules, tabular numerals, and restrained 150–220ms motion.

## Project structure
- `src/`: React client shell, dashboard composition, and visual system.
- `shared/`: domain types and workflow enums shared by client/server.
- `server/`: Express API entry point; later expanded with typed procedures.
- `drizzle/`: relational schema foundation for companies, issue batches, and tenders.
- `public/`: PWA manifest and route declarations.
- `plan.md`, `TODO.md`: approved scope and delivery outcomes.

## Next implementation slices
1. Add database adapter, migrations, and CRUD procedures for tender lifecycle records.
2. Add offline persistence, queued mutations, and online reconciliation indicators.
3. Implement tender register, issue batches, purchase sheets, and lifecycle drawers.
4. Implement imports, duplicate review, reports, backup/restore, and sensitive credential masking.
