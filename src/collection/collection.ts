import { v4 } from "uuid";

import { AbstractBaseAdapter } from "../idb";
import { Minto } from "../minto";
import type { KintoRecord, IdSchema } from "../types";
import { RE_RECORD_ID } from "../utils";

function createUUIDSchema(): IdSchema {
  return {
    generate() {
      return v4();
    },

    validate(id: string): boolean {
      return typeof id === "string" && RE_RECORD_ID.test(id);
    },
  };
}

export interface Collection<B extends KintoRecord = any> {
  bucket: string;
  name: string;
  db: AbstractBaseAdapter<B>;
  idSchema: IdSchema;
  localFields: string[];
  lastModified: number | null;
}

export function collection<B extends KintoRecord = any>(
  minto: Minto<B>,
  bucket: string,
  name: string
): Collection<B> {
  const db = minto.adapter(`${bucket}/${name}`);
  const idSchema = createUUIDSchema();
  const localFields: string[] = [];

  return {
    bucket,
    name,
    db,
    idSchema,
    localFields,
    lastModified: null,
  };
}
