import { StorageProxy } from "../idb";
import type {
  RecordStatus,
  KintoRecord,
  CollectionSyncOptions,
  SyncResult,
  Change,
  ConflictsChange,
  KintoError,
  Conflict,
  AggregateResponse,
} from "../types";
import { deepEqual, recordsEqual, markStatus, markSynced } from "../utils";
import {
  collectionHTTPClient,
  getData,
  CollectionHTTPClient,
  listRecords,
  batch,
  createRecord,
  updateRecord,
  deleteRecord,
  httpClient,
} from "../http";
import type { Collection } from "./collection";
import { list } from "./list";

const IMPORT_CHUNK_SIZE = 200;

const SYNC_STRATEGY = {
  CLIENT_WINS: "client_wins",
  SERVER_WINS: "server_wins",
  PULL_ONLY: "pull_only",
  MANUAL: "manual",
};

export class ServerWasFlushedError extends Error {
  public clientTimestamp: number;
  public serverTimestamp?: number;
  public message!: string;

  constructor(
    clientTimestamp: number,
    serverTimestamp: number | undefined,
    message: string
  ) {
    super(message);

    this.clientTimestamp = clientTimestamp;
    this.serverTimestamp = serverTimestamp;
  }
}

/**
 * Synchronization result object.
 */
export class SyncResultObject {
  /**
   * Public constructor.
   */
  public lastModified?: number | null;
  private _lists: SyncResult;
  private _cached: Partial<SyncResult>;
  constructor() {
    /**
     * Current synchronization result status; becomes `false` when conflicts or
     * errors are registered.
     * @type {Boolean}
     */
    this.lastModified = null;
    this._lists = {
      errors: [],
      created: [],
      updated: [],
      deleted: [],
      published: [],
      conflicts: [],
      skipped: [],
      resolved: [],
      void: [],
    };
    this._cached = {};
  }

  /**
   * Adds entries for a given result type.
   *
   * @param {String} type    The result type.
   * @param {Array}  entries The result entries.
   * @return {SyncResultObject}
   */
  add<K extends keyof SyncResult>(
    type: K,
    entries: SyncResult[K] | SyncResult[K][0]
  ): SyncResultObject {
    if (!Array.isArray(this._lists[type])) {
      console.warn(`Unknown type "${type}"`);
      return this;
    }
    if (!Array.isArray(entries)) {
      entries = [entries];
    }
    this._lists[type] = [...this._lists[type], ...(entries as SyncResult[K])];
    delete this._cached[type];
    return this;
  }

  get ok(): boolean {
    return this.errors.length + this.conflicts.length === 0;
  }

  get errors(): KintoError[] {
    return this._lists["errors"];
  }

  get conflicts(): Conflict<any>[] {
    return this._lists["conflicts"];
  }

  get skipped(): any[] {
    return this._deduplicate("skipped");
  }

  get resolved(): any[] {
    return this._deduplicate("resolved");
  }

  get created(): any[] {
    return this._deduplicate("created");
  }

  get updated(): any[] {
    return this._deduplicate("updated");
  }

  get deleted(): any[] {
    return this._deduplicate("deleted");
  }

  get published(): any[] {
    return this._deduplicate("published");
  }

  private _deduplicate<K extends keyof SyncResult>(list: K): SyncResult[K] {
    if (!(list in this._cached)) {
      // Deduplicate entries by id. If the values don't have `id` attribute, just
      // keep all.
      const recordsWithoutId = new Set();
      const recordsById = new Map();
      this._lists[list].forEach((record) => {
        if (!record.id) {
          recordsWithoutId.add(record);
        } else {
          recordsById.set(record.id, record);
        }
      });
      this._cached[list] = Array.from(recordsById.values()).concat(
        Array.from(recordsWithoutId)
      );
    }
    return (this._cached as NonNullable<SyncResult>)[list];
  }

  /**
   * Reinitializes result entries for a given result type.
   *
   * @param  {String} type The result type.
   * @return {SyncResultObject}
   */
  reset(type: keyof SyncResult): SyncResultObject {
    this._lists[type] = [];
    delete this._cached[type];
    return this;
  }

  private toObject() {
    // Only used in tests.
    return {
      ok: this.ok,
      lastModified: this.lastModified,
      errors: this.errors,
      created: this.created,
      updated: this.updated,
      deleted: this.deleted,
      skipped: this.skipped,
      published: this.published,
      conflicts: this.conflicts,
      resolved: this.resolved,
    };
  }
}

