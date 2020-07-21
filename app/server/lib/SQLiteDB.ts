/**
 * SQLiteDB provides a clean Promise-based interface to SQLite along with an organized way to
 * specify the initial structure of the database and migrations when this structure changes.
 *
 * Here's a simple example,
 *
 *    const schemaInfo: SQLiteDB.SchemaInfo = {
 *      async create(db: SQLiteDB.SQLiteDB) {
 *        await db.exec("CREATE TABLE Foo (A TEXT)");
 *      },
 *      migrations: [
 *        async function(db: SQLiteDB.SQLiteDB) {
 *          await db.exec("CREATE TABLE Foo (A TEXT)");
 *        }
 *      ],
 *    }
 *    const db = await SQLiteDB.openDB("pathToDB", schemaInfo, SQLiteDB.OpenMode.OPEN_CREATE);
 *
 * Note how the create() function and the first migration are identical here. But they'll diverge
 * once we make a change to the schema. E.g. the next change could look like this:
 *
 *    const schemaInfo: SQLiteDB.SchemaInfo = {
 *      async create(db: SQLiteDB.SQLiteDB) {
 *        await db.exec("CREATE TABLE Foo (A TEXT, B NUMERIC)");
 *      },
 *      migrations: [
 *        async function(db: SQLiteDB.SQLiteDB) {
 *          await db.exec("CREATE TABLE Foo (A TEXT)");
 *        },
 *        async function(db: SQLiteDB.SQLiteDB) {
 *          await db.exec("ALTER TABLE Foo ADD COLUMN B NUMERIC");
 *        }
 *      ],
 *    }
 *    const db = await SQLiteDB.openDB("pathToDB", schemaInfo, SQLiteDB.OpenMode.OPEN_CREATE);
 *
 * Now a new document will have two columns. A document created with the first version of the code
 * will gain a second column when opened with the new code. If a migration happened during open,
 * you may examine two properties of the returned db object:
 *
 *    db.migrationBackupPath -- set to the path of the pre-migration backup file.
 *    db.migrationError -- set to the Error object if the migration failed.
 *
 * This module uses SQLite's "user_version" pragma to keep track of the version number of a
 * migration. It does not require, support, or record backwards migrations, but it will warn of
 * inconsistencies that may arise during development. In that case, remember you have a backup
 * from each migration.
 *
 * If you are starting with an existing unversioned DB, the first migration should have code to
 * bring such DBs to a common state.
 *
 *    const schemaInfo: SQLiteDB.SchemaInfo = {
 *      async create(db: SQLiteDB.SQLiteDB) {
 *        await db.exec("CREATE TABLE Foo (A TEXT)");
 *        await db.exec("CREATE TABLE Bar (B TEXT)");
 *      },
 *      migrations: [
 *        async function(db: SQLiteDB.SQLiteDB) {
 *          await db.exec("CREATE TABLE IF NOT EXISTS Foo (A TEXT)");
 *          await db.exec("CREATE TABLE IF NOT EXISTS Bar (B TEXT)");
 *        }
 *      ],
 *    }
 *    const db = await SQLiteDB.openDB("pathToDB", schemaInfo, SQLiteDB.OpenMode.OPEN_CREATE);
 *
 * Once using this module with versioning, future changes would be made by adding one item to the
 * "migrations" array, and modifying create() to create correct new documents.
 */

import {ErrorWithCode} from 'app/common/ErrorWithCode';
import {timeFormat} from 'app/common/timeFormat';
import * as docUtils from 'app/server/lib/docUtils';
import * as log from 'app/server/lib/log';
import {fromCallback} from 'app/server/lib/serverUtils';

import * as sqlite3 from '@gristlabs/sqlite3';
import * as assert from 'assert';
import {each} from 'bluebird';
import * as fse from 'fs-extra';
import fromPairs = require('lodash/fromPairs');
import isEqual = require('lodash/isEqual');
import noop = require('lodash/noop');
import range = require('lodash/range');

// Describes the result of get() and all() database methods.
export interface ResultRow {
  [column: string]: any;
}

// Describes how to create a new DB or migrate an old one. Any changes to the DB must be reflected
// in the 'create' function, and added as new entries in the 'migrations' array. Existing
// 'migration' entries may not be modified; they are used to migrate older DBs.
export interface SchemaInfo {
  // Creates a structure for a new DB (i.e. execs CREATE TABLE statements).
  readonly create: DBFunc;

