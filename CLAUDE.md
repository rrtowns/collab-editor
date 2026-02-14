# CLAUDE.md

## Development Commands

- `npm install` — install dependencies
- `npm start` — run server on port 3456 (configurable via `PORT` env var)
- Requires `ANTHROPIC_API_KEY` environment variable
- No build step, no linting, no test framework configured

## Architecture

- **Backend**: `server.js` — Express server with SQLite persistence and REST API
- **Frontend**: `public/index.html` — self-contained SPA (embedded CSS + vanilla JS) with centralized `state` object and declarative `render()` function
- **Database**: SQLite via `better-sqlite3`, stored at `./data/collab-editor.db` (WAL mode). Single `documents` table with JSON `content` column
- **Model**: Claude model configured in `ALLOWED_MODELS` array in `server.js`
- ES Modules throughout (`"type": "module"`)

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/documents` | List all docs (id, title, timestamps) |
| `POST` | `/api/documents` | Create new doc |
| `GET` | `/api/documents/:id` | Load full doc with parsed content |
| `PUT` | `/api/documents/:id` | Update doc (autosave target) |
| `DELETE` | `/api/documents/:id` | Delete a doc |
| `POST` | `/api/revise` | Send document + comments to Claude for revision |

## Key Concepts

- Document is stored as paragraphs, each containing segments of type `"text"` or `"change"`
- Comments attach to text selections with paragraph index + character offsets
- Revision flow: user selects text → adds comment → requests revision → Claude returns `{paraIndex, oldText, newText}` changes → user accepts/rejects inline
- **Autosave**: 1.5s debounce after any mutation; saves full state as JSON to SQLite via `PUT /api/documents/:id`
- **URL routing**: `?doc=ID` query param; `history.replaceState` keeps URL in sync
- **Document list**: shown on home screen when no doc is open; sorted by last updated
- Frontend uses string-based HTML generation and direct DOM manipulation (no framework)
