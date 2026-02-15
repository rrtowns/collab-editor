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

function normalizeLooseChar(ch) {
  if (ch === "\u2018" || ch === "\u2019" || ch === "\u0060" || ch === "\u00B4") return "'";
  if (ch === "\u201C" || ch === "\u201D") return "\"";
  if (ch === "\u2013" || ch === "\u2014" || ch === "\u2212") return "-";
  if (ch === "\u00A0") return " ";
  return ch;
}

function buildLooseTextWithSpans(text) {
  const out = [];
  const spans = [];

  let i = 0;
  while (i < text.length) {
    let ch = normalizeLooseChar(text[i]);

    if (/\s/.test(ch)) {
      const runStart = i;
      i++;
      while (i < text.length) {
        const next = normalizeLooseChar(text[i]);
        if (!/\s/.test(next)) break;
        i++;
      }
      if (out.length === 0 || out[out.length - 1] !== " ") {
        out.push(" ");
        spans.push({ start: runStart, end: i });
      }
      continue;
    }

    out.push(ch);
    spans.push({ start: i, end: i + 1 });
    i++;
  }

  return { text: out.join(""), spans };
}

function resolveOldTextFromParagraph(paraText, proposedOldText, paraComments) {
  if (!paraText || typeof paraText !== "string") return null;
  if (typeof proposedOldText === "string" && proposedOldText.length > 0 && paraText.includes(proposedOldText)) {
    return proposedOldText;
  }

  if (typeof proposedOldText === "string" && proposedOldText.length > 0) {
    const paraLoose = buildLooseTextWithSpans(paraText);
    const oldLoose = buildLooseTextWithSpans(proposedOldText).text.trim();
    if (oldLoose.length > 0) {
      const searchIn = paraLoose.text;
      const looseIdx = searchIn.indexOf(oldLoose);
      if (looseIdx !== -1) {
        const startSpan = paraLoose.spans[looseIdx];
        const endSpan = paraLoose.spans[looseIdx + oldLoose.length - 1];
        if (startSpan && endSpan && endSpan.end > startSpan.start) {
          return paraText.slice(startSpan.start, endSpan.end);
        }
      }
    }
  }

  const paraCommentList = Array.isArray(paraComments) ? paraComments : [];
  if (paraCommentList.length === 1) {
    const c = paraCommentList[0];

    if (
      Number.isInteger(c?.start) &&
      Number.isInteger(c?.end) &&
      c.start >= 0 &&
      c.end > c.start &&
      c.end <= paraText.length
    ) {
      const slice = paraText.slice(c.start, c.end);
      if (slice.length > 0) return slice;
    }

    if (typeof c?.selectedText === "string" && c.selectedText.length > 0 && paraText.includes(c.selectedText)) {
      return c.selectedText;
    }
  }

  return null;
}

function formatPromptCommentLine(comment) {
  const selectedText = typeof comment?.selectedText === "string" ? comment.selectedText : "";
  const instruction = typeof comment?.comment === "string" ? comment.comment : "";
  const hasSpan = Number.isInteger(comment?.start) && Number.isInteger(comment?.end) && comment.end > comment.start;
  const spanSuffix = hasSpan ? ` [chars ${comment.start}-${comment.end}]` : "";
  return `  → Comment on "${selectedText}"${spanSuffix}: ${instruction}\n`;
}

function findUniqueParagraphByExactText(paragraphLookup, validIndices, text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const matches = [];
  for (const idx of validIndices) {
    const paraText = paragraphLookup.get(idx);
    if (typeof paraText === "string" && paraText.includes(text)) matches.push(idx);
    if (matches.length > 1) return null;
  }
  return matches.length === 1 ? matches[0] : null;
}

function findUniqueParagraphByLooseText(paragraphLookup, validIndices, text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const target = buildLooseTextWithSpans(text).text.trim();
  if (!target) return null;

  const matches = [];
  for (const idx of validIndices) {
    const paraText = paragraphLookup.get(idx);
    if (typeof paraText !== "string" || paraText.length === 0) continue;
    const paraLoose = buildLooseTextWithSpans(paraText).text;
    if (paraLoose.includes(target)) matches.push(idx);
    if (matches.length > 1) return null;
  }
  return matches.length === 1 ? matches[0] : null;
}