async function pullMetadata<B extends KintoRecord>(
  coll: Collection<B>,
  client: CollectionHTTPClient,
  options: {
    expectedTimestamp?: string | null;
    headers?: Record<string, string>;
  } = {}
): Promise<Record<string, unknown> | null | undefined> {
  const { expectedTimestamp, headers } = options;
  const query = expectedTimestamp
    ? { query: { _expected: expectedTimestamp.toString() } }
    : undefined;
  const metadata = await getData(client, {
    ...query,
    headers,
  });
  return coll.db.saveMetadata(metadata as any);
}

function decodeRecord<B extends KintoRecord>(
  type: "remote" | "local",
  record: any
): Promise<B> {
  return Promise.resolve(record);
}

function importChange<
  T extends { id: string; last_modified?: number; _status?: RecordStatus }
>(
  transaction: StorageProxy<T>,
  remote: T & { deleted?: boolean },
  localFields: string[],
  strategy: string
): Change<T> {
  const local = transaction.get(remote.id);
  if (!local) {
    // Not found locally but remote change is marked as deleted; skip to
    // avoid recreation.
    if (remote.deleted) {
      return { type: "skipped", data: remote };
    }
    const synced = markSynced(remote);
    transaction.create(synced);
    return { type: "created", data: synced };
  }
  // Apply remote changes on local record.
  const synced = { ...local, ...markSynced(remote) };

  // With pull only, we don't need to compare records since we override them.
  if (strategy === SYNC_STRATEGY.PULL_ONLY) {
    if (remote.deleted) {
      transaction.delete(remote.id);
      return { type: "deleted", data: local };
    }
    transaction.update(synced);
    return { type: "updated", data: { old: local, new: synced } };
  }

  // With other sync strategies, we detect conflicts,
  // by comparing local and remote, ignoring local fields.
  const isIdentical = recordsEqual(local, remote, localFields);
  // Detect or ignore conflicts if record has also been modified locally.
  if (local._status !== "synced") {
    // Locally deleted, unsynced: scheduled for remote deletion.
    if (local._status === "deleted") {
      return { type: "skipped", data: local };
    }
    if (isIdentical) {
      // If records are identical, import anyway, so we bump the
      // local last_modified value from the server and set record
      // status to "synced".
      transaction.update(synced);
      return { type: "updated", data: { old: local, new: synced } };
    }
    if (
      local.last_modified !== undefined &&
      local.last_modified === remote.last_modified
    ) {
      // If our local version has the same last_modified as the remote
      // one, this represents an object that corresponds to a resolved
      // conflict. Our local version represents the final output, so
      // we keep that one. (No transaction operation to do.)
      // But if our last_modified is undefined,
      // that means we've created the same object locally as one on
      // the server, which *must* be a conflict.
      return { type: "void" };
    }
    return {
      type: "conflicts",
      data: { type: "incoming", local: local, remote: remote },
    };
  }
  // Local record was synced.
  if (remote.deleted) {
    transaction.delete(remote.id);
    return { type: "deleted", data: local };
  }
  // Import locally.
  transaction.update(synced);
  // if identical, simply exclude it from all SyncResultObject lists
  if (isIdentical) {
    return { type: "void" };
  }
  return { type: "updated", data: { old: local, new: synced } };
}

function resolveRaw<B extends KintoRecord>(
  conflict: Conflict<B>,
  resolution: B
): B {
  const resolved: B = {
    ...resolution,
    // Ensure local record has the latest authoritative timestamp
    last_modified: conflict.remote && conflict.remote.last_modified,
  };
  // If the resolution object is strictly equal to the
  // remote record, then we can mark it as synced locally.
  // Otherwise, mark it as updated (so that the resolution is pushed).
  const synced = deepEqual(resolved, conflict.remote);
  return markStatus(resolved, synced ? "synced" : "updated");
}

