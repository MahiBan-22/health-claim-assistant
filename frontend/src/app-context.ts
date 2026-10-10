import { createContext, useContext } from "react";
import type {
  ClaimCase,
  Connection,
  Document,
  Ref,
  SystemStatus,
} from "./types";

export type Route =
  | { view: "home" }
  | { view: "case"; caseId: string }
  | { view: "report"; caseId: string; reportId: string }
  | { view: "workflow"; caseId: string; runId: string }
  | { view: "review" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "case" && parts[1]) {
    if (parts[2] === "workflow" && parts[3])
      return { view: "workflow", caseId: parts[1], runId: parts[3] };
    return parts[2] === "report" && parts[3]
      ? { view: "report", caseId: parts[1], reportId: parts[3] }
      : { view: "case", caseId: parts[1] };
  }
  return parts[0] === "review" ? { view: "review" } : { view: "home" };
}
export function routeHash(route: Route) {
  if (route.view === "case") return "#/case/" + route.caseId;
  if (route.view === "report")
    return "#/case/" + route.caseId + "/report/" + route.reportId;
  if (route.view === "workflow")
    return "#/case/" + route.caseId + "/workflow/" + route.runId;
  return route.view === "review" ? "#/review" : "#/";
}

export type Dialog =
  | { type: "case" }
  | { type: "rename"; item: ClaimCase }
  | { type: "upload" }
  | { type: "connection" }
  | { type: "system" }
  | { type: "glossary" }
  | {
      type: "document";
      caseId: string;
      documentId: string;
      quote?: string;
      page?: number;
    };

export type App = {
  busy: boolean;
  /** Runs an action with a shared busy flag; failures surface as a message instead of throwing. */
  act: (action: () => Promise<void>) => Promise<boolean>;
  notify: (text: string) => void;
  fail: (text: string) => void;
  go: (route: Route) => void;
  open: (dialog: Dialog | null) => void;
  cite: (caseId: string, ref: Ref) => void;
  reviewer: boolean;
  reviewerName: string;
  system: SystemStatus | null;
  connection: Connection | null;
  /** True when ChatGPT is connected and the configured model is listed for the account. */
  ready: boolean;
};

export const AppContext = createContext<App | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("App context is missing");
  return value;
}

/** Claim references found in the newest documents that differ from the case's own reference. */
export function foreignReferences(item: ClaimCase, documents: Document[]) {
  const found = new Set<string>();
  for (const document of documents)
    if (document.is_latest !== false)
      for (const reference of document.claim_references ?? [])
        if (reference.toLowerCase() !== item.claim_reference.toLowerCase())
          found.add(reference);
  return [...found];
}
