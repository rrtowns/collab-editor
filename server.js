import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Database Setup ─────────────────────────────────────
const dataDir = join(__dirname, "data");
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, "collab-editor.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const stmts = {
  listDocs: db.prepare("SELECT id, title, created_at, updated_at FROM documents ORDER BY updated_at DESC"),
  getDoc: db.prepare("SELECT * FROM documents WHERE id = ?"),
  createDoc: db.prepare("INSERT INTO documents (title, content) VALUES (?, ?)"),
  updateDoc: db.prepare("UPDATE documents SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?"),
  deleteDoc: db.prepare("DELETE FROM documents WHERE id = ?"),
};

// ── Express Setup ──────────────────────────────────────
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3456;

const ALLOWED_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
];

// ── Document API ───────────────────────────────────────
app.get("/api/documents", (req, res) => {
  const docs = stmts.listDocs.all();
  const docsWithPreview = docs.map(doc => {
    let preview = "";
    try {
      const raw = stmts.getDoc.get(doc.id);
      if (raw && raw.content) {
        const content = JSON.parse(raw.content);
        if (content.paragraphs) {
          const text = content.paragraphs
            .map(p => p.segments.map(s => s.type === "text" ? s.content : (s.oldContent || "")).join(""))
            .join(" ");
          preview = text.slice(0, 120);
        }
      }
    } catch {}
    return { ...doc, preview };
  });
  res.json(docsWithPreview);
});

app.post("/api/documents", (req, res) => {
  const { title, content } = req.body;
  const result = stmts.createDoc.run(
    title || "Untitled",
    JSON.stringify(content || {})
  );
  const doc = stmts.getDoc.get(result.lastInsertRowid);
  res.json({ id: doc.id, title: doc.title, created_at: doc.created_at, updated_at: doc.updated_at });
});

app.get("/api/documents/:id", (req, res) => {
  const doc = stmts.getDoc.get(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  let content;
  try { content = JSON.parse(doc.content); } catch { content = {}; }
  res.json({ id: doc.id, title: doc.title, content, created_at: doc.created_at, updated_at: doc.updated_at });
});

app.put("/api/documents/:id", (req, res) => {
  const { title, content } = req.body;
  const existing = stmts.getDoc.get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Document not found" });
  stmts.updateDoc.run(
    title ?? existing.title,
    content !== undefined ? JSON.stringify(content) : existing.content,
    req.params.id
  );
  const doc = stmts.getDoc.get(req.params.id);
  res.json({ id: doc.id, title: doc.title, updated_at: doc.updated_at });
});

app.delete("/api/documents/:id", (req, res) => {
  const existing = stmts.getDoc.get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Document not found" });
  stmts.deleteDoc.run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/revise", async (req, res) => {
  const { paragraphs, comments, model, globalInstruction, attachments } = req.body;

  if (!paragraphs || (!comments?.length && !globalInstruction?.trim())) {
    return res.status(400).json({ error: "Missing paragraphs or revision instructions" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY not set. Run: export ANTHROPIC_API_KEY=your-key",
    });
  }

  const client = new Anthropic({ apiKey });

  // Build the prompt
  let docDescription = "";
  paragraphs.forEach((para, i) => {
    const paraComments = (comments || []).filter((c) => c.paraIndex === i);
    docDescription += `Paragraph ${i + 1}: ${para}\n`;
    if (paraComments.length > 0) {
      paraComments.forEach((c) => {
        docDescription += `  → Comment on "${c.selectedText}": ${c.comment}\n`;
      });
    }
    docDescription += "\n";
  });

  if (globalInstruction?.trim()) {
    docDescription += `\nGlobal instruction (apply to the ENTIRE document): ${globalInstruction.trim()}\n`;
  }

  const systemPrompt = `You are a collaborative writing assistant. The user will provide a document with inline comments on specific words, phrases, or sentences, and/or a global instruction that applies to the entire document. Reference documents (such as style guides or source material) may be attached as PDF files — use them as context when making revisions. Your job is to suggest revisions based on these inputs.

Return a JSON array of changes. Each change must specify:
- "paraIndex": the 0-based paragraph index
- "oldText": the EXACT text to replace (copy it precisely from the paragraph, character for character)
- "newText": the replacement text

Rules:
- For inline comments: only modify the commented text. Keep changes minimal and targeted.
- For global instructions: apply the instruction across all paragraphs as appropriate. Each change should still be a targeted replacement of a specific substring.
- The "oldText" must be an exact substring of the paragraph text.
- If a comment asks you to change/replace/rewrite specific text, revise just that text.
- If a comment gives a general instruction (e.g. "make more vivid"), apply it to the commented span only.
- If there is both a global instruction and inline comments, apply both.

Return ONLY valid JSON. No markdown, no explanation, no code fences. Just the JSON array.

Example response:
[{"paraIndex": 2, "oldText": "walked slowly", "newText": "ambled"}]`;

  const selectedModel = ALLOWED_MODELS.includes(model) ? model : ALLOWED_MODELS[0];
  console.log(`  → Using model: ${selectedModel}`);

  try {
    const message = await client.messages.create({
      model: selectedModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            ...(attachments || []).map(a => ({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: a.base64 },
            })),
            { type: "text", text: `Here is my document with comments. Please suggest revisions:\n\n${docDescription}` },
          ],
        },
      ],
    });

    const responseText = message.content[0].text.trim();

    // Parse JSON — handle possible markdown fences
    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const changes = JSON.parse(jsonStr);

    // Validate changes
    const validChanges = changes.filter((c) => {
      if (
        typeof c.paraIndex !== "number" ||
        typeof c.oldText !== "string" ||
        typeof c.newText !== "string"
      )
        return false;
      if (c.paraIndex < 0 || c.paraIndex >= paragraphs.length) return false;
      if (!paragraphs[c.paraIndex].includes(c.oldText)) return false;
      return true;
    });

    res.json({ changes: validChanges });
  } catch (err) {
    console.error("Claude API error:", err);
    res.status(500).json({
      error: err.message || "Failed to get revision from Claude",
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Collaborative Editor running at http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "  ⚠ ANTHROPIC_API_KEY not set. Run:\n    export ANTHROPIC_API_KEY=your-key\n"
    );
  }
});
