// Create the database named in DATABASE_URL (if needed) and apply all migrations.
import { loadConfig } from "../config.js";
import { ensureDatabase, migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { errorMessage } from "../errors.js";

async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  const where = new URL(databaseUrl);
  where.password = where.password ? "***" : "";
  console.log(`database: ${where.toString()}`);
  const created = await ensureDatabase(databaseUrl);
  console.log(created ? "created the database" : "the database already exists");
  const db = createPool(databaseUrl);
  try {
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "migrations are up to date");
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`database setup failed: ${errorMessage(e)}`);
  console.error("Is PostgreSQL running, and does DATABASE_URL point at it? (npm run db:local starts one for development.)");
  process.exit(1);
});
