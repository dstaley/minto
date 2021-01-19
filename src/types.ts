export interface KintoIdObject {
  id: string;
  [key: string]: unknown;
}

export interface KintoObject extends KintoIdObject {
  last_modified: number;
}

export type RecordStatus = "created" | "updated" | "deleted" | "synced";

export type WithOptional<T, K extends keyof T> = Omit<T, K> &
  Partial<Pick<T, K>>;

export type Permission =
  | "bucket:create"
  | "read"
  | "write"
  | "collection:create"
  | "group:create"
  | "record:create";

export interface KintoRepresentation<T = unknown> {
  data: T;
  permissions: { [key in Permission]?: string[] };
}

export interface UpdateRepresentation<T = unknown>
  extends KintoRepresentation<T> {
  oldRecord: KintoIdObject & T;
}

export type KintoRecord = {
  id: string;
  last_modified?: number;
  _status?: RecordStatus;
};

export interface IdSchema {
  generate(record?: any): string;
  validate(id: string): boolean;
}

export interface CollectionSyncOptions {
  remote: string;
  strategy?: string;
  headers?: Record<string, string>;
  retry?: number;
  ignoreBackoff?: boolean;
  bucket?: string | null;
  collection?: string | null;
  expectedTimestamp?: string | null;
}

export interface Conflict<T> {
  type: "incoming" | "outgoing";
  local: T;
  remote: T;
}

export interface Update<T> {
  old: T;
  new: T;
}

export interface KintoError {
  type: "incoming";
  message: string;
  stack?: string;
}

export interface SyncResult<T = any> {
  errors: KintoError[];
  created: T[];
  updated: Update<T>[];
  deleted: T[];
  published: T[];
  conflicts: Conflict<T>[];
  skipped: T[];
  resolved: T[];
  void: unknown[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface HttpResponse<T> {
  status: number;
  json: T;
  headers: Headers;
}

export interface KintoRequest {
  method?: HttpMethod;
  path: string;
  headers: HeadersInit;
  body?: any;
}

export interface PaginatedParams {
  sort?: string;
  filters?: Record<string, string | number>;
  limit?: number;
  pages?: number;
  since?: string;
  fields?: string[];
}

export interface PaginationResult<T> {
  last_modified: string | null;
  data: T[];
  next: (nextPage?: string | null) => Promise<PaginationResult<T>>;
  hasNextPage: boolean;
  totalRecords: number;
}

export interface KintoResponse<T = unknown> {
  data: KintoObject & T;
  permissions: { [key in Permission]?: string[] };
}

export interface HistoryEntry<T> {
  action: "create" | "update" | "delete";
  collection_id: string;
  date: string;
  id: string;
  last_modified: number;
  record_id: string;
  resource_name: string;
  target: KintoResponse<T>;
  timestamp: number;
  uri: string;
  user_id: string;
}

export interface DataResponse<T> {
  data: T;
}

interface CreatedChange<T> {
  type: "created";
  data: T;
}

interface UpdatedChange<T> {
  type: "updated";
  data: Update<T>;
}

interface DeletedChange<T> {
  type: "deleted";
  data: T;
}

interface ResolvedChange {
  type: "resolved";
  data: never;
}

interface ErrorChange {
  type: "errors";
  data: never;
}

interface PublishedChange {
  type: "published";
  data: never;
}

export interface ConflictsChange<T> {
  type: "conflicts";
  data: Conflict<T>;
}

interface SkippedChange<T> {
  type: "skipped";
  data: T;
}

interface VoidChange {
  type: "void";
  data?: never;
}

export type Change<T> =
  | CreatedChange<T>
  | UpdatedChange<T>
  | DeletedChange<T>
  | ResolvedChange
  | ErrorChange
  | PublishedChange
  | ConflictsChange<T>
  | SkippedChange<T>
  | VoidChange;

export interface KintoError {
  type: "incoming";
  message: string;
  stack?: string;
}

export interface Conflict<T> {
  type: "incoming" | "outgoing";
  local: T;
  remote: T;
}

interface ConflictRecord {
  last_modified: number;
  id: string;
}

interface ConflictResponse {
  existing: ConflictRecord;
}

interface ResponseBody {
  data?: unknown;
  details?: ConflictResponse;
  code?: number;
  errno?: number;
  error?: string;
  message?: string;
  info?: string;
}

interface ErrorResponse {
  path: string;
  sent: KintoRequest;
  error: ResponseBody;
}

export interface AggregateResponse {
  errors: ErrorResponse[];
  published: ResponseBody[];
  conflicts: any[];
  skipped: any[];
}

export interface OperationResponse<T = KintoObject> {
  status: number;
  path: string;
  body: { data: T };
  headers: Record<string, string>;
}

export interface BatchResponse {
  responses: OperationResponse[];
}

export interface KintoBatchResponse {
  status: number;
  path: string;
  body: ResponseBody;
  headers: { [key: string]: string };
}

export interface ServerSettings {
  readonly: boolean;
  batch_max_requests: number;
}

export interface ServerCapability {
  description: string;
  url: string;
  version?: string;
  [key: string]: unknown;
}

export interface User {
  id: string;
  principals: string[];
  bucket: string;
}

export interface HelloResponse {
  project_name: string;
  project_version: string;
  http_api_version: string;
  project_docs: string;
  url: string;
  settings: ServerSettings;
  user?: User;
  capabilities: { [key: string]: ServerCapability };
}

export type MappableObject = { [key in string | number]: unknown };
