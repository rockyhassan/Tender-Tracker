import { useEffect, useMemo, useState } from "react";
import { Clipboard, Copy, Plus, Trash2, Upload, X } from "lucide-react";
import type { Authority, IssueBatch, IssueBatchStatus } from "../shared/domain";
import { listAuthorities } from "./api";

export interface BulkTenderDraft {
  tenderId: string;
  packageName: string;
  closingAt: string;
}

export interface NewBatchDraft {
  issueDate: string;
  authorityId: string;
  authorityZone: string;
  reference: string;
  notes: string;
  status: IssueBatchStatus;
}

const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const blank = (): BulkTenderDraft => ({
  tenderId: "",
  packageName: "",
  closingAt: "",
});

function parseClosingDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Match DD-MM-YYYY or DD/MM/YYYY with optional time and AM/PM
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?/i);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, "0");
    const month = dmyMatch[2].padStart(2, "0");
    const year = dmyMatch[3];
    let hour = parseInt(dmyMatch[4] ?? "0", 10);
    const min = dmyMatch[5] ?? "00";
    const ampm = dmyMatch[7]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const hourStr = String(hour).padStart(2, "0");
    return `${year}-${month}-${day}T${hourStr}:${min}`;
  }

  // Match YYYY-MM-DD or YYYY/MM/DD with optional time and AM/PM
  const ymdMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?/i);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, "0");
    const day = ymdMatch[3].padStart(2, "0");
    let hour = parseInt(ymdMatch[4] ?? "0", 10);
    const min = ymdMatch[5] ?? "00";
    const ampm = ymdMatch[7]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const hourStr = String(hour).padStart(2, "0");
    return `${year}-${month}-${day}T${hourStr}:${min}`;
  }

  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  return trimmed;
}

const rowValidation = (rows: BulkTenderDraft[]) => {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const id = row.tenderId.trim().toLowerCase();
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  const duplicateIds = new Set([...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id));
  const rowErrors = rows.map((row) => {
    const errors: string[] = [];
    if (!row.tenderId.trim()) errors.push("Tender ID");
    if (!row.packageName.trim()) errors.push("Package & Scheme");
    if (!row.closingAt || Number.isNaN(new Date(row.closingAt).getTime())) errors.push("Closing");
    if (duplicateIds.has(row.tenderId.trim().toLowerCase())) errors.push("Duplicate ID");
    return errors;
  });
  return { duplicateIds, rowErrors };
};

