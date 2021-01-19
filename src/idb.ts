import {
  filterObject,
  omitKeys,
  sortObjects,
  arrayEqual,
  transformSubObjectFilters,
} from "./utils";
import type { KintoObject, RecordStatus } from "./types";

const INDEXED_FIELDS = ["id", "_status", "last_modified"];

export interface StorageProxy<
  T extends { id: string; last_modified?: number; _status?: RecordStatus }
> {
  create: (record: T) => void;
  update: (record: T & { id: string }) => any;
  delete: (id: string) => void;
  get: (id: string) => T | undefined;
}

export abstract class AbstractBaseAdapter<
  B extends { id: string; last_modified?: number; _status?: RecordStatus }
> {
  abstract execute<T>(
    callback: (proxy: StorageProxy<B>) => T,
    options: { preload: string[] }
  ): Promise<T>;
  abstract get(id: string): Promise<any>;
  abstract list(params: {
    filters: { [key: string]: any };
    order?: string;
  }): Promise<any[]>;
  abstract saveLastModified(
    lastModified?: number | null
  ): Promise<number | null>;
  abstract getLastModified(): Promise<number | null>;
  abstract saveMetadata(
    metadata: Record<string, unknown> | null
  ): Promise<Record<string, unknown> | null | undefined>;
  abstract getMetadata<T>(): Promise<T>;
}

/**
 * Small helper that wraps the opening of an IndexedDB into a Promise.
 *
 * @param dbname          {String}   The database name.
 * @param version         {Integer}  Schema version
 * @param onupgradeneeded {Function} The callback to execute if schema is
 *                                   missing or different.
 * @return {Promise<IDBDatabase>}
 */
export async function open(
  dbname: string,
  {
    version,
    onupgradeneeded,
  }: {
    version?: number;
    onupgradeneeded: (event: IDBVersionChangeEvent) => void;
  }
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbname, version);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      db.onerror = (event) => reject(request.error);
      // When an upgrade is needed, a transaction is started.
      const transaction = request.transaction!;
      transaction.onabort = (event) => {
        const error =
          request.error ||
          transaction.error ||
          new DOMException("The operation has been aborted", "AbortError");
        reject(error);
      };
      // Callback for store creation etc.
      return onupgradeneeded(event);
    };
    request.onerror = (event) => {
      reject((event.target as IDBRequest).error);
    };
    request.onsuccess = (event) => {
      const db = request.result;
      resolve(db);
    };
  });
}

/**
 * Helper to run the specified callback in a single transaction on the
 * specified store.
 * The helper focuses on transaction wrapping into a promise.
 *
 * @param db           {IDBDatabase} The database instance.
 * @param name         {String}      The store name.
 * @param callback     {Function}    The piece of code to execute in the transaction.
 * @param options      {Object}      Options.
 * @param options.mode {String}      Transaction mode (default: read).
 * @return {Promise} any value returned by the callback.
 */
export async function execute(
  db: IDBDatabase,
  name: string,
  callback: (store: IDBObjectStore, abort?: (...args: any[]) => any) => any,
  options: { mode?: IDBTransactionMode } = {}
): Promise<unknown> {
  const { mode } = options;
  return new Promise((resolve, reject) => {
    // On Safari, calling IDBDatabase.transaction with mode == undefined raises
    // a TypeError.
    const transaction = mode
      ? db.transaction([name], mode)
      : db.transaction([name]);
    const store = transaction.objectStore(name);

    // Let the callback abort this transaction.
    const abort = (e: any) => {
      transaction.abort();
      console.error(e);
      reject(e);
    };
    // Execute the specified callback **synchronously**.
    let result: unknown;
    try {
      result = callback(store, abort);
    } catch (e) {
      abort(e);
    }
    transaction.onerror = (event) =>
      reject((event.target as IDBTransaction).error);
    transaction.oncomplete = (event) => resolve(result);
    transaction.onabort = (event) => {
      const error =
        (event.target as IDBTransaction).error ||
        transaction.error ||
        new DOMException("The operation has been aborted", "AbortError");
      reject(error);
    };
  });
}

/**
 * IDB cursor handlers.
 * @type {Object}
 */
