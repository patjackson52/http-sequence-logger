import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import {
  mkdirSync,
  readdirSync,
  chmodSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  lstatSync,
  statfsSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import validateEvent from "../shared/event-validator.mjs";
const { directory, limits, testCommitGate, testClock, testFilesystemFaults } =
  workerData;
// Private constructor-only deterministic test controls; never exposed by HTTP.
const clockNow = () =>
  testClock
    ? Number(Atomics.load(new BigInt64Array(testClock), 0))
    : Date.now();
function availableBytes() {
  if (testFilesystemFaults) {
    const override = Atomics.load(new BigInt64Array(testFilesystemFaults), 0);
    if (override >= 0n) return Number(override);
  }
  const space = statfsSync(directory);
  return space.bavail * space.bsize;
}
function waitCommitGate() {
  if (!testCommitGate) return;
  const gate = new Int32Array(testCommitGate);
  if (Atomics.load(gate, 0) !== 0) return;
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);
}

const errorStatus = (error) =>
  ["SQLITE_FULL", "ENOSPC"].includes(error.code) ? 507 : error.status || 503;
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const stable = (value) =>
  JSON.stringify(value, function (k, v) {
    return v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]]),
        )
      : v;
  });
const hash = (v) => createHash("sha256").update(v).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
let db,
  config,
  lockOwned = false;
