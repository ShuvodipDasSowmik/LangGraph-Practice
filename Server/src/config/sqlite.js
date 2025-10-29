import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export async function initializeDatabase() {
    // Resolve directory relative to this file so DB path is stable regardless of cwd
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const dbDir = path.join(__dirname, 'db');
    const dbPath = path.join(dbDir, 'database.sqlite');

    // Ensure the directory exists
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents
        USING fts5(title, content);
    `);

    // manifest for uploaded CSVs: store table name, original filename, schema (JSON), and optional topic/session
    await db.exec(`
        CREATE TABLE IF NOT EXISTS uploaded_tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            topic_id TEXT,
            table_name TEXT,
            original_name TEXT,
            schema_json TEXT,
            created_at DATETIME DEFAULT (datetime('now'))
        );
    `);

    // chat topics and messages
    await db.exec(`
        CREATE TABLE IF NOT EXISTS chat_topics (
            id TEXT PRIMARY KEY,
            title TEXT,
            subtitle TEXT,
            created_at DATETIME DEFAULT (datetime('now'))
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            topic_id TEXT,
            role TEXT,
            content TEXT,
            file_name TEXT,
            created_at DATETIME DEFAULT (datetime('now')),
            FOREIGN KEY(topic_id) REFERENCES chat_topics(id)
        );
    `);

    return db;
}