const { createServer } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} = require("node:fs");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const sqlitePath = path.join(dataDir, "baby-tracker.sqlite");
const legacyJsonPath = path.join(dataDir, "baby-tracker.json");
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(sqlitePath);
initializeDatabase();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Baby tracker running at http://localhost:${port}`);
  console.log(`SQLite database: ${sqlitePath}`);
});

async function handleApi(req, res, url) {
  const route = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, readState());
    return;
  }

  if (route[1] === "entries") {
    if (req.method === "POST" && route.length === 2) {
      const entry = insertEntry(normalizeEntry(await readBody(req)));
      sendJson(res, 201, entry);
      return;
    }

    if (req.method === "PUT" && route.length === 3) {
      const existing = findEntry(route[2]);
      if (!existing) {
        sendJson(res, 404, { error: "Entry not found" });
        return;
      }

      const entry = updateEntry(
        normalizeEntry({
          ...(await readBody(req)),
          id: route[2],
          createdAt: existing.createdAt,
        }),
      );
      sendJson(res, 200, entry);
      return;
    }

    if (req.method === "DELETE" && route.length === 3) {
      db.prepare("DELETE FROM entries WHERE id = ?").run(route[2]);
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (route[1] === "sessions" && route.length === 3) {
    const type = route[2];
    if (req.method === "PUT") {
      const input = await readBody(req);
      const startedAt = validIso(input.startedAt, new Date().toISOString());
      db.prepare(
        `INSERT INTO sessions (type, started_at)
         VALUES (?, ?)
         ON CONFLICT(type) DO UPDATE SET started_at = excluded.started_at`,
      ).run(type, startedAt);
      sendJson(res, 200, { startedAt });
      return;
    }

    if (req.method === "DELETE") {
      db.prepare("DELETE FROM sessions WHERE type = ?").run(type);
      res.writeHead(204);
      res.end();
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(requestPath, res) {
  const cleanPath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(rootDir, cleanPath));
  const relativePath = path.relative(rootDir, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  let fileStat;
  try {
    fileStat = statSync(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  if (!fileStat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const file = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(file);
}

function initializeDatabase() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      start_time TEXT NOT NULL DEFAULT '',
      end_time TEXT NOT NULL DEFAULT '',
      amount TEXT NOT NULL DEFAULT '',
      side TEXT NOT NULL DEFAULT '',
      pee INTEGER NOT NULL DEFAULT 0,
      poop INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_timestamp_idx ON entries (timestamp DESC);
    CREATE TABLE IF NOT EXISTS sessions (
      type TEXT PRIMARY KEY,
      started_at TEXT NOT NULL
    );
  `);

  migrateLegacyJson();
}

function migrateLegacyJson() {
  if (!existsSync(legacyJsonPath)) return;
  const count = db.prepare("SELECT COUNT(*) AS count FROM entries").get().count;
  const sessionCount = db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count;
  if (count > 0 || sessionCount > 0) return;

  try {
    const legacy = JSON.parse(readFileSync(legacyJsonPath, "utf8"));
    const entries = Array.isArray(legacy.entries) ? legacy.entries : [];
    const sessions = legacy.sessions && typeof legacy.sessions === "object" ? legacy.sessions : {};
    const insertLegacyEntry = db.prepare(`
      INSERT INTO entries (
        id, type, timestamp, start_time, end_time, amount, side, pee, poop, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLegacySession = db.prepare(`
      INSERT INTO sessions (type, started_at) VALUES (?, ?)
    `);

    db.exec("BEGIN");
    for (const item of entries) {
      const entry = normalizeEntry(item);
      insertLegacyEntry.run(
        entry.id,
        entry.type,
        entry.timestamp,
        entry.startTime,
        entry.endTime,
        entry.amount,
        entry.side,
        Number(entry.pee),
        Number(entry.poop),
        entry.notes,
        entry.createdAt,
      );
    }
    for (const [type, session] of Object.entries(sessions)) {
      insertLegacySession.run(cleanString(type), validIso(session.startedAt, new Date().toISOString()));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.warn(`Could not migrate legacy JSON data: ${error.message}`);
  }
}

function readState() {
  const entryRows = db
    .prepare(
      `SELECT id, type, timestamp, start_time, end_time, amount, side, pee, poop, notes, created_at
       FROM entries
       ORDER BY timestamp DESC`,
    )
    .all();
  const sessionRows = db.prepare("SELECT type, started_at FROM sessions").all();
  const sessions = {};
  for (const row of sessionRows) {
    sessions[row.type] = { startedAt: row.started_at };
  }
  return {
    entries: entryRows.map(rowToEntry),
    sessions,
  };
}

function findEntry(id) {
  const row = db
    .prepare(
      `SELECT id, type, timestamp, start_time, end_time, amount, side, pee, poop, notes, created_at
       FROM entries
       WHERE id = ?`,
    )
    .get(id);
  return row ? rowToEntry(row) : null;
}

function insertEntry(entry) {
  db.prepare(
    `INSERT INTO entries (
      id, type, timestamp, start_time, end_time, amount, side, pee, poop, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.type,
    entry.timestamp,
    entry.startTime,
    entry.endTime,
    entry.amount,
    entry.side,
    Number(entry.pee),
    Number(entry.poop),
    entry.notes,
    entry.createdAt,
  );
  return entry;
}

function updateEntry(entry) {
  db.prepare(
    `UPDATE entries
     SET type = ?, timestamp = ?, start_time = ?, end_time = ?, amount = ?, side = ?,
         pee = ?, poop = ?, notes = ?
     WHERE id = ?`,
  ).run(
    entry.type,
    entry.timestamp,
    entry.startTime,
    entry.endTime,
    entry.amount,
    entry.side,
    Number(entry.pee),
    Number(entry.poop),
    entry.notes,
    entry.id,
  );
  return entry;
}

function rowToEntry(row) {
  return {
    id: row.id,
    type: row.type,
    timestamp: row.timestamp,
    startTime: row.start_time,
    endTime: row.end_time,
    amount: row.amount,
    side: row.side,
    pee: Boolean(row.pee),
    poop: Boolean(row.poop),
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function normalizeEntry(input) {
  const type = cleanString(input.type) || "bottle";
  return {
    id: cleanString(input.id) || crypto.randomUUID(),
    type,
    timestamp: validIso(input.timestamp, new Date().toISOString()),
    startTime: optionalIso(input.startTime),
    endTime: optionalIso(input.endTime),
    amount: cleanString(input.amount),
    side: cleanString(input.side),
    pee: Boolean(input.pee),
    poop: Boolean(input.poop),
    notes: cleanString(input.notes),
    createdAt: validIso(input.createdAt, new Date().toISOString()),
  };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim().slice(0, 1000) : "";
}

function optionalIso(value) {
  return value ? validIso(value, "") : "";
}

function validIso(value, fallback) {
  if (!value || Number.isNaN(new Date(value).getTime())) return fallback;
  return new Date(value).toISOString();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 200_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
