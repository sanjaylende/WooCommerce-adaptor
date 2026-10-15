// Migration runner: applies migrations/*.sql in name order, once each, recorded in schema_migrations with a checksum
// (a changed, already-applied file is an error: write a new migration instead). Then syncs the EAV attribute
// definitions declared by the models into eav_entity_type / eav_attribute (idempotent).
//
// Everything lives in the adapter's own schema (config.database.schema, default "woocommerce_adapter"), which is the search_path of the
// connection, so the migration files stay plain unqualified SQL. The migration history (schema_migrations) is in that schema too. Two
// rewrites are applied to the SQL text before it runs (the checksum is always of the file as written, so old and new installs agree):
//   * "IN SCHEMA public"  ->  the adapter schema (the files were written when the adapter had a database of its own)
//   * the role name "adapter_app"  ->  the role the service connects as (DATABASE_URL's user)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");
const config = require("../config");
const { migrationPool } = require("./connection");

const DIR = path.join(__dirname, "..", "..", "migrations");

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// The role the running service connects as: the user of DATABASE_URL.
function appRoleName() {
  try { return decodeURIComponent(new URL(config.database.url).username) || "adapter_app"; } catch { return "adapter_app"; }
}

// The SQL a migration file runs, with the adapter's schema and application role substituted (see the header).
function renderSql(sql, schema = config.database.schema, appRole = appRoleName()) {
  return sql
    .replace(/\bIN SCHEMA public\b/gi, `IN SCHEMA ${quoteIdent(schema)}`)
    .replace(/\badapter_app\b/g, quoteIdent(appRole));
}

async function runMigrations() {
  const pool = migrationPool();
  const schema = config.database.schema;
  if (schema !== "public") {
    // Created (once) by the runner because the migration history has to live somewhere; checked first because CREATE SCHEMA IF NOT EXISTS
    // needs CREATE on the database even when the schema exists, and the owner role is deliberately not given that.
    const { rowCount } = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
    if (!rowCount) await pool.query("CREATE SCHEMA " + quoteIdent(schema));
  }
  // The history table's name is built from the validated, quoted schema name (configuration, never request data).
  const history = quoteIdent(schema) + ".schema_migrations";
  await pool.query("CREATE TABLE IF NOT EXISTS " + history + " (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const applied = new Map((await pool.query("SELECT id, checksum FROM " + history)).rows.map((r) => [r.id, r.checksum]));
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) throw new Error(`Migration ${file} was changed after it was applied`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(renderSql(sql));
      await client.query("INSERT INTO " + history + " (id, checksum) VALUES ($1, $2)", [file, checksum]);
      await client.query("COMMIT");
      logger.info(`Applied migration ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
}

async function syncEntityTypes(models) {
  const pool = migrationPool();
  for (const model of models) {
    await pool.query("INSERT INTO eav_entity_type (code, label) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING", [model.entityType, model.label]);
    const { rows: [type] } = await pool.query("SELECT entity_type_id FROM eav_entity_type WHERE code = $1", [model.entityType]);
    for (const [code, def] of Object.entries(model.attributes)) {
      await pool.query(
        "INSERT INTO eav_attribute (entity_type_id, code, backend_type, frontend_type) VALUES ($1, $2, $3, $4) ON CONFLICT (entity_type_id, code) DO NOTHING",
        [type.entity_type_id, code, def.backend, def.frontend]
      );
    }
  }
}

module.exports = { runMigrations, syncEntityTypes, renderSql };
