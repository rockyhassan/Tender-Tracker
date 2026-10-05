import { mkdirSync, readdirSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { exportBackup, type BackupSnapshot } from "./backup-service";

export const backupDirectory = resolve(process.env.TENDER_BACKUP_DIR ?? join(process.cwd(), "data/backups"));
export const backupRetention = Math.max(1, Number(process.env.TENDER_BACKUP_RETENTION ?? 7) || 7);
const filePattern = /^tender-tracker-auto-(\d{4}-\d{2}-\d{2})\.json$/;
export function automaticBackupFiles() { mkdirSync(backupDirectory, { recursive: true }); return readdirSync(backupDirectory).filter((name) => filePattern.test(name)).sort().reverse(); }
export function writeAutomaticBackup(database: DatabaseSync, now = new Date()): { path: string; fileName: string; exportedAt: string } { mkdirSync(backupDirectory, { recursive: true }); const snapshot: BackupSnapshot = exportBackup(database); const date = now.toISOString().slice(0, 10); const fileName = `tender-tracker-auto-${date}.json`; const path = join(backupDirectory, fileName); const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); renameSync(temp, path); const files = automaticBackupFiles(); for (const old of files.slice(backupRetention)) rmSync(join(backupDirectory, old), { force: true }); return { path, fileName, exportedAt: snapshot.exportedAt }; }
export function readAutomaticBackup(fileName: string) { if (!filePattern.test(fileName) || fileName.includes("..")) throw new Error("Invalid automatic backup name"); const path = join(backupDirectory, fileName); return { path, data: readFileSync(path, "utf8") }; }
export function automaticBackupStatus() { const files = automaticBackupFiles(); return { directory: backupDirectory, retention: backupRetention, files, latest: files[0] }; }
export function startAutomaticBackups(database: DatabaseSync) { try { writeAutomaticBackup(database); } catch (error) { console.error("Automatic local backup failed on startup", error); } let lastDay = new Date().toISOString().slice(0, 10); const timer = setInterval(() => { const day = new Date().toISOString().slice(0, 10); if (day !== lastDay) { lastDay = day; try { writeAutomaticBackup(database); } catch (error) { console.error("Automatic local backup failed", error); } } }, 60_000); timer.unref(); return timer; }
