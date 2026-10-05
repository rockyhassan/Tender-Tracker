import type { Tender, TenderDetails, TenderListQuery, TenderResult } from "../shared/domain";

export type SyncState = "online" | "offline" | "queued" | "synced" | "retry";
export type TenderMutationKind = "create" | "update" | "delete";

export interface TenderMutation {
  id: string;
  kind: TenderMutationKind;
  targetId: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface CachedLifecycleEntry {
  tenderId: string;
  result?: TenderResult;
  syncedAt: string;
}

interface LocalState {
  tenders: Tender[];
  queue: TenderMutation[];
  idMap: Record<string, string>;
  lifecycle: Record<string, CachedLifecycleEntry>;
}

const STORAGE_KEY = "tender-tracker.offline.v2";
const LEGACY_STORAGE_KEY = "tender-tracker.offline.v1";
let memoryState: LocalState = { tenders: [], queue: [], idMap: {}, lifecycle: {} };

function cloneState(state: LocalState): LocalState { return JSON.parse(JSON.stringify(state)) as LocalState; }

function storage(): Storage | null {
  try {
    const browserWindow = (globalThis as typeof globalThis & { window?: { localStorage?: Storage } }).window;
    if (!browserWindow?.localStorage) return null;
    const probe = `${STORAGE_KEY}.probe`;
    browserWindow.localStorage.setItem(probe, "1"); browserWindow.localStorage.removeItem(probe);
    return browserWindow.localStorage;
  } catch { return null; }
}

function readState(): LocalState {
  const store = storage();
  if (!store) return cloneState(memoryState);
  try {
    const raw = store.getItem(STORAGE_KEY) ?? store.getItem(LEGACY_STORAGE_KEY);
    const parsed = JSON.parse(raw ?? "null") as Partial<LocalState> | null;
    if (!parsed || !Array.isArray(parsed.tenders) || !Array.isArray(parsed.queue)) return cloneState(memoryState);
    return {
      tenders: parsed.tenders as Tender[],
      queue: parsed.queue as TenderMutation[],
      idMap: parsed.idMap && typeof parsed.idMap === "object" ? parsed.idMap as Record<string, string> : {},
      lifecycle: parsed.lifecycle && typeof parsed.lifecycle === "object" ? parsed.lifecycle as Record<string, CachedLifecycleEntry> : {},
    };
  } catch { return cloneState(memoryState); }
}

function writeState(state: LocalState): void {
  memoryState = cloneState(state);
  const store = storage();
  if (!store) return;
  try { store.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* memoryState remains available for this session */ }
}

export function cacheTenders(tenders: Tender[]): void {
  const state = readState();
  const queuedIds = new Set(state.queue.map((item) => item.targetId));
  const local = state.tenders.filter((item) => queuedIds.has(item.id));
  const merged = [...local, ...tenders].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  merged.sort((a, b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id) || a.id.localeCompare(b.id));
  writeState({ ...state, tenders: merged });
}

/** Cache lifecycle result/status data returned by a details request. */
export function cacheTenderDetails(details: TenderDetails): void {
  cacheLifecycleResults([{ tenderId: details.tender.id, result: details.result }]);
}

/** Replace the lifecycle snapshot after an online synchronization. Missing results are intentional (Pending). */
export function replaceLifecycleCache(entries: Array<{ tenderId: string; result?: TenderResult }>): void {
  const now = new Date().toISOString();
  const lifecycle: Record<string, CachedLifecycleEntry> = {};
  for (const entry of entries) lifecycle[entry.tenderId] = { tenderId: entry.tenderId, result: entry.result, syncedAt: now };
  const state = readState();
  writeState({ ...state, lifecycle });
}

export function cacheLifecycleResults(entries: Array<{ tenderId: string; result?: TenderResult }>): void {
  const state = readState();
  const lifecycle = { ...state.lifecycle };
  const now = new Date().toISOString();
  for (const entry of entries) lifecycle[entry.tenderId] = { tenderId: entry.tenderId, result: entry.result, syncedAt: now };
  writeState({ ...state, lifecycle });
}

export function cachedLifecycleResult(tenderId: string): TenderResult | undefined { return readState().lifecycle[tenderId]?.result; }

export function cachedTenders(query: string | TenderListQuery = ""): Tender[] {
  const filters: TenderListQuery = typeof query === "string" ? (query.trim() ? { q: query.trim() } : {}) : query;
  const normalized = filters.q?.trim().toLowerCase();
  const includes = (value: string | undefined, filter: string | undefined) => !filter || Boolean(value?.toLowerCase().includes(filter.toLowerCase()));
  const dateBoundary = (value: string | undefined, end: boolean) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : value;
  const closingFrom = dateBoundary(filters.closingFrom ?? filters.closingDateFrom, false);
  const closingTo = dateBoundary(filters.closingTo ?? filters.closingDateTo, true);
  const submissionFrom = dateBoundary(filters.submissionFrom ?? filters.submissionDateFrom, false);
  const submissionTo = dateBoundary(filters.submissionTo ?? filters.submissionDateTo, true);
  const valueMin = filters.valueMin ?? filters.tenderValueMin;
  const valueMax = filters.valueMax ?? filters.tenderValueMax;
  const requestedResult = filters.result === "Win" ? "Won" : filters.result;
  const state = readState();
  return state.tenders
    .filter((tender) => !normalized || `${tender.tenderId} ${tender.company} ${tender.authority} ${tender.packageName}`.toLowerCase().includes(normalized))
    .filter((tender) => includes(tender.tenderId, filters.tenderId))
    .filter((tender) => includes(tender.company, filters.company))
    .filter((tender) => includes(tender.authority, filters.authority))
    .filter((tender) => includes(`${tender.authority} ${tender.authorityZone ?? ""}`, filters.authorityZone))
    .filter((tender) => includes(tender.packageName, filters.packageName))
    .filter((tender) => !filters.companyId || tender.companyId === filters.companyId)
    .filter((tender) => !filters.status || tender.status === filters.status)
    .filter((tender) => !filters.stage || tender.stage === filters.stage)
    .filter((tender) => !closingFrom || tender.closingAt >= closingFrom)
    .filter((tender) => !closingTo || tender.closingAt <= closingTo)
    .filter((tender) => !submissionFrom || Boolean(tender.submissionAt && tender.submissionAt >= submissionFrom))
    .filter((tender) => !submissionTo || Boolean(tender.submissionAt && tender.submissionAt <= submissionTo))
    .filter((tender) => valueMin === undefined || tender.tenderValue !== undefined && tender.tenderValue >= valueMin)
    .filter((tender) => valueMax === undefined || tender.tenderValue !== undefined && tender.tenderValue <= valueMax)
    .filter((tender) => {
      if (!requestedResult) return true;
      const result = state.lifecycle[tender.id]?.result;
      return requestedResult === "Pending" ? !result || result.outcome === "Pending" : result?.outcome === requestedResult;
    })
    .sort((a, b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id) || a.id.localeCompare(b.id))
    .map((tender) => ({ ...tender }));
}

export function upsertCachedTender(tender: Tender): void { const state = readState(); writeState({ ...state, tenders: [...state.tenders.filter((item) => item.id !== tender.id), tender] }); }
export function removeCachedTender(id: string): void { const state = readState(); const lifecycle = { ...state.lifecycle }; delete lifecycle[id]; writeState({ ...state, tenders: state.tenders.filter((item) => item.id !== id), lifecycle }); }
export function enqueueTenderMutation(kind: TenderMutationKind, targetId: string, payload?: Record<string, unknown>): TenderMutation { const state = readState(); const mutation: TenderMutation = { id: crypto.randomUUID(), kind, targetId, payload, createdAt: new Date().toISOString(), attempts: 0 }; writeState({ ...state, queue: [...state.queue, mutation] }); return mutation; }
export function pendingTenderMutations(): TenderMutation[] { return readState().queue.map((item) => ({ ...item, payload: item.payload ? { ...item.payload } : undefined })); }
export function updateMutation(mutationId: string, changes: Partial<TenderMutation>): void { const state = readState(); writeState({ ...state, queue: state.queue.map((item) => item.id === mutationId ? { ...item, ...changes } : item) }); }
export function removeMutation(mutationId: string): void { const state = readState(); writeState({ ...state, queue: state.queue.filter((item) => item.id !== mutationId) }); }
export function reconcileTenderId(localId: string, serverId: string): void { if (localId === serverId) return; const state = readState(); const tenders = state.tenders.map((item) => item.id === localId ? { ...item, id: serverId } : item); const queue = state.queue.map((item) => item.targetId === localId ? { ...item, targetId: serverId } : item); const lifecycle = { ...state.lifecycle }; if (lifecycle[localId]) { lifecycle[serverId] = { ...lifecycle[localId], tenderId: serverId }; delete lifecycle[localId]; } writeState({ ...state, tenders, queue, idMap: { ...state.idMap, [localId]: serverId }, lifecycle }); }
export function resolveTenderId(id: string): string { return readState().idMap[id] ?? id; }
export function pendingMutationCount(): number { return readState().queue.length; }

// Kept for callers that need to seed a details snapshot in tests without reaching into storage.
export function clearOfflineState(): void { writeState({ tenders: [], queue: [], idMap: {}, lifecycle: {} }); }
