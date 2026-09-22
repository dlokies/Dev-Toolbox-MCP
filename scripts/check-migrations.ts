import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Isolated local D1 only. No remote requests or deployment, including on failure.
const directory = mkdtempSync(join(tmpdir(), "dev-toolbox-migrations-"));
const migrations = join(directory, "migrations");
const appliedFiles = readdirSync(resolve("migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
mkdirSync(migrations);
cpSync(resolve("migrations"), migrations, { recursive: true });
const config = join(directory, "wrangler.json");
writeFileSync(
  config,
  JSON.stringify({
    name: "migration-check",
    compatibility_date: "2026-09-21",
    d1_databases: [
      {
        binding: "DB",
        database_name: "migration-check",
        database_id: "00000000-0000-0000-0000-000000000001",
        migrations_dir: migrations,
      },
    ],
  }),
);
const common = [
  "--config",
  config,
  "--local",
  "--persist-to",
  join(directory, "state"),
];
function run(args: string[]) {
  return spawnSync("pnpm", ["exec", "wrangler", ...args, ...common], {
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
    },
  });
}
function query(sql: string): unknown {
  const result = run([
    "d1",
    "execute",
    "migration-check",
    "--command",
    sql,
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout)[0].results;
}
try {
  const failed = join(migrations, "9999_failure_fixture.sql");
  writeFileSync(
    failed,
    "CREATE TABLE rolled_back (id TEXT); INSERT INTO missing_fixture_table VALUES ('fail');",
  );
  let deploymentReached = false;
  const first = run(["d1", "migrations", "apply", "migration-check"]);
  if (first.status === 0) deploymentReached = true;
  assert.notEqual(first.status, 0);
  assert.equal(
    deploymentReached,
    false,
    "Failed migration must stop the deployment gate",
  );
  assert.deepEqual(
    query("SELECT name FROM d1_migrations ORDER BY id"),
    appliedFiles.map((name) => ({ name })),
  );
  assert.deepEqual(
    query("SELECT name FROM sqlite_master WHERE name = 'rolled_back'"),
    [],
  );
  // Only the never-applied, temporary test migration is corrected here.
  writeFileSync(failed, "CREATE TABLE recovery_fixture (id TEXT);");
  const retry = run(["d1", "migrations", "apply", "migration-check"]);
  assert.equal(retry.status, 0, retry.stderr);
  const repeated = run(["d1", "migrations", "apply", "migration-check"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /No migrations to apply/);
  assert.deepEqual(query("SELECT count(*) AS count FROM d1_migrations"), [
    { count: appliedFiles.length + 1 },
  ]);
  assert.equal(
    readFileSync(failed, "utf8"),
    "CREATE TABLE recovery_fixture (id TEXT);",
  );
  console.log(
    "Migration partial failure, rollback, retry and repeated-build no-op verified on isolated local D1.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