  // List of functions that perform DB migrations from one version to the next. This array's
  // length determines the schema version, which is stored in user_version SQLite property.
  //
  // The very first migration should normally be identical to the original version of create().
  // I.e. initially SchemaInfo should be { create: X, migrations: [X] }, where the two X's
  // represent two copies of the same code. Don't go for code reuse here. When the schema is
  // modified, you will change it to { create: X2, migrations: [X, Y] }. Keeping the unchanged
  // copy of X is important as a reference to see that X + Y produces the same DB as X2.
  //
  // If you may open DBs created without versioning (e.g. predate use of this module), such DBs
  // will go through all migrations including the very first one. In this case, the first
  // migration's job is to bring any older DB to the same consistent state.
  readonly migrations: ReadonlyArray<DBFunc>;
}

export type DBFunc = (db: SQLiteDB) => Promise<void>;

export enum OpenMode {
  OPEN_CREATE,      // Open DB or create if doesn't exist (the default mode for sqlite3 module)
  OPEN_EXISTING,    // Open DB or fail if doesn't exist
  OPEN_READONLY,    // Open DB in read-only mode or fail if doens't exist.
  CREATE_EXCL,      // Create new DB or fail if it already exists.
}

/**
 * An interface implemented both by SQLiteDB and DocStorage (by forwarding).  Methods
 * documented in SQLiteDB.
 */
export interface ISQLiteDB {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: any[]): Promise<void>;
  get(sql: string, ...params: any[]): Promise<ResultRow|undefined>;
  all(sql: string, ...params: any[]): Promise<ResultRow[]>;
  prepare(sql: string, ...params: any[]): Promise<sqlite3.Statement>;
  execTransaction<T>(callback: () => Promise<T>): Promise<T>;
  runAndGetId(sql: string, ...params: any[]): Promise<number>;
  requestVacuum(): Promise<boolean>;
}

/**
 * Wrapper around sqlite3.Database. This class provides many of the same methods, but promisified.
 * In addition, it offers:
 *
 *    SQLiteDB.openDB(): Opens a DB, and initialize or migrate it to correct schema.
 *    db.execTransaction(cb): Runs a callback in the context of a new DB transaction.
 */
export class SQLiteDB {
  /**
   * Opens a database or creates a new one, according to OpenMode enum. The schemaInfo specifies
   * how to initialize a new database, and how to migrate an existing one from an older version.
   * If the database was migrated, its "migrationBackupPath" property will be set.
   *
   * If a migration was needed but failed, the DB remains unchanged, and gets opened anyway.
   * We report the migration error, and expose it via .migrationError property.
   */
  public static async openDB(dbPath: string, schemaInfo: SchemaInfo,
                             mode: OpenMode = OpenMode.OPEN_CREATE): Promise<SQLiteDB> {
    const db = await SQLiteDB.openDBRaw(dbPath, mode);
    const userVersion: number = await db.getMigrationVersion();

    // It's possible that userVersion is 0 for a non-empty DB if it was created without this
    // module. In that case, we apply migrations starting with the first one.
    if (userVersion === 0 && (await isEmpty(db))) {
      await db._initNewDB(schemaInfo);
    } else if (mode === OpenMode.CREATE_EXCL) {
      await db.close();
      throw new ErrorWithCode('EEXISTS', `EEXISTS: Database already exists: ${dbPath}`);
    } else {
      // Don't attempt migrations in OPEN_READONLY mode.
      if (mode === OpenMode.OPEN_READONLY) {
        const targetVer: number = schemaInfo.migrations.length;
        if (userVersion < targetVer) {
          db._migrationError = new Error(`SQLiteDB[${dbPath}] needs migration but is readonly`);
        }
      } else {
        try {
          db._migrationBackupPath = await db._migrate(userVersion, schemaInfo);
        } catch (err) {
          db._migrationError = err;
        }
      }
      await db._reportSchemaDiscrepancies(schemaInfo);
    }
    return db;
  }

  /**
   * Opens a database or creates a new one according to OpenMode value. Does not check for or do
   * any migrations.
   */
  public static async openDBRaw(dbPath: string,
                                mode: OpenMode = OpenMode.OPEN_CREATE): Promise<SQLiteDB> {
    const sqliteMode: number =
      // tslint:disable-next-line:no-bitwise
      (mode === OpenMode.OPEN_READONLY ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE) |
      (mode === OpenMode.OPEN_CREATE || mode === OpenMode.CREATE_EXCL ? sqlite3.OPEN_CREATE : 0);

    let _db: sqlite3.Database;
    await fromCallback(cb => { _db = new sqlite3.Database(dbPath, sqliteMode, cb); });

    if (SQLiteDB._addOpens(dbPath, 1) > 1) {
      log.warn("SQLiteDB[%s] avoid opening same DB more than once", dbPath);
    }
    return new SQLiteDB(_db!, dbPath);
  }