function remapUnresolvedChange(change, context) {
  const { paragraphLookup, validIndices, commentsByPara, allComments } = context;

  // Strongest anchor: if there is exactly one inline comment, honor that anchor.
  if (Array.isArray(allComments) && allComments.length === 1) {
    const anchor = allComments[0];
    const anchorParaText = paragraphLookup.get(anchor.paraIndex);
    const anchored = resolveOldTextFromParagraph(
      anchorParaText,
      change.oldText,
      commentsByPara.get(anchor.paraIndex) || [anchor]
    ) || resolveOldTextFromParagraph(
      anchorParaText,
      anchor.selectedText,
      commentsByPara.get(anchor.paraIndex) || [anchor]
    );
    if (anchored) {
      return {
        paraIndex: anchor.paraIndex,
        oldText: anchored,
        reason: "single-comment-anchor",
      };
    }
  }

  // If oldText uniquely appears in one included paragraph, remap there.
  const exactIdx = findUniqueParagraphByExactText(paragraphLookup, validIndices, change.oldText);
  if (exactIdx !== null) {
    const paraText = paragraphLookup.get(exactIdx);
    const resolved = resolveOldTextFromParagraph(paraText, change.oldText, commentsByPara.get(exactIdx) || []);
    if (resolved) return { paraIndex: exactIdx, oldText: resolved, reason: "unique-exact" };
  }

  // Fallback: unique loose-normalized match.
  const looseIdx = findUniqueParagraphByLooseText(paragraphLookup, validIndices, change.oldText);
  if (looseIdx !== null) {
    const paraText = paragraphLookup.get(looseIdx);
    const resolved = resolveOldTextFromParagraph(paraText, change.oldText, commentsByPara.get(looseIdx) || []);
    if (resolved) return { paraIndex: looseIdx, oldText: resolved, reason: "unique-loose" };
  }

  return null;
}

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
  const { paragraphs, comments, model, globalInstruction, attachments, focusedMode, paragraphMap, scopeMode } = req.body;

  const hasParagraphs = focusedMode ? paragraphMap?.length > 0 : paragraphs?.length > 0;
  if (!hasParagraphs || (!comments?.length && !globalInstruction?.trim())) {
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

  // Track valid indices for validation
  let validIndices;
  let paragraphLookup; // index → text
  const commentsByPara = new Map();

  for (const c of comments || []) {
    if (!c || typeof c.paraIndex !== "number") continue;
    if (!commentsByPara.has(c.paraIndex)) commentsByPara.set(c.paraIndex, []);
    commentsByPara.get(c.paraIndex).push(c);
  }

  if (focusedMode && paragraphMap) {
    // Focused mode: only include paragraphs from paragraphMap, labeled by real index
    validIndices = new Set(paragraphMap.map(p => p.index));
    paragraphLookup = new Map(paragraphMap.map(p => [p.index, p.text]));

    paragraphMap.forEach(({ index, text }) => {
      const paraComments = commentsByPara.get(index) || [];
      docDescription += `Paragraph ${index + 1}: ${text}\n`;
      if (paraComments.length > 0) {
        paraComments.forEach((c) => {
          docDescription += formatPromptCommentLine(c);
        });
      }
      docDescription += "\n";
    });

    const subsetScope = (scopeMode === "section" || scopeMode === "subsection") ? scopeMode : "focused";
    console.log(`  → ${subsetScope} subset mode: sending ${paragraphMap.length} of document's paragraphs (indices: ${paragraphMap.map(p => p.index).join(", ")})`);
  } else {
    // Full mode: include all paragraphs sequentially
    validIndices = new Set(paragraphs.map((_, i) => i));
    paragraphLookup = new Map(paragraphs.map((text, i) => [i, text]));

    paragraphs.forEach((para, i) => {
      const paraComments = commentsByPara.get(i) || [];
      docDescription += `Paragraph ${i + 1}: ${para}\n`;
      if (paraComments.length > 0) {
        paraComments.forEach((c) => {
          docDescription += formatPromptCommentLine(c);
        });
      }
      docDescription += "\n";
    });

    console.log(`  → Full mode: sending all ${paragraphs.length} paragraphs`);
  }

  if (globalInstruction?.trim()) {
    docDescription += `\nGlobal instruction (apply to the ENTIRE document): ${globalInstruction.trim()}\n`;
  }

  let systemPrompt = `You are a collaborative writing assistant. The user will provide a document with inline comments on specific words, phrases, or sentences, and/or a global instruction that applies to the entire document. Reference files (such as style guides or source material) may be attached as PDF or text files — use them as context when making revisions. Your job is to suggest revisions based on these inputs.

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
- If a comment includes quoted selected text, use that exact selected text as "oldText" unless the user explicitly asks for a wider rewrite.
- If there is both a global instruction and inline comments, apply both.

Return ONLY valid JSON. No markdown, no explanation, no code fences. Just the JSON array.

Example response:
[{"paraIndex": 2, "oldText": "walked slowly", "newText": "ambled"}]`;

  if (focusedMode && paragraphMap) {
    const subsetScope = (scopeMode === "section" || scopeMode === "subsection") ? scopeMode : "focused";
    systemPrompt += `\n\nNote: You are seeing a ${subsetScope} subset of paragraphs from a larger document. The paragraph numbers are their positions in the full document. Only suggest changes to the paragraphs shown.`;
  }

  const selectedModel = ALLOWED_MODELS.includes(model) ? model : ALLOWED_MODELS[0];
  console.log(`  → Using model: ${selectedModel}`);

  try {
    const MAX_TEXT_FILE_CHARS = 50000;
    const fileBlocks = [];
    let pdfCount = 0;
    let textFileCount = 0;

    for (const a of attachments || []) {
      if (!a || typeof a !== "object") continue;

      if (typeof a.base64 === "string" && a.base64.length > 0) {
        fileBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: a.mimeType || "application/pdf",
            data: a.base64,
          },
        });
        pdfCount++;
        continue;
      }

      if (typeof a.text === "string" && a.text.trim().length > 0) {
        const fileName = typeof a.name === "string" && a.name.trim().length > 0 ? a.name.trim() : "Text file";
        let textContent = a.text;
        if (textContent.length > MAX_TEXT_FILE_CHARS) {
          textContent = `${textContent.slice(0, MAX_TEXT_FILE_CHARS)}\n\n[File truncated to ${MAX_TEXT_FILE_CHARS} characters.]`;
        }
        fileBlocks.push({
          type: "text",
          text: `Reference file (${fileName}):\n${textContent}`,
        });
        textFileCount++;
      }
    }

    if (pdfCount > 0 || textFileCount > 0) {
      console.log(`  → Reference files: ${pdfCount} PDF, ${textFileCount} text`);
    }

    const message = await client.messages.create({
      model: selectedModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            ...fileBlocks,
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

    const parsed = JSON.parse(jsonStr);
    const changes = Array.isArray(parsed) ? parsed : [];

    // Validate and repair oldText when Claude is close-but-not-exact.
    const validChanges = [];
    let repairedCount = 0;
    let droppedCount = 0;
    let remappedCount = 0;
    const dropStats = {
      invalidShape: 0,
      invalidIndex: 0,
      missingParagraph: 0,
      unresolvedOldText: 0,
    };

    for (const c of changes) {
      if (
        typeof c?.paraIndex !== "number" ||
        typeof c?.oldText !== "string" ||
        typeof c?.newText !== "string"
      ) {
        dropStats.invalidShape++;
        droppedCount++;
        continue;
      }
      if (!validIndices.has(c.paraIndex)) {
        dropStats.invalidIndex++;
        droppedCount++;
        continue;
      }

      let targetParaIndex = c.paraIndex;
      let paraText = paragraphLookup.get(targetParaIndex);
      if (typeof paraText !== "string" || paraText.length === 0) {
        dropStats.missingParagraph++;
        droppedCount++;
        continue;
      }

      let resolvedOldText = resolveOldTextFromParagraph(
        paraText,
        c.oldText,
        commentsByPara.get(targetParaIndex) || []
      );
      if (!resolvedOldText) {
        const remapped = remapUnresolvedChange(c, {
          paragraphLookup,
          validIndices,
          commentsByPara,
          allComments: comments || [],
        });
        if (remapped && validIndices.has(remapped.paraIndex)) {
          targetParaIndex = remapped.paraIndex;
          paraText = paragraphLookup.get(targetParaIndex);
          resolvedOldText = remapped.oldText;
          remappedCount++;
          console.log(
            `  → Remapped change from para ${c.paraIndex} to ${targetParaIndex} (${remapped.reason})`
          );
        }
      }

      if (!resolvedOldText) {
        dropStats.unresolvedOldText++;
        console.log(
          `  → Dropped change at para ${c.paraIndex}: oldText not resolved. ` +
          `oldText="${String(c.oldText).slice(0, 120)}"`
        );
        droppedCount++;
        continue;
      }

      if (resolvedOldText !== c.oldText) repairedCount++;
      validChanges.push({
        paraIndex: targetParaIndex,
        oldText: resolvedOldText,
        newText: c.newText,
      });
    }

    if (repairedCount > 0 || droppedCount > 0 || remappedCount > 0) {
      console.log(
        `  → Revision validation: ${validChanges.length} accepted, ${repairedCount} repaired, ` +
        `${remappedCount} remapped, ${droppedCount} dropped`
      );
      if (droppedCount > 0) {
        console.log(
          `  → Drop reasons: invalidShape=${dropStats.invalidShape}, invalidIndex=${dropStats.invalidIndex}, ` +
          `missingParagraph=${dropStats.missingParagraph}, unresolvedOldText=${dropStats.unresolvedOldText}`
        );
      }
    }

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
