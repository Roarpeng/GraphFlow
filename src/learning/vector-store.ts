import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { cosineSimilarity } from "./embeddings";

export interface VectorNode {
  id: string;
  content: string;
  embedding: number[];
}

export class VectorStore {
  private db: import("better-sqlite3").Database;

  constructor(dbPath: string = ".graphflow-cache/vectors.db") {
    const dir = dirname(dbPath);
    if (dir && dir !== "." && dir !== "") {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_nodes (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL
      )
    `);
  }

  public addNode(node: VectorNode): void {
    const stmt = this.db.prepare(
      `INSERT INTO vector_nodes (id, content, embedding) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, embedding=excluded.embedding`
    );
    stmt.run(node.id, node.content, JSON.stringify(node.embedding));
  }

  public addNodes(nodes: VectorNode[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO vector_nodes (id, content, embedding) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, embedding=excluded.embedding`
    );
    const tx = this.db.transaction((batch: VectorNode[]) => {
      for (const node of batch) {
        stmt.run(node.id, node.content, JSON.stringify(node.embedding));
      }
    });
    tx(nodes);
  }

  public query(queryEmbedding: number[], topK: number = 5, minSimilarity: number = 0): Array<{node: VectorNode; score: number}> {
    const rows = this.db.prepare(`SELECT id, content, embedding FROM vector_nodes`).all() as Array<{id: string; content: string; embedding: string}>;
    
    const results: Array<{node: VectorNode; score: number}> = [];
    for (const row of rows) {
      try {
        const emb = JSON.parse(row.embedding) as number[];
        const score = cosineSimilarity(queryEmbedding, emb);
        if (score >= minSimilarity) {
          results.push({
            node: { id: row.id, content: row.content, embedding: emb },
            score
          });
        }
      } catch {
        // ignore invalid JSON
      }
    }
    
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  public deleteNode(id: string): void {
    const stmt = this.db.prepare(`DELETE FROM vector_nodes WHERE id = ?`);
    stmt.run(id);
  }
}