function handleConflicts<B extends KintoRecord>(
  transaction: StorageProxy<B>,
  conflicts: any[],
  strategy: string
) {
  if (strategy === SYNC_STRATEGY.MANUAL) {
    return [];
  }
  return conflicts.map((conflict) => {
    const resolution =
      strategy === SYNC_STRATEGY.CLIENT_WINS ? conflict.local : conflict.remote;
    const rejected =
      strategy === SYNC_STRATEGY.CLIENT_WINS ? conflict.remote : conflict.local;
    let accepted, status, id;
    if (resolution === null) {
      // We "resolved" with the server-side deletion. Delete locally.
      // This only happens during SERVER_WINS because the local
      // version of a record can never be null.
      // We can get "null" from the remote side if we got a conflict
      // and there is no remote version available; see kinto-http.js
      // batch.js:aggregate.
      transaction.delete(conflict.local.id);
      accepted = null;
      // The record was deleted, but that status is "synced" with
      // the server, so we don't need to push the change.
      status = "synced";
      id = conflict.local.id;
    } else {
      const updated = resolveRaw(conflict, resolution);
      transaction.update(updated);
      accepted = updated;
      status = updated._status;
      id = updated.id;
    }
    return { rejected, accepted, id, _status: status };
  });
}

async function importChanges<B extends KintoRecord>(
  coll: Collection<B>,
  syncResultObject: SyncResultObject,
  decodedChanges: any[],
  strategy: string = SYNC_STRATEGY.MANUAL
): Promise<SyncResultObject> {
  // Retrieve records matching change ids.
  try {
    for (let i = 0; i < decodedChanges.length; i += IMPORT_CHUNK_SIZE) {
      const slice = decodedChanges.slice(i, i + IMPORT_CHUNK_SIZE);

      const { imports, resolved } = await coll.db.execute(
        (transaction) => {
          const imports = slice.map((remote) => {
            // Store remote change into local database.
            return importChange(
              transaction,
              remote,
              coll.localFields,
              strategy
            );
          });
          const conflicts = (imports.filter(
            (i) => i.type === "conflicts"
          ) as ConflictsChange<B>[]).map((i) => i.data);
          const resolved = handleConflicts(transaction, conflicts, strategy);
          return { imports, resolved };
        },
        { preload: slice.map((record) => record.id) }
      );

      // Lists of created/updated/deleted records
      imports.forEach(({ type, data }) => syncResultObject.add(type, data));
      // Automatically resolved conflicts (if not manual)
      if (resolved.length > 0) {
        syncResultObject.reset("conflicts").add("resolved", resolved);
      }
    }
  } catch (err) {
    const data: KintoError = {
      type: "incoming",
      message: err.message,
      stack: err.stack,
    };
    // XXX one error of the whole transaction instead of per atomic op
    syncResultObject.add("errors", data);
  }

  return syncResultObject;
}

async function _applyPushedResults<B extends KintoRecord>(
  coll: Collection<B>,
  syncResultObject: SyncResultObject,
  toApplyLocally: any[],
  conflicts: any[],
  strategy: string = SYNC_STRATEGY.MANUAL
) {
  const toDeleteLocally = toApplyLocally.filter((r) => r.deleted);
  const toUpdateLocally = toApplyLocally.filter((r) => !r.deleted);

  const { published, resolved } = await coll.db.execute(
    (transaction) => {
      const updated = toUpdateLocally.map((record) => {
        const synced = markSynced(record);
        transaction.update(synced);
        return synced;
      });
      const deleted = toDeleteLocally.map((record) => {
        transaction.delete(record.id);
        // Amend result data with the deleted attribute set
        return { id: record.id, deleted: true };
      });
      const published = updated.concat(deleted);
      // Handle conflicts, if any
      const resolved = handleConflicts(transaction, conflicts, strategy);
      return { published, resolved };
    },
    { preload: [] }
  );

  syncResultObject.add("published", published);

  if (resolved.length > 0) {
    syncResultObject
      .reset("conflicts")
      .reset("resolved")
      .add("resolved", resolved);
  }
  return syncResultObject;
}