const statements = new Map();
function prepare(sql) {
  if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
  return statements.get(sql);
}
function init() {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ds = lstatSync(directory);
  if (
    !ds.isDirectory() ||
    ds.isSymbolicLink() ||
    (process.getuid && ds.uid !== process.getuid()) ||
    ds.mode & 0o077
  )
    fail(403, "Collector directory must be owned and private (0700)");
  for (const name of ["capture.ndjson", "connection-state.json"])
    if (existsSync(resolve(directory, name)))
      fail(409, "Unsupported old collector state; select a new directory");
  const lock = resolve(directory, "collector.lock");
  function createLock() {
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    lockOwned = true;
  }
  try {
    createLock();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const reclaim = lock + ".reclaim";
    let gate;
    try {
      gate = openSync(reclaim, "wx", 0o600);
    } catch (gateError) {
      if (gateError.code !== "EEXIST") throw gateError;
      fail(
        409,
        "Collector ownership reclamation busy or interrupted; retry or select a new directory",
      );
    }
    try {
      writeFileSync(gate, String(process.pid));
      if (existsSync(lock)) {
        const s = lstatSync(lock);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          s.size > 32 ||
          s.mode & 0o077 ||
          (process.getuid && s.uid !== process.getuid())
        )
          fail(409, "Unsafe collector lock");
        const descriptor = openSync(lock, "r");
        let pid;
        try {
          const opened = fstatSync(descriptor);
          if (opened.ino !== s.ino || opened.dev !== s.dev)
            fail(409, "Collector lock changed");
          const buffer = Buffer.alloc(33);
          let length = 0;
          while (length < buffer.length) {
            const count = readSync(
              descriptor,
              buffer,
              length,
              buffer.length - length,
              length,
            );
            if (!count) break;
            length += count;
          }
          if (length > 32) fail(409, "Collector lock exceeds limit");
          pid = Number(buffer.subarray(0, length).toString("utf8"));
        } finally {
          closeSync(descriptor);
        }
        if (!Number.isInteger(pid) || pid < 1)
          fail(409, "Invalid collector lock");
        try {
          process.kill(pid, 0);
          fail(409, "Collector directory already in use");
        } catch (probe) {
          if (probe.code !== "ESRCH") throw probe;
        }
        unlinkSync(lock);
      }
      // A fresh O_EXCL claimant can win between unlink and create. If so,
      // this attempt fails; it never removes that newly claimed owner.
      createLock();
    } finally {
      closeSync(gate);
      unlinkSync(reclaim);
    }
  }
  lockOwned = true;
  const path = resolve(directory, "capture.sqlite");
  if (existsSync(path)) {
    const s = lstatSync(path);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.mode & 0o077 ||
      (process.getuid && s.uid !== process.getuid())
    )
      fail(403, "Unsafe database file");
  }
  const fresh = !existsSync(path);
  db = new Database(path);
  if (fresh) chmodSync(path, 0o600);
  const version = prepare("select sqlite_version() v")
    .get()
    .v.split(".")
    .map(Number);
  if (
    version[0] < 3 ||
    (version[0] === 3 &&
      (version[1] < 51 || (version[1] === 51 && version[2] < 3)))
  )
    fail(503, "SQLite WAL-reset fix required");
  const uv = db.pragma("user_version", { simple: true });
  if (uv !== 0 && uv !== 3)
    fail(409, "Unsupported database format; use a new directory");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("fullfsync = ON");
  db.pragma("checkpoint_fullfsync = ON");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 1000");
  db.exec(`CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(token TEXT PRIMARY KEY,principal TEXT NOT NULL,scope TEXT NOT NULL,expires INTEGER NOT NULL,recovery INTEGER NOT NULL,max_sources INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,source_key TEXT UNIQUE NOT NULL,principal TEXT NOT NULL,metadata TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen INTEGER,status TEXT,reason TEXT,bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS credentials(token TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS registrations(principal TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(principal,operation));
CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),identity TEXT NOT NULL,namespace TEXT NOT NULL,session TEXT NOT NULL,contiguous INTEGER NOT NULL DEFAULT 0,event_count INTEGER NOT NULL DEFAULT 0,first_position INTEGER,last_position INTEGER,name TEXT,name_position INTEGER);
CREATE TABLE IF NOT EXISTS events(position INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,recording_id TEXT NOT NULL REFERENCES recordings(id),sequence INTEGER NOT NULL,line TEXT NOT NULL,normalized TEXT NOT NULL,bytes INTEGER NOT NULL,UNIQUE(recording_id,sequence));
CREATE INDEX IF NOT EXISTS events_trace_id ON events(coalesce(json_extract(normalized,'$.context.trace_id'),json_extract(normalized,'$.data.trace_id')),position);
CREATE INDEX IF NOT EXISTS events_recording_position ON events(recording_id,position);
CREATE INDEX IF NOT EXISTS recordings_session ON recordings(namespace,session,source_id);
CREATE TABLE IF NOT EXISTS checkpoints(key TEXT PRIMARY KEY,value TEXT NOT NULL);
PRAGMA user_version=3;`);
  const get = (k) =>
    prepare("select value from config where key=?").get(k)?.value;
  if (!get("collector_id"))
    db.transaction(() => {
      for (const [k, v] of Object.entries({
        collector_id: randomUUID(),
        browser_token: secret(),
        registry_revision: "0",
        event_bytes: "0",
      }))
        prepare("insert into config values (?,?)").run(k, v);
    })();
  config = {
    version: 2,
    collector_id: get("collector_id"),
    browser_token: get("browser_token"),
    sqlite_version: version.join("."),
  };
  prepare(
    "update sources set last_seen=NULL,status=?,reason='No recent producer presence; activity unknown' where revoked=0",
  ).run("Last seen with retained history");
  return { ...config, ...watermarks() };
}
function watermarks() {
  return {
    collector_id: config.collector_id,
    event_cursor: prepare(
      "select coalesce(max(position),0) n from events",
    ).get().n,
    registry_revision: Number(
      prepare("select value from config where key='registry_revision'").get()
        .value,
    ),
  };
}
function revision() {
  prepare(
    "update config set value=cast(value as integer)+1 where key='registry_revision'",
  ).run();
}
function metadata(m) {
  if (!m || m.version !== 2 || !["android", "ios", "web", "server"].includes(m.platform))
    fail(400, "Invalid source platform/version");
  for (const k of [
    "registration_id",
    "environment_id",
    "app_id",
    "installation_id",
  ])
    if (
      typeof m[k] !== "string" ||
      !m[k].length ||
      m[k].length > 256 ||
      /[\x00-\x1f]/.test(m[k])
    )
      fail(400, `Invalid ${k}`);
  if (m.platform === "web") {
    if (
      typeof m.journal_id !== "string" ||
      !m.journal_id ||
      m.journal_id.length > 256
    )
      fail(400, "Invalid journal ID");
    try {
      if (new URL(m.origin).origin !== m.origin)
        fail(400, "Exact web origin required");
    } catch {
      fail(400, "Invalid web origin");
    }
  }
  for (const k of ["environment_name", "instance_id", "journal_id"])
    if (m[k] != null && (typeof m[k] !== "string" || m[k].length > 256))
      fail(400, `Invalid ${k}`);
  return Object.fromEntries(
    [
      "platform",
      "environment_id",
      "environment_name",
      "app_id",
      "installation_id",
      "journal_id",
      "instance_id",
      "origin",
    ]
      .filter((k) => m[k] != null)
      .map((k) => [k, m[k]]),
  );
}
function authorize(token) {
  const c = prepare(
    "select s.* from credentials c join sources s on s.id=c.source_id where c.token=? and (c.expires is null or c.expires>?)",
  ).get(hash(token || ""), clockNow());
  if (!c || c.revoked) fail(401, "Source credential revoked or unknown");
  return c;
}
function physicalUsage() {
  let bytes = ["capture.sqlite", "capture.sqlite-wal"].reduce(
    (n, name) =>
      n +
      (existsSync(resolve(directory, name))
        ? lstatSync(resolve(directory, name)).size
        : 0),
    0,
  );
  const backups = resolve(directory, "backups");
  if (existsSync(backups)) {
    const stat = lstatSync(backups);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail(403, "Unsafe backup directory");
    const names = readdirSync(backups);
    if (names.length > 128) fail(507, "Backup file budget reached");
    for (const name of names) {
      const stat = lstatSync(resolve(backups, name));
      if (!stat.isFile() || stat.isSymbolicLink())
        fail(403, "Unsafe backup file");
      bytes += stat.size;
    }
  }
  return bytes;
}
function admit(newBytes, source) {
  const used = Number(
    prepare("select value from config where key='event_bytes'").get()?.value ||
      0,
  );
  if (
    used + newBytes > limits.journalBytes ||
    source.bytes + newBytes > limits.sourceBytes
  )
    fail(507, "Storage full; retained events remain available");
  if (availableBytes() < limits.freeReserve + newBytes)
    fail(507, "Storage free-space reserve reached");
  const physical = physicalUsage();
  if (physical + newBytes * 3 > limits.physicalBytes)
    fail(507, "Database/WAL disk budget reached");
}
const api = {
  authorize({ token }) {
    return { source_id: authorize(token).id };
  },
  ticket({ principal = "local", scope = {}, ttl = 600000, max_sources = 128 }) {
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      !Number.isSafeInteger(max_sources) ||
      !scope ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      Object.entries(scope).some(
        ([key, value]) =>
          ![
            "platform",
            "environment_id",
            "app_id",
            "installation_id",
            "journal_id",
            "origin",
          ].includes(key) ||
          typeof value !== "string" ||
          value.length > 256,
      ) ||
      typeof principal !== "string" ||
      principal.length > 256 ||
      max_sources < 1 ||
      max_sources > 128
    )
      fail(400, "Invalid grant");
    prepare("delete from tickets where recovery<?").run(clockNow());
    const token = secret();
    prepare("insert into tickets values (?,?,?,?,?,?,0)").run(
      hash(token),
      principal,
      stable(scope),
      clockNow() + Math.min(ttl, 600000),
      clockNow() + 1200000,
      max_sources,
    );
    return {
      enrollment_token: token,
      expires_at: clockNow() + Math.min(ttl, 600000),
    };
  },
  register({ token, metadata: m }) {
    const md = metadata(m);
    return db.transaction(() => {
      const t = prepare("select * from tickets where token=?").get(
        hash(token || ""),
      );
      if (!t) fail(401, "Unknown enrollment");
      // Recovery is still authorized by the supplied ticket's scope. A fresh
      // scoped ticket cannot recover credentials for another installation.
      const scope = JSON.parse(t.scope);
      for (const [k, v] of Object.entries(scope))
        if (md[k] !== v) fail(403, "Enrollment scope mismatch");
      const fp = stable(
        Object.fromEntries(
          Object.entries(md).filter(
            ([k]) =>
              k !== "instance_id" &&
              (md.platform === "web" || k !== "journal_id"),
          ),
        ),
      );
      const old = prepare(
        "select * from registrations where principal=? and operation=?",
      ).get(t.principal, m.registration_id);
      if (old) {
        if (old.fingerprint !== fp)
          fail(409, "Registration operation metadata conflict");
        if (clockNow() > t.recovery) fail(401, "Enrollment recovery expired");
        const result = JSON.parse(old.result);
        if (
          prepare("select revoked from sources where id=?").get(
            result.source_id,
          )?.revoked
        )
          fail(401, "Source revoked");
        return result;
      }
      if (clockNow() > t.expires) fail(401, "Enrollment expired");
      if (t.used >= t.max_sources)
        fail(429, "Enrollment operation limit reached");
      const key = stable([
        t.principal,
        md.platform,
        md.environment_id,
        md.app_id,
        md.installation_id,
        md.platform === "web" ? md.journal_id : null,
        md.origin ?? null,
      ]);
      let s = prepare("select * from sources where source_key=?").get(key);
      if (s?.revoked) fail(401, "Source revoked");
      if (!s) {
        if (
          t.used >= t.max_sources ||
          prepare("select count(*) n from sources").get().n >= limits.sources
        )
          fail(429, "Source enrollment limit reached");
        s = { id: randomUUID() };
        prepare(
          "insert into sources (id,source_key,principal,metadata,last_seen,status) values (?,?,?,?,?,?)",
        ).run(
          s.id,
          key,
          t.principal,
          stable(md),
          clockNow(),
          "Ready and waiting for events",
        );
        revision();
      }
      prepare("update tickets set used=used+1 where token=?").run(t.token);
      const source_token = secret();
      prepare("insert into credentials values (?,?,NULL)").run(
        hash(source_token),
        s.id,
      );
      const result = {
        version: 2,
        collector_id: config.collector_id,
        source_id: s.id,
        source_token,
      };
      prepare("insert into registrations values (?,?,?,?)").run(
        t.principal,
        m.registration_id,
        fp,
        JSON.stringify(result),
      );
      return { ...result, ...watermarks() };
    })();
  },
  bindLocal({ token, metadata: m }) {
    const md = metadata({ ...m, version: 2, registration_id: "local-bind" });
    if (md.platform === "web")
      fail(403, "Web source cannot be provisioned as native");
    return db.transaction(() => {
      const s = authorize(token);
      const old = JSON.parse(s.metadata);
      for (const key of ["platform", "app_id", "installation_id"])
        if (old[key] !== md[key])
          fail(409, "Existing pairing belongs to another installation/app");
      if (old.local_binding && old.local_binding !== md.environment_id)
        fail(
          409,
          "Installation credential already bound to another device; repair pairing",
        );
      if (
        old.environment_id !== md.environment_id ||
        old.environment_name !== md.environment_name ||
        !old.local_binding
      ) {
        const updated = {
          ...old,
          original_environment_id:
            old.original_environment_id || old.environment_id,
          environment_id: md.environment_id,
          environment_name: md.environment_name,
          local_binding: md.environment_id,
        };
        prepare("update sources set metadata=? where id=?").run(
          stable(updated),
          s.id,
        );
        revision();
      }
      return { source_id: s.id, ...watermarks() };
    })();
  },
  presence({ token, instance_id, status }) {
    return db.transaction(() => {
      const s = authorize(token);
      if (
        s.last_seen &&
        clockNow() - s.last_seen < 1000 &&
        ["Ready and waiting for events", "Delivering"].includes(s.status)
      )
        return { version: 2, source_id: s.id, ...watermarks() };
      if (status != null && (typeof status !== "string" || status.length > 256))
        fail(400, "Invalid status");
      prepare(
        "update sources set last_seen=?,status=?,reason=NULL where id=?",
      ).run(clockNow(), status || "Ready and waiting for events", s.id);
      revision();
      return { version: 2, source_id: s.id, ...watermarks() };
    })();
  },
  ingest({ token, text, checkpoint }) {
    if (typeof text !== "string" || Buffer.byteLength(text) > limits.batchBytes)
      fail(413, "Batch exceeds byte limit");
    if (!text.endsWith("\n")) fail(400, "Batch requires complete newline");
    const lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length || lines.length > limits.batchEvents)
      fail(400, "Batch requires 1-500 events");
    waitCommitGate();
    const parsed = lines.map((line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        fail(400, "Invalid JSON");
      }
      if (e.schema_version !== "1.3" || !validateEvent(e))
        fail(400, "Current capture schema 1.3 required");
      return {
        e,
        line,
        normalized: stable(e),
        bytes: Buffer.byteLength(line) + 1,
      };
    });
    return db.transaction(() => {
      const s = authorize(token);
      let accepted = 0,
        duplicates = 0,
        newBytes = 0;
      const pending = [];
      const seen = new Map();
      const identities = new Map();
      for (const p of parsed) {
        const { e } = p;
        let previous =
          prepare(
            "select normalized,recording_id from events where event_id=?",
          ).get(e.event_id) || seen.get(e.event_id);
        if (previous) {
          if (previous.normalized !== p.normalized)
            fail(409, "Conflicting event ID");
          const owner = prepare(
            "select source_id from recordings where id=?",
          ).get(e.recording_id);
          if (owner && owner.source_id !== s.id)
            fail(409, "Conflicting source attribution");
          duplicates++;
          continue;
        }
        const identity = stable([
          e.schema_version,
          e.session_namespace,
          e.session_id,
        ]);
        if (
          identities.has(e.recording_id) &&
          identities.get(e.recording_id) !== identity
        )
          fail(409, "Conflicting batch recording identity");
        identities.set(e.recording_id, identity);
        const record = prepare("select * from recordings where id=?").get(
          e.recording_id,
        );
        if (
          record &&
          (record.source_id !== s.id || record.identity !== identity)
        )
          fail(409, "Conflicting recording owner/identity");
        const sequence = prepare(
          "select event_id from events where recording_id=? and sequence=?",
        ).get(e.recording_id, e.sequence);
        if (
          sequence ||
          pending.some(
            (x) =>
              x.e.recording_id === e.recording_id &&
              x.e.sequence === e.sequence,
          )
        )
          fail(409, "Conflicting recording sequence");
        seen.set(e.event_id, p);
        pending.push(p);
        newBytes += p.bytes;
      }
      if (newBytes) admit(newBytes, s);
      for (const p of pending) {
        const e = p.e;
        prepare(
          "insert or ignore into recordings(id,source_id,identity,namespace,session) values (?,?,?,?,?)",
        ).run(
          e.recording_id,
          s.id,
          stable([e.schema_version, e.session_namespace, e.session_id]),
          e.session_namespace,
          e.session_id,
        );
        prepare(
          "insert into events(event_id,recording_id,sequence,line,normalized,bytes) values (?,?,?,?,?,?)",
        ).run(
          e.event_id,
          e.recording_id,
          e.sequence,
          p.line,
          p.normalized,
          p.bytes,
        );
        const position = prepare("select last_insert_rowid() p").get().p;
        prepare(
          "update recordings set event_count=event_count+1,first_position=coalesce(first_position,?),last_position=? where id=?",
        ).run(position, position, e.recording_id);
        if (e.event_type === "session.started")
          prepare(
            "update recordings set name=?,name_position=? where id=?",
          ).run(e.data.name, position, e.recording_id);
        accepted++;
      }
      prepare(
        "update config set value=cast(value as integer)+? where key='event_bytes'",
      ).run(newBytes);
      prepare(
        "update sources set bytes=bytes+?,last_seen=?,status=?,reason=NULL where id=?",
      ).run(newBytes, clockNow(), "Delivering", s.id);
      if (checkpoint)
        prepare("insert or replace into checkpoints values (?,?)").run(
          `${s.id}:${checkpoint.key}`,
          stable(checkpoint.value),
        );
      revision();
      const touched = [...new Set(parsed.map((p) => p.e.recording_id))];
      const recordings = touched.map((id) => {
        let contiguous = prepare(
          "select contiguous from recordings where id=?",
        ).get(id).contiguous;
        while (
          prepare(
            "select 1 from events where recording_id=? and sequence=?",
          ).get(id, contiguous + 1)
        )
          contiguous++;
        prepare("update recordings set contiguous=? where id=?").run(
          contiguous,
          id,
        );
        return { recording_id: id, highest_contiguous_sequence: contiguous };
      });
      const w = watermarks();
      return {
        version: 2,
        source_id: s.id,
        accepted,
        duplicates,
        acknowledged_event_ids: parsed.map((p) => p.e.event_id),
        cursor: w.event_cursor,
        recordings,
        ...w,
      };
    })();
  },
  sources({ after = "", limit = 1000, registry_revision } = {}) {
    const w = watermarks();
    if (registry_revision != null && registry_revision !== w.registry_revision)
      fail(409, "Registry changed; restart source pagination");
    if (
      typeof after !== "string" ||
      after.length > 256 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      fail(400, "Invalid source pagination");
    const L = Math.min(limit, 1000);
    const rows = prepare(
      "select id as source_id,metadata,last_seen,status,reason,bytes,revoked from sources where id>? order by id limit ?",
    ).all(after, L + 1);
    const sources = rows.slice(0, L).map((s) => {
      const md = JSON.parse(s.metadata);
      const expired = s.last_seen == null || clockNow() - s.last_seen > 30000;
      return {
        ...md,
        ...s,
        metadata: undefined,
        ...(expired &&
        !s.revoked &&
        ["Ready and waiting for events", "Delivering"].includes(s.status)
          ? {
              last_collection_status: s.status,
              status: "Last seen with retained history",
              reason: "No recent producer presence; activity unknown",
            }
          : {}),
      };
    });
    return {
      sources,
      next_after: sources.at(-1)?.source_id ?? after,
      has_more: rows.length > L,
      ...w,
    };
  },
  page({
    after = 0,
    high_water,
    source_id,
    session_namespace,
    session_id,
    limit = 500,
    trace_id, include_related = false,
  }) {
    const w = watermarks();
    const H = high_water ?? w.event_cursor;
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(H) ||
      H < after ||
      H > w.event_cursor
    )
      fail(400, "Invalid event cursor");
    if (!Number.isSafeInteger(limit) || limit < 1)
      fail(400, "Invalid page limit");
    if (trace_id != null && !/^(?!0{32}$)[0-9a-f]{32}$/.test(trace_id)) fail(400, "Invalid trace ID");
    const values = [source_id ?? null,source_id ?? null,session_namespace ?? null,session_namespace ?? null,session_id ?? null,session_id ?? null];
    let prefix = '', parameters = [], related = '';
    if (trace_id || include_related) {
      prefix = `with seed_traces as (select distinct coalesce(json_extract(seed.normalized,'$.context.trace_id'),json_extract(seed.normalized,'$.data.trace_id')) trace_id from events seed join recordings sr on sr.id=seed.recording_id where seed.position<=? and ${trace_id ? "coalesce(json_extract(seed.normalized,'$.context.trace_id'),json_extract(seed.normalized,'$.data.trace_id'))=?" : "(? is null or sr.source_id=?) and (? is null or sr.namespace=?) and (? is null or sr.session=?)"}), related_recordings as (select distinct linked.recording_id from seed_traces st join events linked on coalesce(json_extract(linked.normalized,'$.context.trace_id'),json_extract(linked.normalized,'$.data.trace_id'))=st.trace_id where linked.position<=?) `;
      parameters = [H,...(trace_id ? [trace_id] : values),H];
      related = ' or e.recording_id in (select recording_id from related_recordings)';
    }
    const rows = prepare(
      `${prefix}select e.position,case when (${trace_id ? '0 and' : ''} (? is null or r.source_id=?) and (? is null or r.namespace=?) and (? is null or r.session=?))${related} then e.line else NULL end line from events e join recordings r on r.id=e.recording_id where e.position>? and e.position<=? order by e.position limit ?`,
    ).iterate(...parameters,...values,after,H,Math.min(limit,500));
    let next = after,
      bytes = 0,
      found = false;
    const lines = [];
    for (const r of rows) {
      found = true;
      if (r.line !== null) {
        const size = Buffer.byteLength(r.line) + 1;
        if (lines.length && bytes + size > limits.batchBytes) break;
        lines.push(r.line);
        bytes += size;
      }
      next = r.position;
    }
    if (!found) next = H;
    return {
      lines,
      cursor: next,
      next_after: next,
      has_more: next < H,
      high_water: H,
      ...w,
    };
  },
  traceSeeds({source_id, session_namespace, session_id} = {}) {
    const rows = prepare("select distinct coalesce(json_extract(e.normalized,'$.context.trace_id'),json_extract(e.normalized,'$.data.trace_id')) trace_id from events e join recordings r on r.id=e.recording_id where coalesce(json_extract(e.normalized,'$.context.trace_id'),json_extract(e.normalized,'$.data.trace_id')) is not null and (? is null or r.source_id=?) and (? is null or r.namespace=?) and (? is null or r.session=?) limit 65").all(source_id ?? null,source_id ?? null,session_namespace ?? null,session_namespace ?? null,session_id ?? null,session_id ?? null);
    if (rows.length > 64) fail(400, "Selection exceeds 64 traces; narrow capture or specify trace_ids");
    return rows.map(x => x.trace_id);
  },
  sessions({ source_id, after = 0, limit = 100, high_water, latest = false, client_only = false }) {
    const w = watermarks();
    const H = high_water ?? w.event_cursor;
    if (
      !Number.isSafeInteger(H) ||
      H < 0 ||
      H > w.event_cursor ||
      !Number.isSafeInteger(after) ||
      after < 0
    )
      fail(400, "Invalid session watermark");
    const L = Math.min(limit, 100);
    const clientFilter = client_only ? " and source_id in (select id from sources where json_extract(metadata,'$.platform') <> 'server')" : '';
    let rows;
    if (H === w.event_cursor) {
      rows = prepare(
        `select namespace session_namespace,session session_id,min(first_position) first_position,max(last_position) last_position,sum(event_count) event_count,group_concat(distinct source_id) source_ids,max(name) name from recordings where (? is null or source_id=?)${clientFilter} group by namespace,session having max(last_position)>? order by last_position ${latest ? "desc" : "asc"} limit ?`,
      ).all(source_id ?? null, source_id ?? null, after, L);
    } else {
      rows = prepare(
        `select r.namespace session_namespace,r.session session_id,min(e.position) first_position,max(e.position) last_position,count(*) event_count,group_concat(distinct r.source_id) source_ids,max(case when r.name_position<=? then r.name end) name from recordings r join events e on e.recording_id=r.id where e.position<=? and (? is null or r.source_id=?)${clientFilter} group by r.namespace,r.session having max(e.position)>? order by last_position ${latest ? "desc" : "asc"} limit ?`,
      ).all(H, H, source_id ?? null, source_id ?? null, after, L);
    }
    return {
      sessions: rows.map((r) => ({
        ...r,
        source_ids: r.source_ids.split(","),
      })),
      next_after: rows.at(-1)?.last_position ?? after,
      has_more: rows.length === L,
      high_water: H,
      ...w,
    };
  },
  expirePresence({ now = clockNow() } = {}) {
    const updated = prepare(
      "update sources set status='Last seen with retained history',reason='No recent producer presence; activity unknown' where revoked=0 and status in ('Ready and waiting for events','Delivering') and (last_seen is null or last_seen<?)",
    ).run(now - 30000);
    if (updated.changes) revision();
    return { ...watermarks(), changed: updated.changes > 0 };
  },
  sourceStatus({ source_id, status, reason }) {
    if (
      typeof status !== "string" ||
      status.length > 256 ||
      typeof reason !== "string" ||
      reason.length > 1024
    )
      fail(400, "Invalid source status");
    prepare(
      "update sources set status=?,reason=? where id=? and revoked=0",
    ).run(status, reason, source_id);
    revision();
    return watermarks();
  },
  sourceReconciled({ token, reason }) {
    const s = authorize(token);
    if (typeof reason !== "string" || reason.length > 1024)
      fail(400, "Invalid reconciliation reason");
    const result = prepare(
      "update sources set status='Last seen with retained history',reason='Adapter recovered; producer activity unknown' where id=? and revoked=0 and status='Backlog retained' and reason=?",
    ).run(s.id, reason);
    if (result.changes) revision();
    return { ...watermarks(), changed: result.changes > 0 };
  },
  checkpoint({ source_id, key }) {
    return JSON.parse(
      prepare("select value from checkpoints where key=?").get(
        `${source_id}:${key}`,
      )?.value ?? "null",
    );
  },
  revoke({ source_id }) {
    prepare("update sources set revoked=1,status=? where id=?").run(
      "Permission required",
      source_id,
    );
    revision();
    return watermarks();
  },
  rotate({ source_id }) {
    const s = prepare("select * from sources where id=?").get(source_id);
    if (!s || s.revoked) fail(404, "Source unavailable");
    prepare(
      "update credentials set expires=? where source_id=? and expires is null",
    ).run(clockNow() + 60000, source_id);
    const source_token = secret();
    prepare("insert into credentials values (?,?,NULL)").run(
      hash(source_token),
      source_id,
    );
    return {
      version: 2,
      collector_id: config.collector_id,
      source_id,
      source_token,
    };
  },
  async backup() {
    const estimate = lstatSync(resolve(directory, "capture.sqlite")).size * 2;
    if (
      physicalUsage() + estimate > limits.physicalBytes ||
      availableBytes() < limits.freeReserve + estimate
    )
      fail(507, "Backup would exceed physical/free-space budget");
    const dir = resolve(directory, "backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      fail(403, "Unsafe backup directory");
    const path = resolve(dir, randomUUID() + ".sqlite");
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    try {
      if (
        testFilesystemFaults &&
        Atomics.exchange(new BigInt64Array(testFilesystemFaults), 1, 0n) === 1n
      )
        throw Object.assign(new Error("Backup disk-full write failure"), {
          status: 507,
          code: "ENOSPC",
        });
      await db.backup(path, { progress: () => 64 });
      return { path, collector_id: config.collector_id };
    } catch (e) {
      unlinkSync(path);
      throw e;
    }
  },
  status() {
    return {
      ...watermarks(),
      sqlite_version: config.sqlite_version,
      database_bytes: lstatSync(resolve(directory, "capture.sqlite")).size,
      wal_bytes: existsSync(resolve(directory, "capture.sqlite-wal"))
        ? lstatSync(resolve(directory, "capture.sqlite-wal")).size
        : 0,
      physical_bytes: physicalUsage(),
      limits,
    };
  },
  close() {
    db.pragma("wal_checkpoint(PASSIVE)");
    db.close();
    db = null;
    if (lockOwned) unlinkSync(resolve(directory, "collector.lock"));
    lockOwned = false;
    return true;
  },
};
try {
  parentPort.postMessage({ ready: init() });
} catch (e) {
  if (db) db.close();
  if (lockOwned) unlinkSync(resolve(directory, "collector.lock"));
  parentPort.postMessage({
    error: { message: e.message, status: errorStatus(e) },
  });
}
parentPort.on("message", async ({ id, op, args }) => {
  try {
    if (!api[op]) fail(400, "Unknown store operation");
    const result = await api[op](args || {});
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({
      id,
      error: { message: e.message, status: errorStatus(e) },
    });
  }
});
