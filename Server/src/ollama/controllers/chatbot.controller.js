import fs from "fs";
import path from "path";
import csvParser from "csv-parser";

import { ChatOllama } from "@langchain/ollama";
import { initializeDatabase } from "../../config/sqlite.js";

const model = new ChatOllama({
    model: "llama3.2:3b",
    temperature: 0
})

// Helper: Insert CSV into DB
export async function insertCSVToDB(filePath, { topicId = null, originalName = null } = {}) {
    const db = await initializeDatabase();

    // Helper to create safe SQL identifiers for table/column names
    function sanitizeIdentifier(name, fallback) {
        if (!name) return fallback;
        // Replace non-alphanumeric/underscore with underscore
        let s = String(name).replace(/[^A-Za-z0-9_]/g, '_');
        // Ensure it doesn't start with a digit
        if (/^[0-9]/.test(s)) s = `c_${s}`;
        // Empty after cleanup -> fallback
        return s || fallback;
    }

    const rows = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csvParser())
            .on("data", (row) => rows.push(row))
            .on("end", async () => {
                try {
                    if (rows.length === 0) return resolve({ inserted: 0 });

                    // Determine table name from filename (safe)
                    const base = path.basename(filePath, path.extname(filePath));
                    const tableName = sanitizeIdentifier(`doc_${base}_${Date.now()}`, 'doc_uploaded');

                    // Determine columns from header (first row) and sanitize them
                    const headerCols = Object.keys(rows[0]);
                    const cols = headerCols.map((c, i) => sanitizeIdentifier(c, `col_${i}`));

                    // Build CREATE TABLE statement with TEXT columns
                    const quotedCols = cols.map(c => `"${c}" TEXT`).join(', ');
                    const createSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${quotedCols})`;
                    await db.run(createSql);

                    // Prepare INSERT statement
                    const placeholders = cols.map(() => '?').join(', ');
                    const insertSql = `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;

                    // Insert each row, converting missing values to empty string
                    let inserted = 0;
                    const insertStmt = await db.prepare(insertSql);
                    for (const r of rows) {
                        const values = headerCols.map(h => (r[h] ?? '').toString());
                        await insertStmt.run(values);
                        inserted++;

                        // Also index the row into the documents FTS5 table so it becomes searchable
                        const combined = values.join(' ');
                        // Use tableName as title for traceability
                        await db.run(`INSERT INTO documents (title, content) VALUES (?, ?)`, [tableName, combined]);
                    }
                    await insertStmt.finalize?.();

                    // store manifest linking table to topic and schema
                    try {
                        await db.run(`INSERT INTO uploaded_tables (topic_id, table_name, original_name, schema_json) VALUES (?, ?, ?, ?)`,
                            [topicId, tableName, originalName || base, JSON.stringify(cols)]);
                    } catch (e) {
                        // non-fatal: log and continue
                        console.warn('Failed to write uploaded_tables manifest', e?.message ?? e);
                    }

                    resolve({ inserted, table: tableName, columns: cols });
                } catch (err) {
                    reject(err);
                }
            })
            .on("error", reject);
    });
}

// Get uploaded table manifests for a topic
export async function getSchemasByTopic(topicId) {
    const db = await initializeDatabase();
    const rows = await db.all(`SELECT id, topic_id, table_name, original_name, schema_json, created_at FROM uploaded_tables WHERE topic_id = ? ORDER BY created_at DESC`, [topicId]);
    return rows.map(r => ({
        id: r.id,
        topic_id: r.topic_id,
        table_name: r.table_name,
        original_name: r.original_name,
        schema: JSON.parse(r.schema_json || '[]'),
        created_at: r.created_at
    }));
}

export async function getTableSchema(tableName) {
    const db = await initializeDatabase();
    const row = await db.get(`SELECT id, topic_id, table_name, original_name, schema_json, created_at FROM uploaded_tables WHERE table_name = ? LIMIT 1`, [tableName]);
    if (!row) return null;
    return {
        id: row.id,
        topic_id: row.topic_id,
        table_name: row.table_name,
        original_name: row.original_name,
        schema: JSON.parse(row.schema_json || '[]'),
        created_at: row.created_at
    };
}

// Simple column-picker: try to map question tokens to column names; fall back to all columns.
function pickColumnsForQuestion(columns, question) {
    if (!columns || columns.length === 0) return [];
    if (!question) return columns;

    const q = String(question).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return columns;

    const picked = new Set();
    for (const col of columns) {
        const lc = String(col).toLowerCase();
        for (const t of tokens) {
            if (lc.includes(t) || t.includes(lc)) {
                picked.add(col);
                break;
            }
        }
    }
    // if nothing matched, return all columns to be safe
    return picked.size ? Array.from(picked) : columns;
}