  /**
   * Reads the migration version from the database without any attempts to migrate it.
   */
  public static async getMigrationVersion(dbPath: string): Promise<number> {
    const db = await SQLiteDB.openDBRaw(dbPath, OpenMode.OPEN_READONLY);
    try {
      return await db.getMigrationVersion();
    } finally {
      await db.close();
    }
  }

  // It is a bad idea to open the same database file multiple times, because simultaneous use can
  // cause SQLITE_BUSY errors, and artificial delays (default of 1 sec) when there is contention.
  // We keep track of open DB paths, and warn if one is opened multiple times.
  private static _openPaths: Map<string, number> = new Map();

  // Convert the "create" function from schemaInfo into a DBMetadata object that describes the
  // tables, columns, and types. This is used for checking if an open database matches the
  // schema we expect, including after a migration, and reporting discrepancies.
  private static async _getExpectedMetadata(schemaInfo: SchemaInfo): Promise<DBMetadata> {
    // We cache the result and associate it with the create function, since it's not that cheap to
    // build. To build the metadata, we open an in-memory DB and apply "create" function to it.
    // Note that for tiny DBs it takes <10ms.
    if (!dbMetadataCache.has(schemaInfo.create)) {
      const db = await SQLiteDB.openDB(':memory:', schemaInfo, OpenMode.CREATE_EXCL);
      dbMetadataCache.set(schemaInfo.create, await db.collectMetadata());
      await db.close();
    }
    return dbMetadataCache.get(schemaInfo.create)!;
  }

  // Private helper to keep track of opens for the same path. Returns the number of times this
  // path is open, after adding the delta. Use delta of +1 for open, -1 for close.
  private static _addOpens(dbPath: string, delta: number): number {
    const newCount = (SQLiteDB._openPaths.get(dbPath) || 0) + delta;
    if (newCount > 0) {
      SQLiteDB._openPaths.set(dbPath, newCount);
    } else {
      SQLiteDB._openPaths.delete(dbPath);
    }
    return newCount;
  }


  private _prevTransaction: Promise<any> = Promise.resolve();
  private _inTransaction: boolean = false;
  private _migrationBackupPath: string|null = null;
  private _migrationError: Error|null = null;
  private _needVacuum: boolean = false;

  private constructor(private _db: sqlite3.Database, private _dbPath: string) {
    // Default database to serialized execution. See https://github.com/mapbox/node-sqlite3/wiki/Control-Flow
    // This isn't enough for transactions, which we serialize explicitly.
    this._db.serialize();
  }


  /**
   * If a DB was migrated on open, this will be set to the path of the pre-migration backup copy.
   * If migration failed, open throws with unchanged DB and no backup file.
   */
  public get migrationBackupPath(): string|null { return this._migrationBackupPath; }

  /**
   * If a needed migration failed, the DB will be opened anyway, with this property set to the
   * error. E.g. you may use it like so:
   *    sdb = await SQLiteDB.openDB(...)
   *    if (sdb.migrationError) { throw sdb.migrationError; }
   */
  public get migrationError(): Error|null { return this._migrationError; }

  // The following methods mirror https://github.com/mapbox/node-sqlite3/wiki/API, but return
  // Promises. We use fromCallback() rather than use promisify, to get better type-checking.

  public exec(sql: string): Promise<void> {
    return fromCallback(cb => this._db.exec(sql, cb));
  }

  public run(sql: string, ...params: any[]): Promise<void> {
    return fromCallback(cb => this._db.run(sql, ...params, cb));
  }

  public get(sql: string, ...params: any[]): Promise<ResultRow|undefined> {
    return fromCallback(cb => this._db.get(sql, ...params, cb));
  }

  public all(sql: string, ...params: any[]): Promise<ResultRow[]> {
    return fromCallback(cb => this._db.all(sql, ...params, cb));
  }

  public allMarshal(sql: string, ...params: any[]): Promise<Buffer> {
    // allMarshal isn't in the typings, because it is our addition to our fork of sqlite3 JS lib.
    return fromCallback(cb => (this._db as any).allMarshal(sql, ...params, cb));
  }

