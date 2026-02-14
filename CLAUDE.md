# CLAUDE.md

## Development Commands

- `npm install` — install dependencies
- `npm start` — run server on port 3456 (configurable via `PORT` env var)
- Requires `ANTHROPIC_API_KEY` environment variable
- No build step, no linting, no test framework configured

## Architecture

- **Backend**: `server.js` — Express server with single `POST /api/revise` endpoint that sends document + comments to Claude and returns structured JSON changes
- **Frontend**: `public/index.html` — self-contained SPA (embedded CSS + vanilla JS) with centralized `state` object and declarative `render()` function
- **Model**: Claude model configured on line 65 of `server.js` (currently `claude-sonnet-4-5-20250929`)
- **No database** — all state lives in browser memory during session
- ES Modules throughout (`"type": "module"`)

## Key Concepts

- Document is stored as paragraphs, each containing segments of type `"text"` or `"change"`
- Comments attach to text selections with paragraph index + character offsets
- Revision flow: user selects text → adds comment → requests revision → Claude returns `{paraIndex, oldText, newText}` changes → user accepts/rejects inline
- Frontend uses string-based HTML generation and direct DOM manipulation (no framework)
