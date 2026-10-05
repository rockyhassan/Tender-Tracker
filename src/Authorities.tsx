import { useEffect, useState, type ChangeEvent } from "react";
import { Download, Eye, FileText, LoaderCircle, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import type { Authority, DocumentMetadata } from "../shared/domain";
import { createAuthority, deleteAuthority, deleteDocument, downloadDocument, listAuthorities, listDocuments, updateAuthority, uploadDocument } from "./api";

const empty = { name: "", zone: "", contact: "", referenceNotes: "", etenderPortal: "", etenderReference: "", etenderNotes: "" };
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
async function filePayload(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Unable to read file")); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); }); }

export function DocumentPanel({ target, title = "Documents" }: { target: { tenderId?: string; authorityId?: string }; title?: string }) {
  const [docs, setDocs] = useState<DocumentMetadata[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const load = async () => { try { setDocs(await listDocuments(target)); } catch (e) { setError(e instanceof Error ? e.message : "Unable to load documents"); } };
  useEffect(() => { void load(); }, [target.tenderId, target.authorityId]);
  const add = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; setBusy(true); setError(""); try { await uploadDocument({ ...target, fileName: file.name, mimeType: file.type, data: await filePayload(file) }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Upload failed"); } finally { setBusy(false); } };
  const remove = async (id: string) => { if (!window.confirm("Delete this document?")) return; try { await deleteDocument(id); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); } };
  const download = async (doc: DocumentMetadata) => { try { const blob = await downloadDocument(doc.id); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = doc.fileName; link.click(); URL.revokeObjectURL(url); } catch (e) { setError(e instanceof Error ? e.message : "Download failed"); } };
  return <section className="detail-section document-panel"><div className="section-heading"><div><p className="eyebrow">Local attachments</p><h3>{title}</h3></div><label className="secondary"><Upload size={15} /> {busy ? "Uploading…" : "Upload"}<input hidden type="file" accept=".pdf,.txt,.csv,.png,.jpg,.jpeg,.webp,.zip,.docx,.xlsx,.pptx" onChange={(event) => void add(event)} disabled={busy} /></label></div>{error && <div className="form-error">{error}</div>}{docs.length ? <div className="document-list">{docs.map((doc) => <div className="document-row" key={doc.id}><FileText size={17} /><div><strong>{doc.fileName}</strong><small>{formatSize(doc.sizeBytes)} · {new Date(doc.createdAt).toLocaleDateString()}</small></div><button className="row-action" onClick={() => void download(doc)} aria-label={`Download ${doc.fileName}`}><Download size={15} /></button><button className="row-action danger-action" onClick={() => void remove(doc.id)} aria-label={`Delete ${doc.fileName}`}><Trash2 size={15} /></button></div>)}</div> : <div className="inline-state"><FileText size={17} /> No documents attached yet.</div>}</section>;
}

export function AuthoritiesPage() {
  const [items, setItems] = useState<Authority[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Authority | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [values, setValues] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const viewing = items.find((i) => i.id === viewingId) ?? null;

  const load = async () => {
    try {
      setItems(await listAuthorities());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load authority profiles");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const open = (authority?: Authority) => {
    setEditorOpen(true);
    setEditing(authority ?? null);
    setValues(
      authority
        ? {
            name: authority.name,
            zone: authority.zone ?? "",
            contact: authority.contact ?? "",
            referenceNotes: authority.referenceNotes ?? "",
            etenderPortal: authority.etenderPortal ?? "",
            etenderReference: authority.etenderReference ?? "",
            etenderNotes: authority.etenderNotes ?? "",
          }
        : empty
    );
    setError("");
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (editing) await updateAuthority(editing.id, values);
      else await createAuthority(values);
      setEditorOpen(false);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save authority");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this authority profile and its attachments?")) return;
    try {
      await deleteAuthority(id);
      if (viewingId === id) setViewingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to delete authority");
    }
  };

  return (
    <section className="authority-layout">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Reference register</p>
            <h2>Authority Profiles</h2>
            <p className="subhead">Reusable authority, contact, and e-Tender reference data.</p>
          </div>
          <button className="primary" onClick={() => open()}>
            <Plus size={16} /> Add authority
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {items.length ? (
          <div className="authority-list">
            {items.map((authority) => (
              <article className="authority-item" key={authority.id}>
                <div className="authority-item-main">
                  <div className="authority-item-header">
                    <strong className="authority-item-name">{authority.name}</strong>
                  </div>
                  <div className="authority-item-meta">
                    {authority.contact ? (
                      <span className="authority-meta-tag">
                        <span className="meta-label">Contact:</span> {authority.contact}
                      </span>
                    ) : null}
                    {authority.etenderReference ? (
                      <span className="authority-meta-tag">
                        <span className="meta-label">e-Tender:</span> {authority.etenderReference}
                      </span>
                    ) : null}
                    {!authority.contact && !authority.etenderReference ? (
                      <span className="authority-meta-tag muted">No contact or e-Tender reference</span>
                    ) : null}
                  </div>
                </div>
                <div className="authority-item-actions">
                  <button
                    type="button"
                    className="secondary view-action"
                    onClick={() => setViewingId(authority.id)}
                    aria-label={`View ${authority.name} details`}
                  >
                    <Eye size={14} /> View
                  </button>
                  <button
                    type="button"
                    className="row-action"
                    onClick={() => open(authority)}
                    aria-label={`Edit ${authority.name}`}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="row-action danger-action"
                    onClick={() => void remove(authority.id)}
                    aria-label={`Delete ${authority.name}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="table-state empty-state">
            <FileText size={22} />
            <strong>No authority profiles yet.</strong>
            <span>Add an authority to reuse its contact and reference notes.</span>
            <button className="secondary" onClick={() => open()}>
              <Plus size={15} /> Create authority profile
            </button>
          </div>
        )}
      </section>

      {viewing && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setViewingId(null);
            }
          }}
        >
          <section
            className="modal authority-modal authority-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="authority-preview-title"
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">Authority details</p>
                <h2 id="authority-preview-title">{viewing.name}</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setViewingId(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="authority-preview-body">
              <div className="authority-details-grid">
                {viewing.contact ? (
                  <div className="detail-item">
                    <span className="detail-label">Contact / reference contact</span>
                    <span className="detail-value">{viewing.contact}</span>
                  </div>
                ) : null}
                {viewing.etenderReference ? (
                  <div className="detail-item">
                    <span className="detail-label">e-Tender account / reference</span>
                    <span className="detail-value">{viewing.etenderReference}</span>
                  </div>
                ) : null}
                {viewing.etenderPortal ? (
                  <div className="detail-item full-field">
                    <span className="detail-label">e-Tender portal</span>
                    <a
                      href={viewing.etenderPortal}
                      target="_blank"
                      rel="noreferrer"
                      className="detail-link"
                    >
                      {viewing.etenderPortal}
                    </a>
                  </div>
                ) : null}
                {viewing.referenceNotes ? (
                  <div className="detail-item full-field">
                    <span className="detail-label">Reference notes</span>
                    <p className="detail-notes">{viewing.referenceNotes}</p>
                  </div>
                ) : null}
                {viewing.etenderNotes ? (
                  <div className="detail-item full-field">
                    <span className="detail-label">e-Tender notes</span>
                    <p className="detail-notes">{viewing.etenderNotes}</p>
                  </div>
                ) : null}
                {!viewing.contact &&
                !viewing.etenderReference &&
                !viewing.etenderPortal &&
                !viewing.referenceNotes &&
                !viewing.etenderNotes ? (
                  <div className="detail-item full-field">
                    <span className="detail-empty">
                      No additional reference details recorded for this authority.
                    </span>
                  </div>
                ) : null}
              </div>
              <DocumentPanel
                target={{ authorityId: viewing.id }}
                title="Authority documents"
              />
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setViewingId(null)}
              >
                Close
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const toEdit = viewing;
                  setViewingId(null);
                  open(toEdit);
                }}
              >
                <Pencil size={15} /> Edit authority
              </button>
            </div>
          </section>
        </div>
      )}

      {editorOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setEditorOpen(false);
              setEditing(null);
            }
          }}
        >
          <section className="modal authority-modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div>
                <p className="eyebrow">Authority register</p>
                <h2>{editing ? "Edit authority" : "New authority"}</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => {
                  setEditorOpen(false);
                  setEditing(null);
                }}
              >
                <X size={18} />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <div className="form-grid">
                <label className="full-field">
                  <span>Name</span>
                  <input
                    required
                    value={values.name}
                    onChange={(e) => setValues({ ...values, name: e.target.value })}
                  />
                </label>
                <label>
                  <span>Contact / reference contact</span>
                  <input
                    value={values.contact}
                    onChange={(e) => setValues({ ...values, contact: e.target.value })}
                  />
                </label>
                <label>
                  <span>e-Tender portal URL</span>
                  <input
                    type="url"
                    value={values.etenderPortal}
                    onChange={(e) => setValues({ ...values, etenderPortal: e.target.value })}
                  />
                </label>
                <label className="full-field">
                  <span>e-Tender account/reference</span>
                  <input
                    value={values.etenderReference}
                    onChange={(e) => setValues({ ...values, etenderReference: e.target.value })}
                  />
                </label>
                <label className="full-field">
                  <span>Reference notes</span>
                  <textarea
                    rows={3}
                    value={values.referenceNotes}
                    onChange={(e) => setValues({ ...values, referenceNotes: e.target.value })}
                  />
                </label>
                <label className="full-field">
                  <span>e-Tender notes</span>
                  <textarea
                    rows={2}
                    value={values.etenderNotes}
                    onChange={(e) => setValues({ ...values, etenderNotes: e.target.value })}
                  />
                </label>
              </div>
              {error && <div className="form-error">{error}</div>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditorOpen(false);
                    setEditing(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || !values.name.trim()}
                >
                  {busy ? <LoaderCircle className="spin" size={16} /> : null} Save authority
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