  public prepare(sql: string, ...params: any[]): Promise<sqlite3.Statement> {
    let stmt: sqlite3.Statement;
    // The original interface is a little strange; we resolve to Statement if prepare() succeeded.
    return fromCallback(cb => { stmt = this._db.prepare(sql, ...params, cb); }).then(() => stmt);
  }

  /**
   * VACUUM the DB either immediately or, if in a transaction, after that transaction.
   */
  public async requestVacuum(): Promise<boolean> {
    if (this._inTransaction) {
      this._needVacuum = true;
      return false;
    }
    await this.exec("VACUUM");
    log.info("SQLiteDB[%s]: DB VACUUMed", this._dbPath);
    this._needVacuum = false;
    return true;
  }

  /**
   * Run each of the statements in turn. Each statement is either a string, or an array of arguments
   * to db.run, e.g. [sqlString, [params...]].
   */
  public runEach(...statements: Array<string | [string, any[]]>): Promise<void> {
    return each(statements, (stmt: any) => {
      return (Array.isArray(stmt) ? this.run(stmt[0], ...stmt[1]) :
              this.exec(stmt))
        .catch(err => { log.warn(`SQLiteDB: Failed to run ${stmt}`); throw err; });
    });
  }

  public close(): Promise<void> {
    return fromCallback(cb => this._db.close(cb))
    .then(() => { SQLiteDB._addOpens(this._dbPath, -1); });
  }

