import { Collection } from "./collection";
import { execute } from "./execute";
import type { KintoRecord, WithOptional, KintoRepresentation } from "../types";
import { hasOwnProperty } from "../utils";

export function create<B extends KintoRecord = any>(
  coll: Collection<B>,
  record: WithOptional<B, "id">,
  options: { useRecordId?: boolean; synced?: boolean } = {
    useRecordId: false,
    synced: false,
  }
): Promise<KintoRepresentation<B>> {
  // Validate the record and its ID (if any), even though this
  // validation is also done in the CollectionTransaction method,
  // because we need to pass the ID to preloadIds.
  const reject = (msg: string) => Promise.reject(new Error(msg));
  if (typeof record !== "object") {
    return reject("Record is not an object.");
  }
  if (
    (options.synced || options.useRecordId) &&
    !hasOwnProperty(record, "id")
  ) {
    return reject(
      "Missing required Id; synced and useRecordId options require one"
    );
  }
  if (!options.synced && !options.useRecordId && hasOwnProperty(record, "id")) {
    return reject("Extraneous Id; can't create a record having one set.");
  }
  const newRecord = {
    ...record,
    id:
      options.synced || options.useRecordId
        ? record.id!
        : coll.idSchema.generate(record),
    _status: options.synced ? "synced" : "created",
  } as B;
  if (!coll.idSchema.validate(newRecord.id!)) {
    return reject(`Invalid Id: ${newRecord.id}`);
  }
  return execute(coll, (txn) => txn.create(newRecord), {
    preloadIds: [newRecord.id],
  }).catch((err) => {
    if (options.useRecordId) {
      throw new Error(
        "Couldn't create record. It may have been virtually deleted."
      );
    }
    throw err;
  });
}
