import type { KintoRecord, KintoRepresentation } from "../types";
import type { Collection } from "./collection";

export async function list<B extends KintoRecord>(
  coll: Collection<B>,
  params: {
    filters?: {
      [key: string]: any;
    };
    order?: string;
  } = {},
  options: { includeDeleted: boolean } = { includeDeleted: false }
): Promise<KintoRepresentation<B[]>> {
  const results = await coll.db.list({
    filters: params.filters ?? {},
    order: params.order ?? "-last_modified",
  });
  let data = results;
  if (!options.includeDeleted) {
    data = results.filter((record: any) => record._status !== "deleted");
  }
  return { data, permissions: {} };
}