const cursorHandlers = {
  all(
    filters: {
      [key: string]: any;
    },
    done: (records: KintoObject[]) => void
  ) {
    const results: KintoObject[] = [];
    return (event: Event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const { value } = cursor;
        if (filterObject(filters, value)) {
          results.push(value);
        }
        cursor.continue();
      } else {
        done(results);
      }
    };
  },

  in(
    values: any[],
    filters: {
      [key: string]: any;
    },
    done: (records: KintoObject[]) => void
  ) {
    const results: KintoObject[] = [];
    let i = 0;
    return function (event: Event) {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (!cursor) {
        done(results);
        return;
      }
      const { key, value } = cursor;
      // `key` can be an array of two values (see `keyPath` in indices definitions).
      // `values` can be an array of arrays if we filter using an index whose key path
      // is an array (eg. `cursorHandlers.in([["bid/cid", 42], ["bid/cid", 43]], ...)`)
      while (key > values[i]) {
        // The cursor has passed beyond this key. Check next.
        ++i;
        if (i === values.length) {
          done(results); // There is no next. Stop searching.
          return;
        }
      }
      const isEqual = Array.isArray(key)
        ? arrayEqual(key, values[i])
        : key === values[i];
      if (isEqual) {
        if (filterObject(filters, value)) {
          results.push(value);
        }
        cursor.continue();
      } else {
        cursor.continue(values[i]);
      }
    };
  },
};

/**
 * Creates an IDB request and attach it the appropriate cursor event handler to
 * perform a list query.
 *
 * Multiple matching values are handled by passing an array.
 *
 * @param  {String}           cid        The collection id (ie. `{bid}/{cid}`)
 * @param  {IDBStore}         store      The IDB store.
 * @param  {Object}           filters    Filter the records by field.
 * @param  {Function}         done       The operation completion handler.
 * @return {IDBRequest}
 */
function createListRequest(
  cid: string,
  store: IDBObjectStore,
  filters: {
    [key: string]: any;
  },
  done: (records: KintoObject[]) => void
) {
  const filterFields = Object.keys(filters);

  // If no filters, get all results in one bulk.
  if (filterFields.length === 0) {
    const request = store.index("cid").getAll(IDBKeyRange.only(cid));
    request.onsuccess = (event) => done((event.target as IDBRequest).result);
    return request;
  }

  // Introspect filters and check if they leverage an indexed field.
  const indexField = filterFields.find((field) => {
    return INDEXED_FIELDS.includes(field);
  });

  if (!indexField) {
    // Iterate on all records for this collection (ie. cid)
    const isSubQuery = Object.keys(filters).some((key) => key.includes(".")); // (ie. filters: {"article.title": "hello"})
    if (isSubQuery) {
      const newFilter = transformSubObjectFilters(filters);
      const request = store.index("cid").openCursor(IDBKeyRange.only(cid));
      request.onsuccess = cursorHandlers.all(newFilter, done);
      return request;
    }

    const request = store.index("cid").openCursor(IDBKeyRange.only(cid));
    request.onsuccess = cursorHandlers.all(filters, done);
    return request;
  }
  // If `indexField` was used already, don't filter again.
  const remainingFilters = omitKeys(filters, [indexField]);

  // value specified in the filter (eg. `filters: { _status: ["created", "updated"] }`)
  const value = filters[indexField];
  // For the "id" field, use the primary key.
  const indexStore = indexField === "id" ? store : store.index(indexField);

  // WHERE IN equivalent clause
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return done([]);
    }
    const values = value.map((i) => [cid, i]).sort();
    const range = IDBKeyRange.bound(values[0], values[values.length - 1]);
    const request = indexStore.openCursor(range);
    request.onsuccess = cursorHandlers.in(values, remainingFilters, done);
    return request;
  }

  // If no filters on custom attribute, get all results in one bulk.
  if (Object.keys(remainingFilters).length === 0) {
    const request = indexStore.getAll(IDBKeyRange.only([cid, value]));
    request.onsuccess = (event: Event) =>
      done((event.target as IDBRequest).result);
    return request;
  }

  // WHERE field = value clause
  const request = indexStore.openCursor(IDBKeyRange.only([cid, value]));
  request.onsuccess = cursorHandlers.all(remainingFilters, done);
  return request;
}

class IDBError extends Error {
  constructor(method: string, err: Error) {
    super(`IndexedDB ${method}() ${err.message}`);
    this.name = err.name;
    this.stack = err.stack;
  }
}

/**
 * IndexedDB adapter.
 *
 * This adapter doesn't support any options.
 */
export default class IDB<
  B extends { id: string; last_modified?: number; _status?: RecordStatus }
