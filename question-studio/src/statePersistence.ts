import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { StudioState } from './schema.js';

const sections = ['questions', 'calls', 'topics', 'events'] as const;
const recordSchema = z.object({ section: z.enum(['meta', ...sections]), id: z.string(),
  position: z.number().int().nonnegative(), payload: z.string() });

export class StatePersistence {
  private readonly database: DatabaseSync;
  private cache = new Map<string, { position: number; payload: string }>();

  constructor(filename: string, writeTimeoutMs: number) {
    this.database = new DatabaseSync(filename, { timeout: writeTimeoutMs });
    const version = this.database.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) throw new Error('Unsupported local state database version');
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS studio_records (
        section TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (section, id)
      ) STRICT; PRAGMA user_version=1;`);
  }

  load(): StudioState | null {
    const rows = recordSchema.array().parse(this.database.prepare('SELECT * FROM studio_records ORDER BY section, position').all());
    if (!rows.length) return null;
    const metadata = Object.fromEntries(rows.filter(row => row.section === 'meta').map(row => [row.id, JSON.parse(row.payload) as unknown]));
    const collections = Object.fromEntries(sections.map(section => [section,
      rows.filter(row => row.section === section).map(row => JSON.parse(row.payload) as unknown)]));
    const snapshot = { ...metadata, ...collections } as unknown as StudioState;
    if (snapshot.version !== 1 || !snapshot.runId || !Array.isArray(snapshot.calls) || !Array.isArray(snapshot.questions)) {
      throw new Error('Invalid local state database');
    }
    this.cache = new Map(rows.map(row => [`${row.section}:${row.id}`, { position: row.position, payload: row.payload }]));
    return snapshot;
  }

  save(snapshot: StudioState): { changedRecords: number; bytes: number } {
    const records = new Map<string, z.infer<typeof recordSchema>>();
    for (const [id, value] of Object.entries(snapshot)) {
      if (sections.some(section => section === id) || value === undefined) continue;
      records.set(`meta:${id}`, { section: 'meta', id, position: 0, payload: JSON.stringify(value) });
    }
    for (const section of sections) snapshot[section].forEach((value, position) => {
      const key = `${section}:${value.id}`;
      if (records.has(key)) throw new Error('Duplicate local state record');
      records.set(key, { section, id: value.id, position, payload: JSON.stringify(value) });
    });
    const changed = [...records].filter(([key, record]) => {
      const previous = this.cache.get(key);
      return previous?.position !== record.position || previous.payload !== record.payload;
    });
    const removed = [...this.cache.keys()].filter(key => !records.has(key));
    if (!changed.length && !removed.length) return { changedRecords: 0, bytes: 0 };
    const upsert = this.database.prepare(`INSERT INTO studio_records (section,id,position,payload) VALUES (?,?,?,?)
      ON CONFLICT(section,id) DO UPDATE SET position=excluded.position,payload=excluded.payload`);
    const remove = this.database.prepare('DELETE FROM studio_records WHERE section=? AND id=?');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const [, record] of changed) upsert.run(record.section, record.id, record.position, record.payload);
      for (const key of removed) {
        const separator = key.indexOf(':');
        remove.run(key.slice(0, separator), key.slice(separator + 1));
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.cache = new Map([...records].map(([key, record]) => [key, { position: record.position, payload: record.payload }]));
    return { changedRecords: changed.length + removed.length,
      bytes: changed.reduce((sum, [, record]) => sum + Buffer.byteLength(record.payload), 0) };
  }

  close(): void { this.database.close(); }
}
