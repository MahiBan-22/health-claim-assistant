import { FileText, Search } from "lucide-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import type { Document } from "./types";
import { Badge, human } from "./ui";
ModuleRegistry.registerModules([AllCommunityModule]);
const gridTheme = themeQuartz.withParams({
  accentColor: "#546548",
  backgroundColor: "#ffffff",
  foregroundColor: "#343b34",
  borderColor: "#e8ebe5",
  headerBackgroundColor: "#f8f9f6",
  headerTextColor: "#747d70",
  fontFamily: "Inter, Segoe UI, sans-serif",
  fontSize: 13,
  headerFontSize: 11,
  rowHeight: 66,
  headerHeight: 42,
  wrapperBorder: false,
  spacing: 8,
});
const columns: ColDef<Document>[] = [
  {
    field: "filename",
    headerName: "DOCUMENT NAME",
    flex: 2,
    minWidth: 250,
    cellRenderer: ({ value }: { value: string }) => (
      <div className="document-cell">
        <span className="file-icon">
          <FileText size={19} />
        </span>
        <span className="truncate" title={value}>
          {value}
        </span>
      </div>
    ),
  },
  {
    field: "kind",
    headerName: "CATEGORY",
    flex: 1,
    minWidth: 170,
    valueFormatter: (p) => human(p.value),
  },
  {
    field: "version",
    headerName: "VERSION",
    width: 105,
    valueFormatter: (p) => "v" + p.value,
  },
  {
    field: "extraction_status",
    headerName: "EXTRACTION",
    minWidth: 150,
    flex: 1,
    cellRenderer: ({ value }: { value: string }) => <Badge value={value} />,
  },
];
export default function EvidenceGrid({
  documents,
  query,
  setQuery,
}: {
  documents: Document[];
  query: string;
  setQuery: (value: string) => void;
}) {
  return (
    <>
      <div className="grid-toolbar">
        <div>
          <h2>
            Evidence library <span className="count">{documents.length}</span>
          </h2>
          <p>The source of truth for this claim.</p>
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search evidence"
            placeholder="Search documents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="evidence-grid">
        <AgGridReact<Document>
          theme={gridTheme}
          rowData={documents}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          quickFilterText={query}
          getRowId={(p) => p.data.id}
          overlayNoRowsTemplate="<span>No evidence yet. Upload a PDF or text document to get started.</span>"
        />
      </div>
      <div className="grid-footer">
        {documents.length} document{documents.length !== 1 ? "s" : ""} · All
        versions preserved<span>Sort and filter using column headers</span>
      </div>
    </>
  );
}
