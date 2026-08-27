import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createDatabase, withTransaction } from "./client.js";

export async function migrate(): Promise<void> {
  const database = await createDatabase();
  const directory = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "database/migrations");
  try {
    await database.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(directory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const sql = await readFile(path.join(directory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      await withTransaction(database, async (client) => {
        const existing = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE version = $1 FOR UPDATE",
          [file],
        );
        const row = existing.rows[0];
        if (row) {
          if (row.checksum !== checksum) {
            throw new Error(`Migration ${file} changed after it was applied`);
          }
          return;
        }
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        process.stdout.write(`applied ${file}\n`);
      });
    }
  } finally {
    await database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  migrate().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