function TenderGrid({ rows, setRows }: { rows: BulkTenderDraft[]; setRows: React.Dispatch<React.SetStateAction<BulkTenderDraft[]>> }) {
  const [pasteMessage, setPasteMessage] = useState("");
  const { duplicateIds, rowErrors } = useMemo(() => rowValidation(rows), [rows]);

  const update = (index: number, key: keyof BulkTenderDraft, value: string) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, [key]: value } : row)));

  const parsePaste = (value: string) => {
    const lines = value
      .trimEnd()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (!lines.length) return;

    const parsedRows: BulkTenderDraft[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const cells = line.split("\t").map((cell) => cell.trim());

      // If the first row looks like column headers (e.g. copied from a table), skip it
      if (i === 0) {
        const c0 = cells[0]?.toLowerCase() ?? "";
        const c1 = cells[1]?.toLowerCase() ?? "";
        if (
          (c0 === "tender id" || c0 === "id" || c0.includes("tender")) &&
          (c1.includes("package") || c1.includes("scheme") || c1 === "name")
        ) {
          continue;
        }
      }

      const tenderId = cells[0] ?? "";
      const packageName = cells[1] ?? "";
      const rawClosing = cells[2] ?? "";
      const closingAt = parseClosingDate(rawClosing);

      if (tenderId || packageName || closingAt) {
        parsedRows.push({
          tenderId,
          packageName,
          closingAt,
        });
      }
    }

    if (!parsedRows.length) return;

    setRows((current) => {
      const isSingleBlank =
        current.length === 1 &&
        !current[0].tenderId &&
        !current[0].packageName &&
        !current[0].closingAt;
      const base = isSingleBlank ? [] : current;
      return [...base, ...parsedRows];
    });

    setPasteMessage(`${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"} pasted.`);
  };

  const handleClipboardPaste = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          parsePaste(text);
          return;
        }
        setPasteMessage("Clipboard is empty.");
        return;
      }
    } catch {
      // Clipboard read blocked or not permitted
    }
    setPasteMessage("Press Ctrl+V to paste tab-separated rows from clipboard, or upload a TSV file.");
  };

  const handleContainerPaste = (event: React.ClipboardEvent) => {
    const text = event.clipboardData?.getData("text");
    if (text && (text.includes("\t") || text.includes("\n"))) {
      event.preventDefault();
      parsePaste(text);
    }
  };

  return (
    <>
      <div className="bulk-toolbar">
        <button type="button" className="secondary" onClick={() => setRows((current) => [...current, blank()])}>
          <Plus size={14} /> Add row
        </button>
        <button type="button" className="secondary" onClick={handleClipboardPaste}>
          <Clipboard size={14} /> Paste rows
        </button>
        <label className="secondary paste-button" title="Upload TSV or text file">
          <Upload size={14} /> Upload TSV
          <input
            type="file"
            accept="text/plain,.tsv,.txt"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) parsePaste(await file.text());
            }}
          />
        </label>
        <span>Paste tab-separated rows (Ctrl+V): Tender ID, Package &amp; Scheme, Closing</span>
      </div>
      <div className="bulk-grid-wrap" onPaste={handleContainerPaste}>
        <table className="bulk-grid">
          <thead>
            <tr>
              <th style={{ width: "40px" }}>#</th>
              <th style={{ width: "220px" }}>Tender ID *</th>
              <th>Package &amp; Scheme *</th>
              <th style={{ width: "230px" }}>Closing *</th>
              <th style={{ width: "75px" }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className={rowErrors[index].length ? "bulk-invalid" : ""}>
                <td className="bulk-index">{index + 1}</td>
                <td>
                  <input
                    required
                    aria-label={`Tender ID row ${index + 1}`}
                    type="text"
                    placeholder="e.g. 135000"
                    value={row.tenderId}
                    onChange={(event) => update(index, "tenderId", event.target.value)}
                  />
                </td>
                <td>
                  <input
                    required
                    aria-label={`Package and Scheme row ${index + 1}`}
                    type="text"
                    placeholder="e.g. Road Rehabilitation"
                    value={row.packageName}
                    onChange={(event) => update(index, "packageName", event.target.value)}
                  />
                </td>
                <td>
                  <input
                    required
                    aria-label={`Closing row ${index + 1}`}
                    type="datetime-local"
                    value={row.closingAt}
                    onChange={(event) => update(index, "closingAt", event.target.value)}
                  />
                </td>
                <td>
                  <div className="bulk-row-actions">
                    <button
                      type="button"
                      className="row-action"
                      aria-label={`Duplicate row ${index + 1}`}
                      title="Duplicate row"
                      onClick={() =>
                        setRows((current) => [
                          ...current.slice(0, index + 1),
                          { ...current[index] },
                          ...current.slice(index + 1),
                        ])
                      }
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      type="button"
                      className="row-action danger-action"
                      aria-label={`Remove row ${index + 1}`}
                      title="Remove row"
                      onClick={() =>
                        setRows((current) =>
                          current.length === 1 ? [blank()] : current.filter((_, i) => i !== index)
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {rowErrors[index].length > 0 && (
                    <small className="bulk-row-error">{rowErrors[index].join(", ")}</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pasteMessage && <div className="bulk-paste-message">{pasteMessage}</div>}
      <div className="bulk-summary">
        <strong>{rows.length} rows</strong>
        <span>{rowErrors.filter((value) => value.length === 0).length} ready</span>
        <span>{rowErrors.filter((value) => value.length > 0).length} need attention</span>
        <span>
          {duplicateIds.size
            ? `${duplicateIds.size} duplicate ID warning${duplicateIds.size === 1 ? "" : "s"}`
            : "No duplicate IDs"}
        </span>
      </div>
    </>
  );
}

export function BulkTenderEntry({
  batch,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  batch: IssueBatch;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (rows: BulkTenderDraft[]) => void;
}) {
  const [rows, setRows] = useState<BulkTenderDraft[]>([blank()]);
  const { rowErrors } = useMemo(() => rowValidation(rows), [rows]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section className="modal bulk-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <p className="eyebrow">Issue batch · {batch.authorityZone}</p>
            <h2>Enter tender lines</h2>
            <span className="modal-subtitle">
              Authority / zone is inherited from this batch. Add several rows, then save once.
            </span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <TenderGrid rows={rows} setRows={setRows} />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={saving || rowErrors.some((value) => value.length > 0)}
            onClick={() => onSubmit(rows)}
          >
            {saving ? "Saving rows…" : `Save all ${rows.length} rows`}
          </button>
        </div>
      </section>
    </div>
  );
}

export function NewIssueBatchWithTenders({
  saving,
  error,
  onClose,
  onOpenAuthorities,
  onSubmit,
}: {
  saving: boolean;
  error: string;
  onClose: () => void;
  onOpenAuthorities?: () => void;
  onSubmit: (batch: NewBatchDraft, rows: BulkTenderDraft[]) => void;
}) {
  const [batch, setBatch] = useState<NewBatchDraft>({
    issueDate: localDate(new Date()),
    authorityId: "",
    authorityZone: "",
    reference: "",
    notes: "",
    status: "Draft",
  });
  const [authorities, setAuthorities] = useState<Authority[]>([]);
  const [authorityError, setAuthorityError] = useState("");
  const [rows, setRows] = useState<BulkTenderDraft[]>([blank()]);
  useEffect(() => {
    void listAuthorities()
      .then(setAuthorities)
      .catch((exception) =>
        setAuthorityError(exception instanceof Error ? exception.message : "Unable to load authority profiles.")
      );
  }, []);
  const { rowErrors } = useMemo(() => rowValidation(rows), [rows]);
  const update = (key: keyof NewBatchDraft, value: string) =>
    setBatch(
      (current) =>
        ({
          ...current,
          [key]: value,
          ...(key === "authorityId"
            ? { authorityZone: authorities.find((authority) => authority.id === value)?.zone ?? "" }
            : {}),
        }) as NewBatchDraft
    );
  const invalidBatch =
    !batch.issueDate || !batch.authorityId || !authorities.some((authority) => authority.id === batch.authorityId);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section className="modal bulk-modal new-batch-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <p className="eyebrow">Issue control</p>
            <h2>New batch with tender lines</h2>
            <span className="modal-subtitle">
              Create the authority-only batch and every tender line together. No company is assigned here; assign companies per line on Purchase Sheets.
            </span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="new-batch-fields">
          <label>
            <span>Issue date *</span>
            <input
              required
              type="date"
              value={batch.issueDate}
              onChange={(event) => update("issueDate", event.target.value)}
            />
          </label>
          <label>
            <span>Authority profile *</span>
            {authorities.length ? (
              <select
                required
                value={batch.authorityId}
                onChange={(event) => update("authorityId", event.target.value)}
              >
                <option value="">Select saved authority</option>
                {authorities.map((authority) => (
                  <option key={authority.id} value={authority.id}>
                    {authority.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="inline-state">
                <span>No authority profiles yet. Create one in Authorities first.</span>
                {onOpenAuthorities && (
                  <button type="button" className="secondary" onClick={onOpenAuthorities}>
                    Create authority profile
                  </button>
                )}
              </div>
            )}
          </label>
        </div>
        <details className="additional-details">
          <summary>Additional Details</summary>
          <div className="form-grid">
            <label>
              <span>Reference<small>Optional</small></span>
              <input value={batch.reference} onChange={(event) => update("reference", event.target.value)} />
            </label>
            <label className="full-field">
              <span>Notes<small>Optional</small></span>
              <textarea rows={2} value={batch.notes} onChange={(event) => update("notes", event.target.value)} />
            </label>
          </div>
        </details>
        {authorityError && <div className="form-error">{authorityError}</div>}
        <TenderGrid rows={rows} setRows={setRows} />
        {error && <div className="form-error">{error}</div>}
        {invalidBatch && <div className="form-error">Choose a saved authority profile before creating the batch.</div>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={saving || invalidBatch || rowErrors.some((value) => value.length > 0)}
            onClick={() => onSubmit(batch, rows)}
          >
            {saving ? "Creating batch…" : `Create batch with ${rows.length} tenders`}
          </button>
        </div>
      </section>
    </div>
  );
}