> implements AbstractBaseAdapter<B> {
  private _db: IDBDatabase | null;
  public cid: string;
  public dbName: string;
  private _options: { dbName?: string; migrateOldData?: boolean };

  /* Expose the IDBError class publicly */
  static get IDBError(): typeof IDBError {
    return IDBError;
  }

  /**
   * Constructor.
   *
   * @param  {String} cid  The key base for this collection (eg. `bid/cid`)
   * @param  {Object} options
   * @param  {String} options.dbName         The IndexedDB name (default: `"KintoDB"`)
   * @param  {String} options.migrateOldData Whether old database data should be migrated (default: `false`)
   */
  constructor(
    cid: string,
    options: { dbName?: string; migrateOldData?: boolean } = {}
  ) {
    // super();

    this.cid = cid;
    this.dbName = options.dbName || "KintoDB";

    this._options = options;
    this._db = null;
  }

  _handleError(method: string, err: Error): void {
    throw new IDBError(method, err);
  }

  /**
   * Ensures a connection to the IndexedDB database has been opened.
   *
   * @override
   * @return {Promise}
   */
  async open(): Promise<IDB<B>> {
    if (this._db) {
      return this;
    }

    this._db = await open(this.dbName, {
      version: 2,
      onupgradeneeded: (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBRequest<IDBDatabase>).result;

        if (event.oldVersion < 1) {
          // Records store
          const recordsStore = db.createObjectStore("records", {
            keyPath: ["_cid", "id"],
          });
          // An index to obtain all the records in a collection.
          recordsStore.createIndex("cid", "_cid");
          // Here we create indices for every known field in records by collection.
          // Local record status ("synced", "created", "updated", "deleted")
          recordsStore.createIndex("_status", ["_cid", "_status"]);
          // Last modified field
          recordsStore.createIndex("last_modified", ["_cid", "last_modified"]);
          // Timestamps store
          db.createObjectStore("timestamps", {
            keyPath: "cid",
          });
        }

        if (event.oldVersion < 2) {
          // Collections store
          db.createObjectStore("collections", {
            keyPath: "cid",
          });
        }
      },
    });

    return this;
  }

  /**
   * Closes current connection to the database.
   *
   * @override
   * @return {Promise}
   */
  close(): Promise<void> {
    if (this._db) {
      this._db.close(); // indexedDB.close is synchronous
      this._db = null;
    }
    return Promise.resolve();
  }

  /**
   * Returns a transaction and an object store for a store name.
   *
   * To determine if a transaction has completed successfully, we should rather
   * listen to the transaction’s complete event rather than the IDBObjectStore
   * request’s success event, because the transaction may still fail after the
   * success event fires.
   *
   * @param  {String}      name  Store name
   * @param  {Function}    callback to execute
   * @param  {Object}      options Options
   * @param  {String}      options.mode  Transaction mode ("readwrite" or undefined)
   * @return {Object}
   */
  async prepare(
    name: string,
    callback: (store: IDBObjectStore, abort?: (...args: any[]) => any) => any,
    options?: { mode?: IDBTransactionMode }
  ): Promise<void> {
    await this.open();
    await execute(this._db!, name, callback, options);
  }

  /**
   * Executes the set of synchronous CRUD operations described in the provided
   * callback within an IndexedDB transaction, for current db store.
   *
   * The callback will be provided an object exposing the following synchronous
   * CRUD operation methods: get, create, update, delete.
   *
   * Important note: because limitations in IndexedDB implementations, no
   * asynchronous code should be performed within the provided callback; the
   * promise will therefore be rejected if the callback returns a Promise.
   *
   * Options:
   * - {Array} preload: The list of record IDs to fetch and make available to
   *   the transaction object get() method (default: [])
   *
   * @example
   * const db = new IDB("example");
   * const result = await db.execute(transaction => {
   *   transaction.create({id: 1, title: "foo"});
   *   transaction.update({id: 2, title: "bar"});
   *   transaction.delete(3);
   *   return "foo";
   * });
   *
   * @override
   * @param  {Function} callback The operation description callback.
   * @param  {Object}   options  The options object.
   * @return {Promise}
   */
  async execute<T>(
    callback: (proxy: StorageProxy<B>) => T,
    options: { preload: string[] } = { preload: [] }
  ): Promise<T> {
    // Transactions in IndexedDB are autocommited when a callback does not
    // perform any additional operation.
    // The way Promises are implemented in Firefox (see https://bugzilla.mozilla.org/show_bug.cgi?id=1193394)
    // prevents using within an opened transaction.
    // To avoid managing asynchronocity in the specified `callback`, we preload
    // a list of record in order to execute the `callback` synchronously.
    // See also:
    // - http://stackoverflow.com/a/28388805/330911
    // - http://stackoverflow.com/a/10405196
    // - https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/
    let result: T;
    await this.prepare(
      "records",
      (store, abort) => {
        const runCallback = (preloaded = {}) => {
          // Expose a consistent API for every adapter instead of raw store methods.
          const proxy = transactionProxy(this, store, preloaded);
          // The callback is executed synchronously within the same transaction.
          try {
            const returned = callback(proxy);
            if (returned instanceof Promise) {
              // XXX: investigate how to provide documentation details in error.
              throw new Error(
                "execute() callback should not return a Promise."
              );
            }
            // Bring to scope that will be returned (once promise awaited).
            result = returned;
          } catch (e) {
            // The callback has thrown an error explicitly. Abort transaction cleanly.
            abort && abort(e);
          }
        };

        // No option to preload records, go straight to `callback`.
        if (!options.preload) {
          return runCallback();
        }

        // Preload specified records using a list request.
        const filters = { id: options.preload };
        createListRequest(this.cid, store, filters, (records) => {
          // Store obtained records by id.
          const preloaded: { [key: string]: KintoObject } = {};
          for (const record of records) {
            delete record["_cid"];
            preloaded[record.id] = record;
          }
          runCallback(preloaded);
        });
      },
      { mode: "readwrite" }
    );
    return result!;
  }

  /**
   * Retrieve a record by its primary key from the IndexedDB database.
   *
   * @override
   * @param  {String} id The record id.
   * @return {Promise}
   */
  async get(id: string): Promise<B | undefined> {
    try {
      let record: B;
      await this.prepare("records", (store) => {
        store.get([this.cid, id]).onsuccess = (e) =>
          (record = (e.target as IDBRequest<KintoObject>).result as B);
      });
      return record!;
    } catch (e) {
      this._handleError("get", e);
    }
  }

  /**
   * Lists all records from the IndexedDB database.
   *
   * @override
   * @param  {Object} params  The filters and order to apply to the results.
   * @return {Promise}
   */
  async list(
    params: { filters: { [key: string]: any }; order?: string } = {
      filters: {},
    }
  ): Promise<KintoObject[]> {
    const { filters } = params;
    try {
      let results: KintoObject[] = [];
      await this.prepare("records", (store) => {
        createListRequest(this.cid, store, filters, (_results) => {
          // we have received all requested records that match the filters,
          // we now park them within current scope and hide the `_cid` attribute.
          for (const result of _results) {
            delete result["_cid"];
          }
          results = _results;
        });
      });
      // The resulting list of records is sorted.
      // XXX: with some efforts, this could be fully implemented using IDB API.
      return params.order ? sortObjects(params.order, results) : results;
    } catch (e) {
      this._handleError("list", e);
    }

    return [];
  }

  /**
   * Store the lastModified value into metadata store.
   *
   * @override
   * @param  {Number}  lastModified
   * @return {Promise}
   */
  async saveLastModified(lastModified: number): Promise<number | null> {
    const value = lastModified || null;
    try {
      await this.prepare(
        "timestamps",
        (store) => {
          if (value === null) {
            store.delete(this.cid);
          } else {
            store.put({ cid: this.cid, value });
          }
        },
        { mode: "readwrite" }
      );
      return value;
    } catch (e) {
      this._handleError("saveLastModified", e);
    }

    return null;
  }

  /**
   * Retrieve saved lastModified value.
   *
   * @override
   * @return {Promise}
   */
  async getLastModified(): Promise<number | null> {
    try {
      let entry: { value: number } | null = null;
      await this.prepare("timestamps", (store) => {
        store.get(this.cid).onsuccess = (e: Event) => {
          entry = (e.target as IDBRequest<{ value: number }>).result;
        };
      });

      return entry ? entry!.value : null;
    } catch (e) {
      this._handleError("getLastModified", e);
    }

    return null;
  }

  async saveMetadata(
    metadata: Record<string, unknown> | null
  ): Promise<Record<string, unknown> | null | undefined> {
    try {
      await this.prepare(
        "collections",
        (store) => store.put({ cid: this.cid, metadata }),
        { mode: "readwrite" }
      );
      return metadata;
    } catch (e) {
      this._handleError("saveMetadata", e);
    }
  }

  async getMetadata() {
    try {
      let entry: { metadata: any } | null = null;
      await this.prepare("collections", (store: IDBObjectStore) => {
        store.get(this.cid).onsuccess = (e: Event) =>
          (entry = (e.target as IDBRequest<{ metadata: any }>).result);
      });
      return entry ? (entry as { metadata: any }).metadata : null;
    } catch (e) {
      this._handleError("getMetadata", e);
    }
  }
}

/**
 * IDB transaction proxy.
 *
 * @param  {IDB} adapter        The call IDB adapter
 * @param  {IDBStore} store     The IndexedDB database store.
 * @param  {Array}    preloaded The list of records to make available to
 *                              get() (default: []).
 * @return {Object}
 */
function transactionProxy<
  T extends { id: string; last_modified?: number; _status?: RecordStatus }
>(
  adapter: IDB<T>,
  store: IDBObjectStore,
  preloaded: { [key: string]: T } = {}
) {
  const _cid = adapter.cid;
  return {
    create(record: T) {
      store.add({ ...record, _cid });
    },

    update(record: T) {
      return store.put({ ...record, _cid });
    },

    delete(id: string) {
      store.delete([_cid, id]);
    },

    get(id: string) {
      return preloaded[id];
    },
  };
}
