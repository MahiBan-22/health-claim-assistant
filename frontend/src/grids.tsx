import { Download, Eye, FileText, Flag, Trash2 } from "lucide-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
} from "ag-grid-community";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type { Document, Finding, QueueItem, Report } from "./types";
import { CATEGORY, KINDS, date, kindLabel, refsOf } from "./lib";
import {
  DecisionChip,
  EvidenceChip,
  ExtractionChip,
  KindChip,
  SubmissionChip,
} from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "#7c3aed",
  backgroundColor: "#ffffff",
  foregroundColor: "#1c1740",
  borderColor: "#e6e2f6",
  headerBackgroundColor: "#f7f5ff",
  headerTextColor: "#49446e",
  rowHoverColor: "#f5f3ff",
  selectedRowBackgroundColor: "#ede9fe",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 700,
  rowHeight: 56,
  headerHeight: 42,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  spacing: 8,
});
const defaults: ColDef = {
  sortable: true,
  resizable: true,
  suppressMovable: true,
};

type DocumentActions = {
  open: (d: Document) => void;
  download: (d: Document) => void;
  remove: (d: Document) => void;
};

const documentColumns: ColDef<Document>[] = [
  {
    field: "filename",
    headerName: "Document",
    flex: 2,
    minWidth: 180,
    filter: true,
    cellRenderer: ({
      data,
      context,
    }: CustomCellRendererProps<Document, string, DocumentActions>) =>
      data && (
        <button
          className="flex min-w-0 items-center gap-3 text-left font-semibold hover:text-violet-700"
          onClick={() => context.open(data)}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-700">
            <FileText size={17} aria-hidden="true" />
          </span>
          <span className="truncate" title={data.filename}>
            {data.filename}
          </span>
        </button>
      ),
  },
  {
    field: "kind",
    headerName: "Category",
    headerTooltip: "Click a category to correct it",
    width: 156,
    filter: true,
    editable: true,
    singleClickEdit: true,
    cellEditor: "agSelectCellEditor",
    cellEditorParams: { values: Object.keys(KINDS) },
    valueFormatter: (p) => kindLabel(p.value),
    cellRenderer: ({ value }: CustomCellRendererProps<Document, string>) =>
      value ? <KindChip value={value} /> : null,
  },
  {
    field: "version",
    headerName: "Version",
    width: 100,
    cellRenderer: ({ data }: CustomCellRendererProps<Document>) =>
      data && (
        <span className="flex items-center gap-2">
          <strong className="font-semibold">v{data.version}</strong>
          {data.is_latest === false && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-ink-soft">
              older
            </span>
          )}
        </span>
      ),
  },
  {
    field: "extraction_status",
    headerName: "Text",
    width: 136,
    cellRenderer: ({ data }: CustomCellRendererProps<Document, string>) =>
      data && <ExtractionChip document={data} />,
  },
  {
    field: "created_at",
    headerName: "Added",
    width: 96,
    valueFormatter: (p) =>
      p.value
        ? new Date(p.value).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
          })
        : "",
    tooltipValueGetter: (p) => date(p.value),
  },
  {
    headerName: "",
    colId: "actions",
    width: 124,
    sortable: false,
    resizable: false,
    cellRenderer: ({
      data,
      context,
    }: CustomCellRendererProps<Document, unknown, DocumentActions>) =>
      data && (
        <span className="flex items-center">
          <button
            className="icon-btn"
            aria-label={"Read " + data.filename}
            title="Read"
            onClick={() => context.open(data)}
          >
            <Eye size={16} />
          </button>
          <button
            className="icon-btn"
            aria-label={"Download " + data.filename}
            title="Download original"
            onClick={() => context.download(data)}
          >
            <Download size={16} />
          </button>
          <button
            className="icon-btn hover:bg-rose-100 hover:text-rose-700"
            aria-label={"Remove " + data.filename}
            title={data.in_use ? "Used by a saved analysis" : "Remove"}
            disabled={data.in_use}
            onClick={() => context.remove(data)}
          >
            <Trash2 size={16} />
          </button>
        </span>
      ),
  },
];

export function DocumentsGrid({
  documents,
  query,
  actions,
  onKind,
}: {
  documents: Document[];
  query: string;
  actions: DocumentActions;
  onKind: (document: Document, kind: string) => void;
}) {
  return (
    <AgGridReact<Document>
      theme={theme}
      rowData={documents}
      columnDefs={documentColumns}
      defaultColDef={defaults}
      context={actions}
      quickFilterText={query}
      domLayout="autoHeight"
      suppressCellFocus
      stopEditingWhenCellsLoseFocus
      getRowId={(p) => p.data.id}
      onCellValueChanged={(e) =>
        e.colDef.field === "kind" &&
        e.newValue !== e.oldValue &&
        onKind(e.data, e.newValue)
      }
      overlayNoRowsTemplate="<span>No documents match.</span>"
    />
  );
}

