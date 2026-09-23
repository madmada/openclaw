import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  executeWithCachedStatement,
  registerNodeSqliteDisposeCallback,
} from "./kysely-sync-cache-state.js";
import { runSqlitePinnedReadSnapshotSync } from "./sqlite-transaction.js";

export type SqliteSchemaFacts = {
  readonly revision: number;
  readonly userVersion: number;
  readonly schemaVersion: number;
  readonly tables: ReadonlySet<string>;
};

type SchemaOwner = {
  admitted: boolean;
  revision: number;
  facts?: SqliteSchemaFacts;
  dataVersion?: number;
  probed: boolean;
  transactionalSchema: boolean;
  authorizerActive: boolean;
};

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSchemaFacts"),
  () => new WeakMap<DatabaseSync, SchemaOwner>(),
);

function invalidate(owner: SchemaOwner): void {
  owner.revision += 1;
  owner.facts = undefined;
}

/** Schema publications outside DDL (such as a deferred version marker) share this revision. */
export function invalidateSqliteSchemaFacts(database: DatabaseSync): void {
  const owner = owners.get(database);
  if (owner) {
    invalidate(owner);
    owner.transactionalSchema ||= database.isTransaction;
  }
}

// Conservative matching also covers multi-statement migration batches and catalog repairs.
// False positives only revoke prepared facts; SQL is still executed by SQLite unchanged.
function changesSchema(sql: string): boolean {
  return /\b(?:CREATE|ALTER|DROP|REINDEX|VACUUM|ROLLBACK)\b|\bPRAGMA\b[\s\S]*\b(?:user_version|schema_version|writable_schema)\b[\s\S]*[=(]/i.test(
    sql,
  );
}

function callStatement<Result>(
  method: {
    (...parameters: SQLInputValue[]): Result;
    (named: Record<string, SQLInputValue>, ...parameters: SQLInputValue[]): Result;
  },
  [first, ...remaining]: [] | [SQLInputValue | Record<string, SQLInputValue>, ...SQLInputValue[]],
): Result {
  if (first === undefined) {
    return method();
  }
  if (typeof first === "object" && first !== null && !ArrayBuffer.isView(first)) {
    return method(first, ...remaining);
  }
  return method(first, ...remaining);
}

function trackSchemaChanges(database: DatabaseSync, owner: SchemaOwner): void {
  const settle = () => {
    if (owner.transactionalSchema && !database.isTransaction) {
      invalidate(owner);
      owner.transactionalSchema = false;
    }
  };
  const execute = <T>(operation: () => T, schemaChange: boolean): T => {
    // An implicit rollback may be followed by BEGIN before the next schema read.
    settle();
    if (schemaChange) {
      invalidateSqliteSchemaFacts(database);
    }
    try {
      return operation();
    } finally {
      // A failed batch can already have changed schema; rollback can reuse SQLite's cookie.
      if (schemaChange) {
        invalidateSqliteSchemaFacts(database);
      }
      settle();
    }
  };
  const exec = database.exec.bind(database);
  database.exec = (sql) => execute(() => exec(sql), changesSchema(sql));
  const prepare = database.prepare.bind(database);
  database.prepare = (...args) => {
    const [sql] = args;
    const statement = prepare(...args);
    const schemaChange = changesSchema(sql);
    if (schemaChange || /\b(?:BEGIN|SAVEPOINT|COMMIT|END|RELEASE)\b/i.test(sql)) {
      const run = statement.run.bind(statement);
      const get = statement.get.bind(statement);
      const all = statement.all.bind(statement);
      const iterate = statement.iterate.bind(statement);
      statement.run = (...args) => execute(() => callStatement(run, args), schemaChange);
      statement.get = (...args) => execute(() => callStatement(get, args), schemaChange);
      statement.all = (...args) => execute(() => callStatement(all, args), schemaChange);
      statement.iterate = function* (...args) {
        settle();
        if (schemaChange) {
          invalidateSqliteSchemaFacts(database);
        }
        try {
          yield* callStatement(iterate, args);
        } finally {
          if (schemaChange) {
            invalidateSqliteSchemaFacts(database);
          }
          settle();
        }
        return undefined;
      };
    }
    return statement;
  };
  if (typeof database.setAuthorizer === "function") {
    const setAuthorizer = database.setAuthorizer.bind(database);
    database.setAuthorizer = (callback) => {
      setAuthorizer(callback);
      owner.authorizerActive = callback !== null;
      invalidate(owner);
    };
  }
  registerNodeSqliteDisposeCallback(database, () => {
    invalidate(owner);
    owner.dataVersion = undefined;
    owner.probed = false;
  });
}

/** Cache freshness only: migration and snapshot before/after probes must remain uncached. */
export function readSqliteCacheDataVersion(database: DatabaseSync): number {
  const tracked = owners.get(database);
  const owner = tracked?.admitted ? tracked : undefined;
  if (owner?.probed && !owner.authorizerActive && owner.dataVersion !== undefined) {
    return owner.dataVersion;
  }
  const row = executeWithCachedStatement(database, "PRAGMA data_version", [], (statement) =>
    statement.get(),
  );
  if (typeof row?.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  if (owner) {
    if (owner.dataVersion !== row.data_version) {
      invalidate(owner);
      owner.dataVersion = row.data_version;
    }
    if (!owner.probed) {
      owner.probed = true;
      // Retain only the facts, never a native handle or statement, until the next turn.
      setImmediate(() => {
        owner.probed = false;
      }).unref();
    }
  }
  return row.data_version;
}

/** Install at native open, before callers can retain statements or install an authorizer. */
export function trackSqliteSchema(database: DatabaseSync): void {
  if (!owners.has(database)) {
    const owner: SchemaOwner = {
      admitted: false,
      revision: 0,
      probed: false,
      transactionalSchema: false,
      authorizerActive: false,
    };
    owners.set(database, owner);
    trackSchemaChanges(database, owner);
  }
}

/** Only database admission opts a connection into retained schema facts. */
export function admitSqliteSchema(database: DatabaseSync): void {
  const owner = owners.get(database);
  if (!owner) {
    throw new Error("SQLite schema admission requires a connection tracked from native open");
  }
  owner.admitted = true;
  getAdmittedSqliteSchemaFacts(database);
}

/** DDL and foreign commits revoke the admission; ordinary reads consume its recorded facts. */
export function getAdmittedSqliteSchemaFacts(
  database: DatabaseSync,
): SqliteSchemaFacts | undefined {
  const owner = owners.get(database);
  // Dynamic authorizer decisions cannot be represented by a cached schema result.
  if (!owner?.admitted || owner.authorizerActive) {
    return undefined;
  }
  readSqliteCacheDataVersion(database);
  if (owner.transactionalSchema && !database.isTransaction) {
    invalidate(owner);
    owner.transactionalSchema = false;
  }
  if (!owner.facts) {
    owner.facts = runSqlitePinnedReadSnapshotSync(database, () => {
      const userVersion = executeWithCachedStatement(database, "PRAGMA user_version", [], (s) =>
        s.get(),
      );
      const schemaVersion = executeWithCachedStatement(database, "PRAGMA schema_version", [], (s) =>
        s.get(),
      );
      const tables = executeWithCachedStatement(
        database,
        "SELECT name FROM main.sqlite_schema WHERE type = 'table'",
        [],
        (s) => s.all(),
      );
      return {
        revision: owner.revision,
        userVersion: Number(userVersion?.user_version ?? 0),
        schemaVersion: Number(schemaVersion?.schema_version),
        tables: new Set(tables.flatMap((row) => (typeof row.name === "string" ? [row.name] : []))),
      };
    });
  }
  return owner.facts;
}