// Query uploaded tables linked to a topic using a question to select columns
export async function queryUploadedData(topicId, question, { limit = 50 } = {}) {
    const db = await initializeDatabase();
    const manifests = await db.all(`SELECT table_name, schema_json FROM uploaded_tables WHERE topic_id = ? ORDER BY created_at DESC`, [topicId]);
    const results = [];
    for (const m of manifests) {
        const table = m.table_name;
        const cols = JSON.parse(m.schema_json || '[]');
        const selected = pickColumnsForQuestion(cols, question);
        const colsSql = selected.map(c => `"${c}"`).join(', ');
        const safeTable = String(table).replace(/[^A-Za-z0-9_]/g, '_');
        try {
            const rows = await db.all(`SELECT ${colsSql} FROM "${safeTable}" LIMIT ?`, [limit]);
            results.push({ table: safeTable, columns: selected, rows });
        } catch (e) {
            results.push({ table: safeTable, columns: selected, error: e.message });
        }
    }
    return results;
}

// Plan and execute a data query for a topic using the SLM to decide what to pull.
// The SLM is asked to return a JSON plan describing table, select columns (or aggregates),
// filters, group_by and limit. We validate the plan against stored schema and then run a
// parameterized SQL query to fetch results.
export async function planAndRunDataQuery(topicId, question, { limit = 100 } = {}) {
    const db = await initializeDatabase();
    const manifests = await db.all(`SELECT table_name, schema_json FROM uploaded_tables WHERE topic_id = ? ORDER BY created_at DESC`, [topicId]);

    if (!manifests || manifests.length === 0) {
        return { error: 'No uploaded tables found for this topic' };
    }

    // Build schema description for the SLM
    const schemaDesc = manifests.map(m => {
        const cols = JSON.parse(m.schema_json || '[]');
        return { table: m.table_name, columns: cols };
    });

    const schemaText = schemaDesc.map(s => `Table: ${s.table}\nColumns: ${s.columns.join(', ')}`).join('\n\n');

    const plannerPrompt = `You are a data planner. Given the schema below and a user question, produce a JSON object (no surrounding text) with the following keys:\n{\n  "table": "<table_name>",\n  "select": ["col1", {"agg":"COUNT", "column":"col2", "alias":"count_col2"}],\n  "where": [{"column":"col","op":"=|>|<|>=|<=|LIKE","value": "..."}],\n  "group_by": ["col1"],\n  "limit": 50\n}\n\nOnly return valid JSON. Choose the most appropriate table and columns for the user's question. If an aggregate is needed, use the agg object form. If no filters are required, return an empty array for where. If you cannot answer, return an object with {"error":"explain reason"}.\n\nSchema:\n${schemaText}\n\nQuestion:\n${question}`;

    // Ask the model for a plan
    let planRaw = null;
    try {
        const planResp = await model.invoke(plannerPrompt);
        planRaw = planResp?.content ?? '';
    } catch (e) {
        return { error: 'Planner model error', detail: e?.message ?? String(e) };
    }

    // Try to extract JSON from model output
    let plan = null;
    try {
        // If the model returned only JSON, parse directly
        plan = JSON.parse(planRaw);
    } catch (e) {
        // Try to find the first JSON object in text
        const m = planRaw.match(/\{[\s\S]*\}/);
        if (m) {
            try { plan = JSON.parse(m[0]); } catch (ee) { /* fall through */ }
        }
    }

    if (!plan) return { error: 'Failed to parse planner JSON', raw: planRaw };
    if (plan.error) return { error: 'Planner returned error', detail: plan.error };

    // Validate table and columns
    const availableTables = Object.fromEntries(schemaDesc.map(s => [s.table, s.columns]));
    const table = String(plan.table || Object.keys(availableTables)[0]);
    const cols = availableTables[table];
    if (!cols) return { error: `Planner selected unknown table ${table}` };

    // Helper to validate column exists
    function validCol(c) { return cols.includes(c); }

    // Build SELECT clause
    const selectParts = [];
    const params = [];
    if (Array.isArray(plan.select) && plan.select.length) {
        for (const s of plan.select) {
            if (typeof s === 'string') {
                if (!validCol(s)) return { error: `Planner selected unknown column ${s}` };
                selectParts.push(`"${s}"`);
            } else if (s && s.agg && s.column) {
                if (!validCol(s.column)) return { error: `Planner selected unknown column ${s.column} in aggregate` };
                const agg = String(s.agg).toUpperCase();
                const alias = s.alias ? String(s.alias).replace(/[^A-Za-z0-9_]/g, '_') : `${agg.toLowerCase()}_${s.column}`;
                // allow COUNT, SUM, AVG, MIN, MAX
                if (!['COUNT','SUM','AVG','MIN','MAX'].includes(agg)) return { error: `Unsupported aggregate ${agg}` };
                selectParts.push(`${agg}("${s.column}") AS "${alias}"`);
            } else {
                return { error: 'Invalid select element in plan' };
            }
        }
    } else {
        // default: select all columns
        selectParts.push(cols.map(c=>`"${c}"`).join(', '));
    }

    // Build WHERE
    const whereParts = [];
    if (Array.isArray(plan.where)) {
        for (const w of plan.where) {
            if (!w || !w.column || w.value === undefined) continue;
            if (!validCol(w.column)) return { error: `Planner selected unknown column ${w.column} in where` };
            const op = String(w.op || '=').toUpperCase();
            // allow basic ops
            if (!['=','>','<','>=','<=','LIKE'].includes(op)) return { error: `Unsupported op ${op}` };
            whereParts.push(`"${w.column}" ${op} ?`);
            // For LIKE, keep value as-is (planner should include % if needed)
            params.push(String(w.value));
        }
    }

    const groupBy = Array.isArray(plan.group_by) ? plan.group_by.filter(validCol) : [];

    const finalLimit = Number(plan.limit || limit) || limit;

    // Build SQL
    const sqlParts = [];
    sqlParts.push('SELECT');
    sqlParts.push(selectParts.join(', '));
    sqlParts.push('FROM');
    sqlParts.push(`"${table}"`);
    if (whereParts.length) sqlParts.push('WHERE ' + whereParts.join(' AND '));
    if (groupBy.length) sqlParts.push('GROUP BY ' + groupBy.map(c=>`"${c}"`).join(', '));
    sqlParts.push('LIMIT ' + (finalLimit));
    const sql = sqlParts.join(' ');

    try {
        const rows = await db.all(sql, params);
        return { plan, sql, params, rows };
    } catch (e) {
        return { error: 'Query execution error', detail: e.message, sql, params };
    }
}