type FindingRow = {
  index: number;
  request: string;
  category: string;
  finding: Finding;
};
const findingColumns: ColDef<FindingRow>[] = [
  {
    field: "index",
    headerName: "#",
    width: 64,
    valueFormatter: (p) => String(p.value).padStart(2, "0"),
  },
  {
    field: "request",
    headerName: "What the insurer raised",
    flex: 3,
    minWidth: 260,
    wrapText: true,
    autoHeight: true,
  },
  { field: "category", headerName: "Type", width: 160 },
  {
    headerName: "Your evidence",
    width: 200,
    valueGetter: (p) => p.data?.finding.evidence_status,
    cellRenderer: ({ value }: CustomCellRendererProps<FindingRow, string>) =>
      value ? <EvidenceChip value={value} /> : null,
  },
  {
    headerName: "Proof of receipt",
    width: 190,
    valueGetter: (p) => p.data?.finding.submission_status,
    cellRenderer: ({ value }: CustomCellRendererProps<FindingRow, string>) =>
      value ? <SubmissionChip value={value} /> : null,
  },
  {
    headerName: "Sources",
    width: 100,
    valueGetter: (p) => (p.data ? refsOf(p.data.finding).length : 0),
  },
  {
    headerName: "Review",
    width: 110,
    valueGetter: (p) => (p.data?.finding.review_required ? "Needed" : ""),
    cellRenderer: ({ value }: CustomCellRendererProps<FindingRow, string>) =>
      value ? (
        <span className="chip border-amber-200 bg-amber-50 text-amber-950">
          <Flag size={12} className="text-amber-500" aria-hidden="true" />
          {value}
        </span>
      ) : (
        <span className="text-muted">-</span>
      ),
  },
];

export function FindingsGrid({
  report,
  onPick,
}: {
  report: Report;
  onPick: (requestId: string) => void;
}) {
  const rows = report.findings.map((finding, i) => {
    const request = report.requests.find(
      (r) => r.request_id === finding.request_id,
    );
    return {
      index: i + 1,
      request: request?.text ?? "Evidence finding",
      category: CATEGORY[request?.category ?? ""] ?? "Request",
      finding,
    };
  });
  return (
    <div className="grid-clickable">
      <AgGridReact<FindingRow>
        theme={theme}
        rowData={rows}
        columnDefs={findingColumns}
        defaultColDef={defaults}
        domLayout="autoHeight"
        suppressCellFocus
        getRowId={(p) => p.data.finding.request_id}
        onRowClicked={(e) => e.data && onPick(e.data.finding.request_id)}
      />
    </div>
  );
}

const queueColumns: ColDef<QueueItem>[] = [
  {
    headerName: "Case",
    flex: 1,
    minWidth: 180,
    valueGetter: (p) => p.data?.case_title,
    cellRenderer: ({ data }: CustomCellRendererProps<QueueItem>) =>
      data && (
        <span className="min-w-0 leading-tight">
          <strong className="block truncate font-semibold">
            {data.case_title}
          </strong>
          <span className="text-xs text-muted">{data.claim_reference}</span>
        </span>
      ),
  },
  {
    field: "request",
    headerName: "Point to review",
    flex: 2,
    minWidth: 240,
    wrapText: true,
    autoHeight: true,
  },
  {
    headerName: "Evidence",
    width: 200,
    valueGetter: (p) => p.data?.finding.evidence_status,
    cellRenderer: ({ value }: CustomCellRendererProps<QueueItem, string>) =>
      value ? <EvidenceChip value={value} /> : null,
  },
  {
    headerName: "Decision",
    width: 190,
    valueGetter: (p) => p.data?.decisions.at(-1)?.decision ?? "",
    cellRenderer: ({ value }: CustomCellRendererProps<QueueItem, string>) =>
      value ? (
        <DecisionChip value={value} />
      ) : (
        <span className="chip border-violet-200 bg-violet-50 text-violet-900">
          Awaiting decision
        </span>
      ),
  },
  {
    field: "report_version",
    headerName: "Report",
    width: 100,
    valueFormatter: (p) => "v" + p.value,
  },
];

export function QueueGrid({
  items,
  onPick,
}: {
  items: QueueItem[];
  onPick: (item: QueueItem) => void;
}) {
  return (
    <div className="grid-clickable">
      <AgGridReact<QueueItem>
        theme={theme}
        rowData={items}
        columnDefs={queueColumns}
        defaultColDef={defaults}
        domLayout="autoHeight"
        suppressCellFocus
        getRowId={(p) => p.data.task_id}
        rowSelection={{
          mode: "singleRow",
          checkboxes: false,
          enableClickSelection: true,
        }}
        onRowClicked={(e) => e.data && onPick(e.data)}
        overlayNoRowsTemplate="<span>Nothing is waiting for review.</span>"
      />
    </div>
  );
}
