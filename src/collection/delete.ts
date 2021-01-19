import type { KintoRecord, KintoRepresentation } from "../types";
import type { Collection } from "./collection";
import { execute } from "./execute";

export function del<B extends KintoRecord>(
  coll: Collection<B>,
  id: string,
  options: { virtual: boolean } = { virtual: true }
): Promise<KintoRepresentation<B>> {
  return execute(
    coll,
    (transaction) => {
      return transaction.delete(id, options);
    },
    { preloadIds: [id] }
  );
}
