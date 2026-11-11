import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { CookieJar } from "tough-cookie";
import { parseSession } from "../src/auth/session.js";
import { openDatabase } from "../src/db/database.js";
import { SqliteSessionStore } from "../src/db/session-store.js";

test("SQLite persists token and cookies together across store instances with private permissions", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-session-test-"));
  try {
    const path = join(temporary, "auth", "mile.db");
    const store = openStore(t, path);
    assert.equal(await store.load(), null);
    const session = {
      version: 1 as const,
      accessToken: "synthetic-token",
      cookieJar: await new CookieJar().serialize(),
    };
    await store.save(session);
    assert.deepEqual(await openStore(t, path).load(), session);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(temporary, "auth"))).mode & 0o777, 0o700);
    }
    const jar = new CookieJar();
    await jar.setCookie("refresh=rotated; Secure", "https://alb-tablet.mile.im/");
    const rotated = { ...session, accessToken: "rotated-token", cookieJar: await jar.serialize() };
    await store.save(rotated);
    assert.deepEqual(await openStore(t, path).load(), rotated);
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare("SELECT count(*) AS count FROM session").get()?.count, 1);
      assert.ok(Date.parse(String(db.prepare("SELECT updated_at FROM session").get()?.updated_at)));
    } finally {
      db.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("invalid imports do not expose credentials or replace the stored session", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-session-test-"));
  try {
    const store = openStore(t, join(temporary, "mile.db"));
    const session = {
      version: 1 as const,
      accessToken: "synthetic-token",
      cookieJar: await new CookieJar().serialize(),
    };
    await store.save(session);
    for (const input of [
      '{"accessToken":"DO_NOT_EXPOSE"',
      JSON.stringify({ ...session, cookieJar: {} }),
    ]) {
      await assert.rejects(
        parseSession(input).then((value) => store.save(value)),
        (error) => {
          assert.equal((error as { code: string }).code, "AUTH_FORMAT_CHANGED");
          assert.ok(!(error as Error).message.includes("DO_NOT_EXPOSE"));
          return true;
        },
      );
    }
    assert.deepEqual(await store.load(), session);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("CLI import persists stdin credentials and requires explicit replacement", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-import-test-"));
  try {
    const path = join(temporary, "mile.db");
    const initial = {
      version: 1 as const,
      accessToken: "synthetic-token",
      cookieJar: await new CookieJar().serialize(),
    };
    const run = (session: object, replace = false) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "import-session", ...(replace ? ["--replace"] : [])],
        {
          input: JSON.stringify(session),
          encoding: "utf8",
          env: { ...process.env, MILE_MCP_DATABASE_PATH: path },
        },
      );
    const imported = run(initial);
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(JSON.parse(imported.stdout), { imported: true });
    const replacement = { ...initial, accessToken: "replacement-token" };
    const rejected = run(replacement);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /SESSION_EXISTS/);
    assert.ok(!rejected.stderr.includes(replacement.accessToken));
    assert.deepEqual(await openStore(t, path).load(), initial);
    assert.equal(run(replacement, true).status, 0);
    assert.deepEqual(await openStore(t, path).load(), replacement);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function openStore(t: TestContext, path: string) {
  const database = openDatabase(path);
  t.after(() => database.close());
  return new SqliteSessionStore(database.db);
}

test("Drizzle adopts the existing session table and applies migrations once without changing credentials", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-migration-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const path = join(temporary, "mile.db");
  const original = {
    version: 1 as const,
    accessToken: "existing-synthetic-token",
    cookieJar: await new CookieJar().serialize(),
  };
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE session (
    id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL,
    cookie_jar TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy
    .prepare("INSERT INTO session VALUES (1, ?, ?, ?)")
    .run(original.accessToken, JSON.stringify(original.cookieJar), "2026-01-01T00:00:00Z");
  legacy.close();
  for (let i = 0; i < 2; i++) {
    const database = openDatabase(path);
    try {
      assert.deepEqual(await new SqliteSessionStore(database.db).load(), original);
    } finally {
      database.close();
    }
  }
  const check = new DatabaseSync(path);
  try {
    assert.equal(
      check.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()?.count,
      1,
    );
    assert.equal(
      check.prepare("SELECT updated_at FROM session").get()?.updated_at,
      "2026-01-01T00:00:00Z",
    );
    assert.throws(() => check.prepare("INSERT INTO session VALUES (2, 'x', '{}', 'x')").run());
  } finally {
    check.close();
  }
});