  /**
   * As for run(), but captures the last_insert_rowid after the statement executes.  This
   * is sqlite's rowid for the last insert made on this database connection. This method
   * is only useful if the sql is actually an INSERT operation, but we don't check this.
   */
  public runAndGetId(sql: string, ...params: any[]): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this._db.run(sql, ...params, function(this: any, err: any) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  /**
   * Runs callback() in the context of a new DB transaction, committing on success and rolling
   * back on error in the callback. The callback may return a promise, which will be waited for.
   * The callback is called with no arguments.
   *
   * This method can be nested.  The result is one big merged transaction that will succeed or
   * roll back as a single unit.
   */
  public async execTransaction<T>(callback: () => Promise<T>): Promise<T> {
    if (this._inTransaction) {
      return callback();
    }
    let outerResult;
    try {
      outerResult = await (this._prevTransaction = this._execTransactionImpl(async () => {
        this._inTransaction = true;
        let innerResult;
        try {
          innerResult = await callback();
        } finally {
          this._inTransaction = false;
        }
        return innerResult;
      }));
    } finally {
      if (this._needVacuum) {
        await this.requestVacuum();
      }
    }
    return outerResult;
  }

  /**
   * Returns the 'user_version' saved in the database that reflects the current DB schema. It is 0
   * initially, and we update it to 1 or higher when initializing or migrating the database.
   */
  public async getMigrationVersion(): Promise<number> {
    const row = await this.get("PRAGMA user_version");
    return (row && row.user_version) || 0;
  }

  /**
   * Creates a DBMetadata object mapping DB's table names to column names to column types. Used
   * for reporting discrepancies in DB schema, and exposed for tests.
   *
   * Optionally, a list of table names can be supplied, and metadata will be omitted for any
   * tables not named in that list.
   */
  public async collectMetadata(names?: string[]): Promise<DBMetadata> {
    const tables = await this.all("SELECT name FROM sqlite_master WHERE type='table'");
    const metadata: DBMetadata = {};
    for (const t of tables) {
      if (names && !names.includes(t.name)) { continue; }
      const infoRows = await this.all(`PRAGMA table_info(${quoteIdent(t.name)})`);
      const columns = fromPairs(infoRows.map(r => [r.name, r.type]));
      metadata[t.name] = columns;
    }
    return metadata;
  }

  // Implementation of execTransction.
  private async _execTransactionImpl<T>(callback: () => Promise<T>): Promise<T> {
    // We need to swallow errors, so that one failed transaction doesn't cause the next one to fail.
    await this._prevTransaction.catch(noop);
    await this.exec("BEGIN");
    try {
      const value = await callback();
      await this.exec("COMMIT");
      return value;
    } catch (err) {
      try {
        await this.exec("ROLLBACK");
      } catch (rollbackErr) {
        log.error("SQLiteDB[%s]: Rollback failed: %s", this._dbPath, rollbackErr);
      }
      throw err;    // Throw the original error from the transaction.
    }
  }

  /**
   * Applies schemaInfo.create function to initialize a new DB.
   */
  private async _initNewDB(schemaInfo: SchemaInfo): Promise<void> {
    await this.execTransaction(async () => {
      const targetVer: number = schemaInfo.migrations.length;
      await schemaInfo.create(this);
      await this.exec(`PRAGMA user_version = ${targetVer}`);
    });
  }

  /**
   * Applies migrations to this database according to MigrationInfo. In all cases, checks the
   * database schema against MigrationInfo.currentSchema, and warns of discrepancies.
   *
   * If migration succeeded, it leaves a backup file and returns its path. If no migration was
   * needed, returns null. If migration failed, leaves DB unchanged and throws Error.
   */
  private async _migrate(actualVer: number, schemaInfo: SchemaInfo): Promise<string|null> {
    const targetVer: number = schemaInfo.migrations.length;
    let backupPath: string|null = null;

    if (actualVer > targetVer) {
      log.warn("SQLiteDB[%s]: DB is at version %s ahead of target version %s",
        this._dbPath, actualVer, targetVer);
    } else if (actualVer < targetVer) {
      log.info("SQLiteDB[%s]: DB needs migration from version %s to %s",
        this._dbPath, actualVer, targetVer);
      const versions = range(actualVer, targetVer);
      backupPath = await createBackupFile(this._dbPath, actualVer);
      try {
        await this.execTransaction(async () => {
          for (const versionNum of versions) {
            await schemaInfo.migrations[versionNum](this);
          }
          await this.exec(`PRAGMA user_version = ${targetVer}`);
        });
        // After a migration, reduce the sqlite file size. This must be run outside a transaction.
        await this.run("VACUUM");

        log.info("SQLiteDB[%s]: DB backed up to %s, migrated to %s",
          this._dbPath, backupPath, targetVer);
      } catch (err) {
        // If the transaction failed, we trust SQLite to have left the DB in unmodified state, so
        // we remove the pointless backup.
        await fse.remove(backupPath);
        backupPath = null;
        log.warn("SQLiteDB[%s]: DB migration from %s to %s failed: %s",
          this._dbPath, actualVer, targetVer, err);
        err.message = `SQLiteDB[${this._dbPath}] migration to ${targetVer} failed: ${err.message}`;
        throw err;
      }
    }
    return backupPath;
  }

  private async _reportSchemaDiscrepancies(schemaInfo: SchemaInfo): Promise<void> {
    // Regardless of where we started, warn if DB doesn't match expected schema.
    const expected = await SQLiteDB._getExpectedMetadata(schemaInfo);
    const metadata = await this.collectMetadata(Object.keys(expected));
    for (const tname in expected) {
      if (expected.hasOwnProperty(tname) && !isEqual(metadata[tname], expected[tname])) {
        log.warn("SQLiteDB[%s]: table %s does not match schema: %s != %s",
          this._dbPath, tname, JSON.stringify(metadata[tname]), JSON.stringify(expected[tname]));
      }
    }
  }
}

// Every SchemaInfo.create function determines a DB structure. We can get it by initializing a
// dummy DB, and we use it to do sanity checking, in particular after migrations. To avoid
// creating dummy DBs multiple times, the result is cached, keyed by the "create" function itself.
const dbMetadataCache: Map<DBFunc, DBMetadata> = new Map();
interface DBMetadata {
  [tableName: string]: {
    [colName: string]: string;      // Maps column name to SQLite type, e.g. "TEXT".
  };
}

// Helper to see if a database is empty.
async function isEmpty(db: SQLiteDB): Promise<boolean> {
  return (await db.get("SELECT count(*) as count FROM sqlite_master"))!.count === 0;
}

/**
 * Copies filePath to "filePath.YYYY-MM-DD.V0[-N].bak", adding "-N" suffix (starting at "-2") if
 * needed to ensure the path is new. Returns the backup path.
 */
async function createBackupFile(filePath: string, versionNum: number): Promise<string> {
  const backupPath = await docUtils.createNumberedTemplate(
   `${filePath}.${timeFormat('D', new Date())}.V${versionNum}{NUM}.bak`,
    docUtils.createExclusive);
  await docUtils.copyFile(filePath, backupPath);
  return backupPath;
}

/**
 * Validate and quote SQL identifiers such as table and column names.
 */
export function quoteIdent(ident: string): string {
  assert(/^\w+$/.test(ident), `SQL identifier is not valid: ${ident}`);
  return `"${ident}"`;
}