// Retrieve rows from a dynamically created table
export async function getUploadedTable(tableName, limit = 100, offset = 0) {
    const db = await initializeDatabase();
    // Basic sanitize: allow only letters, numbers and underscore
    const safe = String(tableName).replace(/[^A-Za-z0-9_]/g, '_');
    const rows = await db.all(`SELECT * FROM "${safe}" LIMIT ? OFFSET ?`, [limit, offset]);
    return rows;
}

// List uploaded tables created by the CSV importer (prefix doc_)
export async function listUploadedTables() {
    const db = await initializeDatabase();
    const rows = await db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'doc_%' ORDER BY name DESC`);
    return rows.map(r => r.name);
}

// Helper: Search SQLite FTS
async function searchDocuments(query, limit = 5) {
    const db = await initializeDatabase();
    // Sanitize user-provided query for FTS5. Raw punctuation (commas, parentheses, etc.)
    // can produce a syntax error in the FTS5 parser. We convert punctuation to
    // spaces and build a safe token-based query. If no tokens remain, return
    // empty context.
    function sanitizeFTSQuery(q) {
        if (!q) return '';
        // Replace punctuation characters that can break FTS5 syntax with space
        // Keep alphanumerics and underscore. Collapse multiple spaces later.
        const cleaned = q.replace(/["'`,()\[\]{}:\/\\<>\|\+\-\*~^=!@#\$%&\?;]/g, ' ');
        const tokens = cleaned.split(/\s+/).map(t => t.trim()).filter(Boolean);
        // Join tokens with OR to make the search forgiving. Use simple tokens
        // (no additional FTS syntax) to avoid parser errors.
        return tokens.length ? tokens.join(' OR ') : '';
    }

    const ftsQuery = sanitizeFTSQuery(query);
    if (!ftsQuery) return '';

    const results = await db.all(
        `SELECT title, content, bm25(documents) as score
        FROM documents
        WHERE documents MATCH ?
        ORDER BY score
        LIMIT ?`,
        [ftsQuery, limit]
    );
    return results.map(r => `${r.title}: ${r.content}`).join("\n\n");
}

// RAG Chatbot
export async function getRAGAnswer(question) {
    const context = await searchDocuments(question);
    const prompt = `
        You are a helpful assistant.
        Use the context below to answer the question.

        Context:
        ${context}

        Question: ${question}
    `;

    const response = await model.invoke(prompt);
    return response.content;
}