async function pullChanges<B extends KintoRecord>(
  coll: Collection<B>,
  client: CollectionHTTPClient,
  syncResultObject: SyncResultObject,
  options: {
    exclude?: any[];
    strategy?: string;
    lastModified?: number | null;
    headers?: Record<string, string>;
    expectedTimestamp?: string | null;
    retry?: number;
  } = {}
): Promise<SyncResultObject> {
  if (!syncResultObject.ok) {
    return syncResultObject;
  }

  const since = coll.lastModified
    ? coll.lastModified
    : await coll.db.getLastModified();

  options = {
    strategy: SYNC_STRATEGY.MANUAL,
    lastModified: since,
    headers: {},
    ...options,
  };

  // Optionally ignore some records when pulling for changes.
  // (avoid redownloading our own changes on last step of #sync())
  let filters;
  if (options.exclude) {
    // Limit the list of excluded records to the first 50 records in order
    // to remain under de-facto URL size limit (~2000 chars).
    // http://stackoverflow.com/questions/417142/what-is-the-maximum-length-of-a-url-in-different-browsers/417184#417184
    const exclude_id = options.exclude
      .slice(0, 50)
      .map((r) => r.id)
      .join(",");
    filters = { exclude_id };
  }
  if (options.expectedTimestamp) {
    filters = {
      ...filters,
      _expected: options.expectedTimestamp,
    };
  }
  // First fetch remote changes from the server
  const { data, last_modified } = await listRecords(client, {
    // Since should be ETag (see https://github.com/Kinto/kinto.js/issues/356)
    since: options.lastModified ? `${options.lastModified}` : undefined,
    headers: options.headers,
    retry: options.retry,
    // Fetch every page by default (FIXME: option to limit pages, see #277)
    pages: Infinity,
    filters,
  });
  // last_modified is the ETag header value (string).
  // For retro-compatibility with first kinto.js versions
  // parse it to integer.
  const unquoted = last_modified ? parseInt(last_modified, 10) : undefined;

  // Check if server was flushed.
  // This is relevant for the Kinto demo server
  // (and thus for many new comers).
  const localSynced = options.lastModified;
  const serverChanged = unquoted && unquoted > options.lastModified!;
  const emptyCollection = data.length === 0;
  if (!options.exclude && localSynced && serverChanged && emptyCollection) {
    const e = new ServerWasFlushedError(
      localSynced,
      unquoted,
      "Server has been flushed. Client Side Timestamp: " +
        localSynced +
        " Server Side Timestamp: " +
        unquoted
    );
    throw e;
  }

  // Atomic updates are not sensible here because unquoted is not
  // computed as a function of syncResultObject.lastModified.
  // eslint-disable-next-line require-atomic-updates
  syncResultObject.lastModified = unquoted;

  // Decode incoming changes.
  const decodedChanges = await Promise.all(
    data.map((change) => {
      return decodeRecord("remote", change);
    })
  );
  // Hook receives decoded records.
  const payload = { lastModified: unquoted, changes: decodedChanges };
  const afterHooks = payload; // await this.applyHook("incoming-changes", payload);

  // No change, nothing to import.
  if (afterHooks.changes.length > 0) {
    // Reflect these changes locally
    await importChanges(
      coll,
      syncResultObject,
      afterHooks.changes,
      options.strategy
    );
  }
  return syncResultObject;
}

async function pushChanges<B extends KintoRecord>(
  coll: Collection<B>,
  client: CollectionHTTPClient,
  changes: any,
  syncResultObject: SyncResultObject,
  options: {
    strategy?: string;
    headers?: Record<string, string>;
    retry?: number;
  } = {}
): Promise<SyncResultObject> {
  if (!syncResultObject.ok) {
    return syncResultObject;
  }
  // FIXME: replacing `undefined` with Collection.strategy.CLIENT_WINS breaks tests
  const safe = !options.strategy || options.strategy !== undefined;
  const toDelete = changes.filter((r: any) => r._status === "deleted");
  const toSync = changes.filter((r: any) => r._status != "deleted");

  // Perform a batch request with every changes.
  const synced = (await batch(
    client,
    (batch) => {
      toDelete.forEach((r: any) => {
        // never published locally deleted records should not be pusblished
        if (r.last_modified) {
          deleteRecord(batch, r);
        }
      });
      toSync.forEach((r: any) => {
        // Clean local fields (like _status) before sending to server.
        const published = r as B;
        if (r._status === "created") {
          createRecord(batch, published);
        } else {
          updateRecord(batch, published);
        }
      });
    },
    {
      headers: options.headers,
      retry: options.retry,
      safe,
      aggregate: true,
    }
  )) as AggregateResponse;

  // Store outgoing errors into sync result object
  syncResultObject.add(
    "errors",
    synced.errors.map((e: any) => ({ ...e, type: "outgoing" }))
  );

  // Store outgoing conflicts into sync result object
  const conflicts = [];
  for (const { type, local, remote } of synced.conflicts) {
    // Note: we ensure that local data are actually available, as they may
    // be missing in the case of a published deletion.
    const safeLocal = (local && local.data) || { id: remote.id };
    const realLocal = safeLocal;
    // We can get "null" from the remote side if we got a conflict
    // and there is no remote version available; see kinto-http.js
    // batch.js:aggregate.
    const realRemote = remote && remote;
    const conflict = { type, local: realLocal, remote: realRemote };
    conflicts.push(conflict);
  }
  syncResultObject.add("conflicts", conflicts);

  // Records that must be deleted are either deletions that were pushed
  // to server (published) or deleted records that were never pushed (skipped).
  const missingRemotely = synced.skipped.map((r: any) => ({
    ...r,
    deleted: true,
  }));

  // For created and updated records, the last_modified coming from server
  // will be stored locally.
  // Reflect publication results locally using the response from
  // the batch request.
  const published = synced.published.map((c) => c.data);
  const toApplyLocally = published.concat(missingRemotely);

  // Apply the decode transformers, if any
  const decoded = await Promise.all(
    toApplyLocally.map((record: any) => {
      return Promise.resolve(record);
    })
  );

  // We have to update the local records with the responses of the server
  // (eg. last_modified values etc.).
  if (decoded.length > 0 || conflicts.length > 0) {
    await _applyPushedResults(
      coll,
      syncResultObject,
      decoded,
      conflicts,
      options.strategy
    );
  }

  return syncResultObject;
}

