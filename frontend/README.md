# Claimwise frontend

React and TypeScript workspace styled with Tailwind CSS v4 through the Vite plugin. AG Grid Community provides the document, findings and review-queue tables, loaded on demand. Icons are provided by Lucide; fonts use the system stack without remote requests.

## Development

Run `npm ci`, then `npm run dev -- --host 127.0.0.1` from this directory, or use the repository's native startup script. The API is expected at http://127.0.0.1:8000; set `VITE_API_BASE` to point elsewhere.

There is no login. The workspace opens on the home screen. The address keeps your place (`#/case/<id>`, `#/case/<id>/report/<id>`, `#/review`), so a reload returns to the same screen. Analysis updates arrive over a server-sent event stream with bounded reconnects. Reviewer mode is a sidebar switch that adds the `X-Workspace-Role: reviewer` header; the choice and the reviewer name are remembered in local storage.

## Screens

- **My claims**: claims with document, analysis and report counts, and the sample scenarios.
- **Claim workspace**: progress steps, documents (drag-and-drop upload, suggested categories that can be corrected in the grid, versions, page viewer), a timeline of dated lines, analysis history and the next best step.
- **Evidence report**: a headline count, a status bar, findings with citations that open the source page at the quoted passage, comparison with the previous report, a next-step checklist, an editable reply letter and the ZIP response package.
- **Review desk**: findings that need a person across all claims, with a decision form and decision history.

## Validation

- `npm run build` checks TypeScript and creates production assets.
- With Vite running at http://127.0.0.1:5173, run `npm run test:e2e`. Tests use headless Chrome and intercepted fictional API responses; they do not modify real claims or invoke an LLM. Screenshots are saved in ignored `test-results/`.

Browser tests cover opening without a login, document search, timeline, analysis history, the report, citation viewing and closing, the checklist and letter saves, a reviewer decision, mobile overflow, dialog focus and the glossary.

## Components

- `src/App.tsx`: routing, data loading, live updates, ChatGPT connection and the shell.
- `src/app-context.ts`: routes, dialog types and the shared app context.
- `src/api.ts`: fetch helpers, file saving and the event stream reader.
- `src/lib.ts`: status meanings, category labels and the glossary.
- `src/ui.tsx`: status chips, dialogs, messages and the status bar.
- `src/grids.tsx`: AG Grid tables.
- `src/dialogs.tsx`: claim, upload, document, connection, system and glossary dialogs.
- `src/screens/`: the four screens.
- `src/style.css`: design tokens and a small set of component classes.
