import { Collection } from "./collection";
import { StorageProxy } from "../idb";
import {
  recordsEqual,
  markStatus,
  markDeleted,
  hasOwnProperty,
} from "../utils";
import type {
  KintoRecord,
  KintoRepresentation,
  UpdateRepresentation,
} from "../types";

interface CollectionTransaction<B extends KintoRecord> {
  create(record: B): KintoRepresentation<B>;
  update(
    record: B & { id: string },
    options: { synced: boolean; patch: boolean }
  ): UpdateRepresentation<B>;
  delete(id: string, options: { virtual: boolean }): KintoRepresentation<B>;
}

function txnCreate<B extends KintoRecord>(
  coll: Collection<B>,
  adapterTransaction: StorageProxy<B>,
  record: B
): KintoRepresentation<B> {
  if (typeof record !== "object") {
    throw new Error("Record is not an object.");
  }
  if (!hasOwnProperty(record, "id")) {
    throw new Error("Cannot create a record missing id");
  }
  if (!coll.idSchema.validate(record.id)) {
    throw new Error(`Invalid Id: ${record.id}`);
  }

  adapterTransaction.create(record);
  return { data: record, permissions: {} };
}

function _txUupdateRaw<B extends KintoRecord>(
  coll: Collection<B>,
  oldRecord: any,
  newRecord: any,
  { synced = false }: { synced?: boolean } = {}
) {
  const updated = { ...newRecord };
  // Make sure to never loose the existing timestamp.
  if (oldRecord && oldRecord.last_modified && !updated.last_modified) {
    updated.last_modified = oldRecord.last_modified;
  }
  // If only local fields have changed, then keep record as synced.
  // If status is created, keep record as created.
  // If status is deleted, mark as updated.
  const isIdentical =
    oldRecord && recordsEqual(oldRecord, updated, coll.localFields);
  const keepSynced = isIdentical && oldRecord._status === "synced";
  const neverSynced =
    !oldRecord || (oldRecord && oldRecord._status === "created");
  const newStatus =
    keepSynced || synced ? "synced" : neverSynced ? "created" : "updated";
  return markStatus(updated, newStatus);
}

function txnUpdate<B extends KintoRecord>(
  coll: Collection<B>,
  adapterTransaction: StorageProxy<B>,
  record: B & { id: string },
  options: { synced: boolean; patch: boolean } = {
    synced: false,
    patch: false,
  }
): UpdateRepresentation<B> {
  if (typeof record !== "object") {
    throw new Error("Record is not an object.");
  }
  if (!hasOwnProperty(record, "id")) {
    throw new Error("Cannot update a record missing id.");
  }
  if (!coll.idSchema.validate(record.id)) {
    throw new Error(`Invalid Id: ${record.id}`);
  }

  const oldRecord = adapterTransaction.get(record.id);
  if (!oldRecord) {
    throw new Error(`Record with id=${record.id} not found.`);
  }
  const newRecord = options.patch ? { ...oldRecord, ...record } : record;
  const updated = _txUupdateRaw(coll, oldRecord, newRecord, options);
  adapterTransaction.update(updated);
  return { data: updated, oldRecord, permissions: {} };
}

function txnDelete<B extends KintoRecord>(
  coll: Collection<B>,
  adapterTransaction: StorageProxy<B>,
  id: string,
  options: { virtual: boolean } = { virtual: true }
): KintoRepresentation<B> {
  // Ensure the record actually exists.
  const existing = adapterTransaction.get(id);
  const alreadyDeleted = existing && existing._status === "deleted";
  if (!existing || (alreadyDeleted && options.virtual)) {
    throw new Error(`Record with id=${id} not found.`);
  }
  // Virtual updates status.
  if (options.virtual) {
    adapterTransaction.update(markDeleted(existing));
  } else {
    // Delete for real.
    adapterTransaction.delete(id);
  }
  return { data: existing, permissions: {} };
}

export function execute<R, B extends KintoRecord = any>(
  coll: Collection<B>,
  doOperations: (proxy: CollectionTransaction<B>) => R,
  { preloadIds = [] }: { preloadIds?: string[] } = {}
): Promise<R> {
  for (const id of preloadIds) {
    if (!coll.idSchema.validate(id)) {
      return Promise.reject(Error(`Invalid Id: ${id}`));
    }
  }

  return coll.db.execute(
    (transaction) => {
      const txn = {
        create: (record: B) => txnCreate(coll, transaction, record),
        update: (
          record: B & { id: string },
          options: { synced: boolean; patch: boolean } = {
            synced: false,
            patch: false,
          }
        ) => txnUpdate(coll, transaction, record, options),
        delete: (id: string, options: { virtual: boolean }) =>
          txnDelete(coll, transaction, id, options),
      };
      const result = doOperations(txn);
      return result;
    },
    { preload: preloadIds }
  );
}
