# Collaborative Editor

A local document editor where you highlight text, leave comments, and Claude applies inline revisions — no copy-paste needed.

## Setup

**1. Get an API key**

Go to [console.anthropic.com](https://console.anthropic.com/) → API Keys → Create Key

**2. Install and run**

```bash
cd collab-editor
npm install
export ANTHROPIC_API_KEY=sk-ant-...your-key...
npm start
```

**3. Open in your browser**

```
http://localhost:3456
```

## How it works

1. **Select any text** — a word, phrase, or sentence — and a comment box appears
2. **Write your note** — e.g. "make this more vivid", "change this word", "too formal"
3. **Click "Request Revision"** — Claude reads your document + comments and returns targeted inline changes
4. **Accept or reject** each change individually with the ✓ ✕ buttons, or use Accept All / Reject All

Changes are applied at exactly the granularity you commented on. Comment on one word and only that word changes. Comment on a sentence and only that sentence changes.

## Customizing

- **Model**: Edit `server.js` to change the Claude model (default: `claude-sonnet-4-5-20250929`)
- **Port**: Set `PORT` environment variable (default: 3456)
- **Document**: Edit the `paragraphs` array in `public/index.html` to load your own text

## Tips

- You can have multiple comments before requesting a revision — Claude handles them all in one pass
- After accepting/rejecting changes, add new comments and request another round
- The revision prompt asks Claude to change *only* the commented text, keeping everything else intact
