import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

const requireFn = createRequire(__filename);

function loadBetterSqlite3(): typeof import("better-sqlite3") {
  try {
    return requireFn("better-sqlite3") as typeof import("better-sqlite3");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[graphflow] sqlite transport requires the optional 'better-sqlite3' package. ` +
        `Install it (npm i better-sqlite3) or switch graphPolicy.transport to 'file' / 'memory'. ` +
        `Underlying error: ${msg}`
    );
  }
}

type NodeRow = {
  id: string;
  type: GraphNode["type"];
  content: string;
  metadata: string | null;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  content,
  content='nodes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TABLE IF NOT EXISTS edges(
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
`;

function rowToNode(row: NodeRow): GraphNode {
  const node: GraphNode = {
    id: row.id,
    type: row.type,
    content: row.content,
  };
  if (row.metadata != null) {
    try {
      const parsed = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object") {
        node.metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // skip metadata on parse failure
    }
  }
  return node;
}

function escapeFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export class GraphifySqliteClient implements GraphClient {
  private readonly db: import("better-sqlite3").Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (dir && dir !== "." && dir !== "") {
      mkdirSync(dir, { recursive: true });
    }
    const Database = loadBetterSqlite3();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA_SQL);
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO nodes(id, type, content, metadata) VALUES(?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type=excluded.type, content=excluded.content, metadata=excluded.metadata`
    );
    const tx = this.db.transaction((batch: GraphNode[]) => {
      for (const n of batch) {
        const metaJson = n.metadata !== undefined ? JSON.stringify(n.metadata) : null;
        stmt.run(n.id, n.type, n.content, metaJson);
      }
    });
    tx(nodes);
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO edges(from_id, to_id, relation) VALUES(?, ?, ?)`
    );
    const tx = this.db.transaction((batch: GraphEdge[]) => {
      for (const e of batch) {
        stmt.run(e.from, e.to, e.relation);
      }
    });
    tx(edges);
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((t) => t.length >= 2);

    if (tokens.length === 0) {
      const rows = this.db
        .prepare(`SELECT id, type, content, metadata FROM nodes WHERE LOWER(content) LIKE ? LIMIT 200`)
        .all(`%${query.toLowerCase()}%`) as NodeRow[];
      return rows.map(rowToNode);
    }

    const match = tokens.map(escapeFtsToken).join(" ");
    const rows = this.db
      .prepare(
        `SELECT n.id AS id, n.type AS type, n.content AS content, n.metadata AS metadata
         FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid
         WHERE nodes_fts MATCH ? ORDER BY rank LIMIT 200`
      )
      .all(match) as NodeRow[];
    return rows.map(rowToNode);
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT id, type, content, metadata FROM nodes WHERE id IN (${placeholders})`)
      .all(...ids) as NodeRow[];
    return rows.map(rowToNode);
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction: "out" | "in" | "both" = "out"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]> {
    if (nodeIds.length === 0) return [];

    const idPlaceholders = nodeIds.map(() => "?").join(", ");
    const relFilter =
      relations && relations.length > 0
        ? ` AND e.relation IN (${relations.map(() => "?").join(", ")})`
        : "";

    const queries: string[] = [];
    if (direction === "out" || direction === "both") {
      queries.push(
        `SELECT n.id AS id, n.type AS type, n.content AS content, n.metadata AS metadata, e.relation AS relation
         FROM edges e JOIN nodes n ON n.id = e.to_id
         WHERE e.from_id IN (${idPlaceholders})${relFilter}`
      );
    }
    if (direction === "in" || direction === "both") {
      queries.push(
        `SELECT n.id AS id, n.type AS type, n.content AS content, n.metadata AS metadata, e.relation AS relation
         FROM edges e JOIN nodes n ON n.id = e.from_id
         WHERE e.to_id IN (${idPlaceholders})${relFilter}`
      );
    }

    const params: unknown[] = [];
    for (let i = 0; i < queries.length; i += 1) {
      params.push(...nodeIds);
      if (relations && relations.length > 0) params.push(...relations);
    }

    const sql = queries.join(" UNION ALL ");
    const rows = this.db.prepare(sql).all(...params) as Array<NodeRow & { relation: GraphEdge["relation"] }>;

    const seen = new Set<string>();
    const out: { node: GraphNode; via: GraphEdge["relation"] }[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ node: rowToNode(row), via: row.relation });
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
