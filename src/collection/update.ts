import { Collection } from "./collection";
import { execute } from "./execute";
import type { KintoRecord, UpdateRepresentation } from "../types";
import { hasOwnProperty } from "../utils";

export function update<B extends KintoRecord>(
  coll: Collection<B>,
  record: B & { id: string },
  options: { synced?: boolean; patch?: boolean } = {
    synced: false,
    patch: false,
  }
): Promise<UpdateRepresentation<B>> {
  // Validate the record and its ID, even though this validation is
  // also done in the CollectionTransaction method, because we need
  // to pass the ID to preloadIds.
  if (typeof record !== "object") {
    return Promise.reject(new Error("Record is not an object."));
  }
  if (!hasOwnProperty(record, "id")) {
    return Promise.reject(new Error("Cannot update a record missing id."));
  }
  if (!coll.idSchema.validate(record.id)) {
    return Promise.reject(new Error(`Invalid Id: ${record.id}`));
  }

  return execute(
    coll,
    (txn) =>
      txn.update(record, {
        synced: options.synced ?? false,
        patch: options.patch ?? false,
      }),
    {
      preloadIds: [record.id],
    }
  );
}
