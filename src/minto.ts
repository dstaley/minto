import { HTTPClient } from "./http";
import IDB, { AbstractBaseAdapter } from "./idb";
import type { RecordStatus } from "./types";

export interface MintoBaseOptions {
  remote?: string;
  bucket?: string;
  headers?: Record<string, string>;
  retry?: number;
  requestMode?: RequestMode;
  timeout?: number;
  api?: HTTPClient;
}

export interface Minto<
  C extends { id: string; last_modified?: number; _status?: RecordStatus } = any
> {
  adapter: (
    dbName: string,
    options?: { dbName?: string; migrateOldData?: boolean }
  ) => AbstractBaseAdapter<C>;
  api: HTTPClient | null;
}

function minto<
  B extends { id: string; last_modified?: number; _status?: RecordStatus } = any
>(options: MintoBaseOptions = {}): Minto<B> {
  return {
    adapter: (
      dbName: string,
      options?: { dbName?: string; migrateOldData?: boolean }
    ) => {
      return new IDB<B>(dbName, options);
    },
    api: options.api ?? null,
  };
}

export { minto };