// Topics and messages
export async function listTopics() {
    const db = await initializeDatabase();
    const rows = await db.all(`SELECT id, title, subtitle, created_at FROM chat_topics ORDER BY created_at DESC`);
    return rows;
}

export async function createTopic({ id, title = 'New chat', subtitle = 'Ask anything' } = {}) {
    const db = await initializeDatabase();
    const topicId = id ?? `t${Date.now()}`;
    await db.run(`INSERT INTO chat_topics (id, title, subtitle) VALUES (?, ?, ?)`, [topicId, title, subtitle]);
    return { id: topicId, title, subtitle };
}

export async function getMessagesByTopic(topicId) {
    const db = await initializeDatabase();
    const rows = await db.all(`SELECT id, topic_id, role, content, file_name, created_at FROM chat_messages WHERE topic_id = ? ORDER BY id ASC`, [topicId]);
    return rows;
}

// Insert user message, stream assistant reply from Ollama and save assistant message after streaming
export async function postMessageAndStream(req, res) {
    try {
        const topicId = req.params.id;
        const text = req.body.text || '';
        const file = req.file; // multer

        console.log(`postMessageAndStream received - topicId=${topicId} text=${JSON.stringify(text).slice(0,200)} file=${file ? file.originalname : 'none'}`);
        console.log('postMessageAndStream called for topic:', topicId, 'text:', text, 'file:', file?.originalname);

        const db = await initializeDatabase();

        // ensure topic exists
        const topic = await db.get(`SELECT id FROM chat_topics WHERE id = ?`, [topicId]);
        if (!topic) {
            // create topic automatically
            await createTopic({ id: topicId });
        }

        // store user message
        await db.run(`INSERT INTO chat_messages (topic_id, role, content, file_name) VALUES (?, 'user', ?, ?)`, [topicId, text || (file ? `Uploaded file: ${file.originalname}` : '') , file ? file.originalname : null]);

        // Build RAG context
        const docContext = await searchDocuments(text);

        // also include last few messages in topic for context
        const recent = await db.all(`SELECT role, content FROM chat_messages WHERE topic_id = ? ORDER BY id DESC LIMIT 6`, [topicId]);
        const convoContext = recent.reverse().map(r => `${r.role}: ${r.content}`).join('\n');

        // If there are uploaded tables for this topic, fetch relevant rows so the SLM
        // can use them. This binds uploaded tabular data to the user's prompt.
        let uploadedDataContext = '';
        try {
            const dataResults = await queryUploadedData(topicId, text, { limit: 20 });
            if (Array.isArray(dataResults) && dataResults.length > 0) {
                const parts = [];
                for (const dr of dataResults) {
                    if (dr.error) continue;
                    parts.push(`Table: ${dr.table}`);
                    if (dr.columns && dr.columns.length) parts.push(`Columns: ${dr.columns.join(', ')}`);
                    const sampleRows = (dr.rows || []).slice(0, 5).map(r => JSON.stringify(r)).join('\n');
                    if (sampleRows) parts.push(`Rows:\n${sampleRows}`);
                }
                if (parts.length) uploadedDataContext = parts.join('\n\n');
            }
        } catch (e) {
            console.warn('Failed to fetch uploaded data for topic', topicId, e?.message || e);
        }

        const prompt = `You are a helpful assistant. Use the context below, any uploaded tabular data for this conversation, and previous conversation to answer the question.\n\nContext:\n${docContext}\n\nUploaded Data:\n${uploadedDataContext}\n\nConversation:\n${convoContext}\n\nQuestion: ${text}`;

    // Proxy streaming response from local Ollama generate endpoint
    console.log('Calling Ollama generate with prompt length:', prompt.length);
        const response = await fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "llama3.2:3b",
                prompt,
                stream: true,
                options: { temperature: 0 }
            }),
        });

        if (!response.ok) {
            return res.status(500).json({ error: `Ollama API error: ${response.statusText}` });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            // forward raw chunk to client
            res.write(chunk);

            try {
                const parsed = JSON.parse(chunk);
                if (parsed && parsed.response) {
                    assistantText += parsed.response;
                }
            } catch (e) {
                // chunk may be partial JSON — append raw text
                assistantText += chunk;
            }
        }

        // finalize stream
        res.end();

        // save assistant response
        await db.run(`INSERT INTO chat_messages (topic_id, role, content) VALUES (?, 'assistant', ?)`, [topicId, assistantText]);

    } catch (err) {
        console.error('postMessageAndStream error', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
}
