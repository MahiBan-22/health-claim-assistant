# Claimwise frontend

React and TypeScript workspace styled with Tailwind CSS v4 through the Vite plugin. AG Grid Community provides document sorting, column filters, resizing, and full-text search. The grid is loaded on demand after sign-in. Icons are provided by Lucide; fonts use the system stack without remote requests.

## Development

Run `npm ci`, then `npm run dev -- --host 127.0.0.1` from this directory, or use the repository's native startup script. The API is expected at http://127.0.0.1:8000. Restart Vite when first adding its Tailwind plugin.

Use the local or reviewer access token to unlock the workspace. Tokens remain in memory. Case selection opens the evidence library; analysis history stays available during active runs. Analysis updates use the existing authenticated event stream. Reports, source citations, exports, and reviewer actions use the existing backend endpoints.

## Validation

- `npm run build` checks TypeScript and creates production assets.
- With Vite running at http://127.0.0.1:5173, run `npm run test:e2e`. Tests use headless Microsoft Edge and intercepted fictional API responses; they do not modify real claims or invoke an LLM. Screenshots are saved in ignored `test-results/`.

Browser checks cover evidence search, analysis history, report navigation, source inspection, review submission, mobile overflow, dialog keyboard dismissal, initial focus, and focus restoration.

## Components

- `src/main.tsx`: application state, authentication, live updates, and screens.
- `src/ui.tsx`: shared status badges and native modal dialogs.
- `src/EvidenceGrid.tsx`: lazy-loaded AG Grid document library.
- `src/style.css`: design tokens, component styling, and responsive layouts.