async function gatherLocalChanges<B extends KintoRecord>(coll: Collection<B>) {
  const unsynced = await list(coll, {
    filters: { _status: ["created", "updated"] },
    order: "",
  });
  const deleted = await list(
    coll,
    { filters: { _status: "deleted" }, order: "" },
    { includeDeleted: true }
  );

  return [...unsynced.data, ...deleted.data];
}

export async function sync<B extends KintoRecord>(
  coll: Collection<B>,
  options: CollectionSyncOptions
): Promise<SyncResultObject> {
  const _options: CollectionSyncOptions = {
    remote: options.remote,
    strategy: options.strategy ?? SYNC_STRATEGY.MANUAL,
    headers: options.headers ?? {},
    retry: options.retry ?? 1,
    ignoreBackoff: options.ignoreBackoff ?? false,
    bucket: options.bucket ?? coll.bucket,
    collection: options.collection ?? coll.name,
    expectedTimestamp: options.expectedTimestamp ?? null,
  };

  if (_options.remote == "") {
    throw new Error("Provided remote must not be an empty string.");
  }

  const http = httpClient(_options.remote, {
    headers: _options.headers,
    retry: _options.retry,
  });
  const client = collectionHTTPClient(http, coll.bucket, coll.name);

  const result = new SyncResultObject();
  try {
    // Fetch collection metadata.
    await pullMetadata(coll, client, _options);

    // Fetch last changes from the server.
    await pullChanges(coll, client, result, _options);
    const { lastModified } = result;

    if (_options.strategy !== SYNC_STRATEGY.PULL_ONLY) {
      // Fetch local changes
      const toSync = await gatherLocalChanges(coll);

      // Publish local changes and pull local resolutions
      await pushChanges(coll, client, toSync, result, _options);

      // Publish local resolution of push conflicts to server (on CLIENT_WINS)
      const resolvedUnsynced = result.resolved.filter(
        (r) => r._status !== "synced"
      );
      if (resolvedUnsynced.length > 0) {
        const resolvedEncoded = await Promise.all(
          resolvedUnsynced.map((resolution) => {
            let record = resolution.accepted;
            if (record === null) {
              record = { id: resolution.id, _status: resolution._status };
            }
            return Promise.resolve(record);
          })
        );
        await pushChanges(coll, client, resolvedEncoded, result, _options);
      }
      // Perform a last pull to catch changes that occured after the last pull,
      // while local changes were pushed. Do not do it nothing was pushed.
      if (result.published.length > 0) {
        // Avoid redownloading our own changes during the last pull.
        const pullOpts = {
          ..._options,
          lastModified,
          exclude: result.published,
        };
        await pullChanges(coll, client, result, pullOpts);
      }
    }

    // Don't persist lastModified value if any conflict or error occured
    if (result.ok) {
      // No conflict occured, persist collection's lastModified value
      coll.lastModified = await coll.db.saveLastModified(result.lastModified);
    }
  } catch (e) {
    throw e;
  }

  return result;
}
