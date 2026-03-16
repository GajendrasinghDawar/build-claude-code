import { createClient, type Client } from "@libsql/client";

let sharedClient: Client | null = null;

export function getTursoClient(): Client | null {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    return null;
  }

  if (sharedClient) {
    return sharedClient;
  }

  sharedClient = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  return sharedClient;
}

export async function ensureCoreTables(): Promise<string> {
  const client = getTursoClient();
  if (!client) {
    return "Turso not configured; skipping DB bootstrap.";
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      owner TEXT NOT NULL,
      blocked_by TEXT NOT NULL DEFAULT '[]',
      blocks TEXT NOT NULL DEFAULT '[]',
      worktree TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    )
  `);

  return "Turso schema initialized.";
}
