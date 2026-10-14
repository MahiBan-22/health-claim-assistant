import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenText,
  CircleCheck,
  CloudUpload,
  Download,
  FileText,
  LoaderCircle,
  Plus,
  RotateCcw,
  ScanEye,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, blob, saveFile, send } from "./api";
import { useApp } from "./app-context";
import { GLOSSARY, KINDS, kindLabel } from "./lib";
import type {
  ClaimCase,
  Document,
  Page,
  SystemStatus,
  Uploaded,
} from "./types";
import { ExtractionChip, KindChip, Modal, Spinner } from "./ui";

export function CaseDialog({
  item,
  onSaved,
}: {
  item?: ClaimCase;
  onSaved: (saved: ClaimCase) => void;
}) {
  const app = useApp();
  return (
    <Modal
      title={item ? "Edit claim details" : "Start a new claim"}
      subtitle={
        item
          ? "Correct the name or the insurer's claim reference."
          : "Give this claim a home. You can add the documents next."
      }
      close={() => app.open(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const body = {
            title: data.get("title"),
            claim_reference: data.get("reference"),
          };
          void app.act(async () => {
            onSaved(
              await send<ClaimCase>(
                item ? "/cases/" + item.id : "/cases",
                item ? "PATCH" : "POST",
                body,
              ),
            );
            app.open(null);
          });
        }}
      >
        <label className="field">
          Claim name
          <input
            name="title"
            className="input"
            required
            maxLength={200}
            defaultValue={item?.title}
            placeholder="e.g. Hospital stay, October"
            data-autofocus
          />
        </label>
        <label className="field">
          Insurer's claim reference
          <input
            name="reference"
            className="input"
            required
            maxLength={100}
            defaultValue={item?.claim_reference}
            placeholder="e.g. CLM-2026-001"
          />
          <span className="mt-1.5 block text-xs font-normal text-ink-soft">
            Copy it exactly from the insurer's letter. Documents that mention a
            different reference are flagged.
          </span>
        </label>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => app.open(null)}
          >
            Cancel
          </button>
          <button className="btn btn-primary" disabled={app.busy}>
            {!item && <Plus size={16} />}
            {item ? "Save changes" : "Create claim"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type Pending = { file: File; kind: string; replaces: string };

export function UploadDialog({
  item,
  documents,
  onDone,
}: {
  item: ClaimCase;
  documents: Document[];
  onDone: (added: Uploaded[]) => void;
}) {
  const app = useApp();
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const existing = useMemo(
    () => documents.filter((d) => d.is_latest !== false),
    [documents],
  );
  const add = (files: FileList | null) => {
    const accepted = [...(files ?? [])].filter((file) =>
      /\.(pdf|docx|txt)$/i.test(file.name),
    );
    if (files?.length && accepted.length < files.length)
      app.fail(
        "Only PDF, Word (.docx) and plain-text files can be added. Save an older .doc file as .docx first.",
      );
    setPending((current) => [
      ...current,
      ...accepted.map((file) => ({ file, kind: "auto", replaces: "" })),
    ]);
  };
  const patch = (index: number, change: Partial<Pending>) =>
    setPending((current) =>
      current.map((p, i) => (i === index ? { ...p, ...change } : p)),
    );
  async function upload() {
    const added: Uploaded[] = [];
    try {
      for (const [index, entry] of pending.entries()) {
        setProgress(index);
        const data = new FormData();
        data.set("file", entry.file);
        data.set("kind", entry.kind);
        if (entry.replaces) data.set("logical_id", entry.replaces);
        added.push(
          await api<Uploaded>("/cases/" + item.id + "/documents", {
            method: "POST",
            body: data,
          }),
        );
      }
    } finally {
      setProgress(null);
      // Keep only what still needs uploading if one file was refused.
      setPending((current) => current.slice(added.length));
      if (added.length) onDone(added);
    }
    app.open(null);
  }
  return (
    <Modal
      title="Add documents"
      subtitle={
        <>
          For <strong>{item.title}</strong>. Originals are kept exactly as
          uploaded.
        </>
      }
      close={() => app.open(null)}
      wide
    >
      <div
        className={
          "flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed px-6 text-center transition " +
          (pending.length ? "py-4 " : "py-8 ") +
          (dragging
            ? "border-violet-500 bg-violet-50"
            : "border-violet-200 bg-gradient-to-br from-violet-50/70 to-fuchsia-50/70 hover:border-violet-400")
        }
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
      >
        <span className="mb-3 grid size-12 place-items-center rounded-2xl bg-white text-violet-600 shadow-card">
          <CloudUpload size={24} aria-hidden="true" />
        </span>
        <strong className="text-sm">Drop files here, or choose them</strong>
        <span className="mt-1 text-xs text-ink-soft">
          PDF, Word (.docx) or plain text, including scanned pages. Start with
          the insurer's letter, then add everything you sent or hold.
        </span>
        <button
          type="button"
          className="btn btn-soft btn-sm mt-4"
          data-autofocus
        >
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          aria-label="Choose files"
          accept=".pdf,.docx,.txt"
          multiple
          className="sr-only"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <p
        className={
          "mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs leading-relaxed " +
          (app.ready
            ? "border-line bg-white text-ink-soft"
            : "border-amber-200 bg-amber-50 text-amber-950")
        }
      >
        {app.ready ? (
          <Sparkles
            size={15}
            className="mt-0.5 shrink-0 text-violet-600"
            aria-hidden="true"
          />
        ) : (
          <TriangleAlert
            size={15}
            className="mt-0.5 shrink-0 text-amber-500"
            aria-hidden="true"
          />
        )}
        {app.ready
          ? "Typed text is copied exactly. Scanned pages and pictures inside Word files are read by the AI model, a few seconds per page, and labelled so you can compare them with the original."
          : "The AI engine is not available right now, so scanned pages and pictures inside Word files cannot be read yet. Typed text in PDF and Word files is still copied exactly."}
      </p>
      {pending.length > 0 && (
        <ul className="mt-5 max-h-[32vh] space-y-2.5 overflow-y-auto pr-1">
          {pending.map((entry, index) => (
            <li
              key={index}
              className="grid items-center gap-2 rounded-xl border border-line bg-white p-3 sm:grid-cols-[minmax(0,1fr)_11rem_12rem_auto]"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                {progress !== null && index < progress ? (
                  <CircleCheck size={16} className="shrink-0 text-good" />
                ) : progress === index ? (
                  <LoaderCircle
                    size={16}
                    className="shrink-0 animate-spin text-violet-600"
                  />
                ) : (
                  <FileText size={16} className="shrink-0 text-violet-600" />
                )}
                <span className="truncate" title={entry.file.name}>
                  {entry.file.name}
                </span>
              </span>
              <select
                aria-label={"Category for " + entry.file.name}
                className="input mt-0 py-2"
                value={entry.kind}
                disabled={!!entry.replaces}
                onChange={(e) => patch(index, { kind: e.target.value })}
              >
                <option value="auto">Detect category</option>
                {Object.keys(KINDS).map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabel(kind)}
                  </option>
                ))}
              </select>
              <select
                aria-label={"Version for " + entry.file.name}
                className="input mt-0 py-2"
                value={entry.replaces}
                onChange={(e) => patch(index, { replaces: e.target.value })}
              >
                <option value="">New document</option>
                {existing.map((d) => (
                  <option key={d.logical_id} value={d.logical_id}>
                    Newer version of {d.filename}
                  </option>
                ))}
              </select>
              <button
                className="icon-btn"
                aria-label={"Remove " + entry.file.name}
                disabled={progress !== null}
                onClick={() =>
                  setPending((c) => c.filter((_, i) => i !== index))
                }
              >
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-sm text-xs text-ink-soft">
          Got a corrected or final copy? Choose "Newer version of..." so both
          versions are kept and compared.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => app.open(null)}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!pending.length || app.busy}
            onClick={() => void app.act(upload)}
          >
            <CloudUpload size={16} />
            {pending.length > 1
              ? "Add " + pending.length + " documents"
              : "Add document"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Splits page text around a quoted passage, tolerating different line wrapping. */
function highlight(text: string, quote?: string) {
  if (!quote) return [text];
  const pattern = quote
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const match = pattern ? new RegExp(pattern, "i").exec(text) : null;
  return match
    ? [
        text.slice(0, match.index),
        match[0],
        text.slice(match.index + match[0].length),
      ]
    : [text];
}

export function DocumentDialog({
  caseId,
  documentId,
  quote,
  page,
}: {
  caseId: string;
  documentId: string;
  quote?: string;
  page?: number;
}) {
  const app = useApp();
  const [document, setDocument] = useState<
    (Document & { pages: Page[] }) | null
  >(null);
  const [current, setCurrent] = useState(page ?? 1);
  const marked = useRef<HTMLElement>(null);
  useEffect(() => {
    let cancelled = false;
    api<Document & { pages: Page[] }>(
      "/cases/" + caseId + "/documents/" + documentId,
    )
      .then((result) => !cancelled && setDocument(result))
      .catch((e: Error) => {
        app.fail(e.message);
        app.open(null);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, documentId]);
  useEffect(() => {
    // Block body on purpose: an effect must return nothing or a cleanup function.
    marked.current?.scrollIntoView({ block: "center" });
  }, [document, current]);
  const shown =
    document?.pages.find((p) => p.page === current) ?? document?.pages[0];
  const parts = shown
    ? highlight(shown.text, current === (page ?? 1) ? quote : undefined)
    : [];
  return (
    <Modal
      title={document?.filename ?? "Opening document"}
      subtitle={
        quote
          ? "The highlighted passage is the text this finding relies on."
          : undefined
      }
      close={() => app.open(null)}
      wide
    >
      {!document || !shown ? (
        <Spinner label="Opening the document..." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <KindChip value={document.kind} />
            <span className="chip border-line bg-white text-ink-soft">
              Version {document.version}
            </span>
            <ExtractionChip document={document} />
            {document.pages.length > 1 && (
              <span className="ml-auto flex items-center gap-1">
                {document.pages.map((p) => (
                  <button
                    key={p.page}
                    className={
                      "tab px-2.5 py-1 " +
                      (p.page === shown.page ? "tab-active" : "")
                    }
                    onClick={() => setCurrent(p.page)}
                  >
                    Page {p.page}
                  </button>
                ))}
              </span>
            )}
          </div>
          {quote && parts.length === 1 && (
            <p className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <TriangleAlert
                size={16}
                className="mt-0.5 shrink-0 text-amber-500"
              />
              The cited passage could not be located on this page word for word.
              Read the page before relying on the finding.
            </p>
          )}
          {((shown.method === "luna" && !shown.blank) ||
            !!shown.unread_images) && (
            <p className="mb-3 flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
              <ScanEye
                size={16}
                className="mt-0.5 shrink-0 text-sky-500"
                aria-hidden="true"
              />
              {shown.method === "luna"
                ? "Read by AI: text on this page came from a scan or picture and was transcribed by the AI model. Check names, dates and amounts against the original."
                : "A picture on this page could not be read, so its text is missing here. Add the file again once the AI engine is available."}
            </p>
          )}
          <pre className="prose-doc max-h-[52vh] overflow-y-auto">
            {parts.length === 3 ? (
              <>
                {parts[0]}
                <mark ref={marked}>{parts[1]}</mark>
                {parts[2]}
              </>
            ) : shown.blank ? (
              shown.method === "luna" ? (
                "The AI model found no text on this scanned page. Open the original if you expected some."
              ) : (
                "This page is blank in the original."
              )
            ) : shown.readable === false ? (
              "This page is a scan or picture that could not be read. Add the file again once the AI engine is available, or add a clearer copy."
            ) : (
              parts[0]
            )}
          </pre>
          <div className="mt-5 flex justify-end">
            <button
              className="btn btn-soft"
              disabled={app.busy}
              onClick={() =>
                void app.act(async () =>
                  saveFile(
                    await blob(
                      "/cases/" +
                        caseId +
                        "/documents/" +
                        documentId +
                        "/original",
                    ),
                    document.filename,
                  ),
                )
              }
            >
              <Download size={16} />
              Download original
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** The AI engine is signed in on the server, so this only reports its state: there is nothing to connect here. */
export function ConnectionDialog({
  refresh,
}: {
  refresh: () => Promise<unknown>;
}) {
  const app = useApp();
  const status = app.connection;
  return (
    <Modal
      title="AI analysis engine"
      subtitle="Analyses run on the AI model connected to this workspace's server. There is nothing to sign in to, and no key or password is stored in the browser."
      close={() => app.open(null)}
    >
      <div
        className={
          "flex items-center gap-4 rounded-2xl p-4 text-white " +
          (app.ready
            ? "bg-gradient-to-r from-emerald-500 to-teal-500"
            : "bg-gradient-to-r from-violet-600 to-fuchsia-600")
        }
      >
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/20">
          <Sparkles size={24} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="font-bold">
            {app.ready
              ? "Connected and ready"
              : !status
                ? "Checking the AI engine"
                : status.connected
                  ? "Connected, model unavailable"
                  : "Not available right now"}
          </h3>
          <p className="truncate text-sm opacity-90">
            {status?.model ?? "model"}
          </p>
        </div>
      </div>
      <p className="my-5 text-sm leading-relaxed text-ink-soft">
        {status?.message || "Checking the connection..."}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          className="btn btn-soft"
          disabled={app.busy}
          onClick={() => void app.act(async () => void (await refresh()))}
        >
          <RotateCcw size={16} />
          Check again
        </button>
      </div>
    </Modal>
  );
}

export function SystemDialog({ system }: { system: SystemStatus | null }) {
  const app = useApp();
  const rows: {
    name: string;
    ok: boolean;
    optional?: boolean;
    detail: string;
  }[] = system
    ? [
        {
          name: "Workspace service",
          ok: system.api,
          detail: "Stores your claims and documents in this workspace.",
        },
        {
          name: "Database",
          ok: system.database,
          detail:
            system.counts.cases +
            " claims, " +
            system.counts.documents +
            " documents, " +
            system.counts.reports +
            " reports.",
        },
        {
          name: "Analysis queue",
          ok: system.backend === "postgres" || system.redis,
          detail: system.backend === "postgres"
            ? system.queued + " waiting for scheduled processing."
            : system.redis
            ? system.queued + " waiting."
            : "Redis is not reachable. Start it with scripts/start-native.ps1.",
        },
        {
          name: "Analysis execution",
          ok: system.backend === "postgres" || system.workers > 0,
          detail:
            system.backend === "postgres"
              ? "Scheduled processing is configured. Analyses advance as the server scheduler runs."
              : system.workers > 0
              ? "Running. Interrupted analyses resume automatically."
              : "Not running. New analyses will wait until it starts.",
        },
        {
          name: "AI model",
          ok: app.ready,
          detail: app.ready
            ? system.model + " is connected to this workspace."
            : (app.connection?.message ?? "Checking the AI engine..."),
        },
        {
          name: "Scans and pictures",
          ok: app.ready || system.ocr,
          optional: true,
          detail: app.ready
            ? "Scanned pages and pictures in Word files are read by " +
              system.model +
              "."
            : system.ocr
              ? "Read by Tesseract while the AI engine is unavailable."
              : "Scanned pages and pictures need the AI engine. Typed text in PDF and Word files works without it.",
        },
      ]
    : [];
  return (
    <Modal
      title="System status"
      subtitle="The workspace service stores documents and runs analyses using its configured AI model."
      close={() => app.open(null)}
    >
      {!system ? (
        <p className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-critical" />
          The workspace service is not responding. Start the app with
          scripts/start-native.ps1 and reload this page.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.name} className="flex items-start gap-3 py-3.5">
              {row.ok ? (
                <CircleCheck
                  size={19}
                  className="mt-0.5 shrink-0 text-good"
                  aria-label="Working"
                />
              ) : (
                <TriangleAlert
                  size={19}
                  className={
                    "mt-0.5 shrink-0 " +
                    (row.optional ? "text-amber-500" : "text-critical")
                  }
                  aria-label={
                    row.optional ? "Optional, not installed" : "Needs attention"
                  }
                />
              )}
              <div>
                <strong className="text-sm font-semibold">{row.name}</strong>
                <p className="text-sm text-ink-soft">{row.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function GlossaryDialog() {
  const app = useApp();
  const [query, setQuery] = useState("");
  const shown = GLOSSARY.filter((entry) =>
    (entry.term + " " + entry.meaning)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Modal
      title="Insurance terms, decoded"
      subtitle="Plain-language meanings of words that appear in insurer letters. General guidance, not advice about your policy."
      close={() => app.open(null)}
    >
      <input
        className="input mt-0 mb-4"
        placeholder="Search a term..."
        aria-label="Search terms"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-autofocus
      />
      <dl className="space-y-3">
        {shown.map((entry) => (
          <div key={entry.term} className="rounded-2xl border border-line p-4">
            <dt className="flex items-center gap-2 text-sm font-bold">
              <BookOpenText
                size={15}
                className="text-violet-600"
                aria-hidden="true"
              />
              {entry.term}
            </dt>
            <dd className="mt-1.5 text-sm leading-relaxed text-ink-soft">
              {entry.meaning}
            </dd>
          </div>
        ))}
        {!shown.length && (
          <p className="py-6 text-center text-sm text-ink-soft">
            No term matches "{query}".
          </p>
        )}
      </dl>
    </Modal>
  );
}
