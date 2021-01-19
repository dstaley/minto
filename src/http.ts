import type {
  KintoRequest,
  HttpResponse,
  KintoObject,
  PaginatedParams,
  PaginationResult,
  HistoryEntry,
  HttpMethod,
  DataResponse,
  OperationResponse,
  BatchResponse,
  KintoBatchResponse,
  AggregateResponse,
  ServerSettings,
  HelloResponse,
  Permission,
  KintoResponse,
  MappableObject,
  KintoIdObject,
} from "./types";
import {
  addEndpointOptions,
  cleanUndefinedProperties,
  obscureAuthorizationHeader,
  delay,
  qsify,
  partition,
  isObject,
  toDataBody,
} from "./utils";
import * as requests from "./requests";

/**
 * Endpoints templates.
 * @type {Object}
 */
const ENDPOINTS = {
  root: () => "/",
  batch: () => "/batch",
  permissions: () => "/permissions",
  bucket: (bucket?: string) => "/buckets" + (bucket ? `/${bucket}` : ""),
  history: (bucket: string) => `${ENDPOINTS.bucket(bucket)}/history`,
  collection: (bucket: string, coll?: string) =>
    `${ENDPOINTS.bucket(bucket)}/collections` + (coll ? `/${coll}` : ""),
  group: (bucket: string, group?: string) =>
    `${ENDPOINTS.bucket(bucket)}/groups` + (group ? `/${group}` : ""),
  record: (bucket: string, coll: string, id?: string) =>
    `${ENDPOINTS.collection(bucket, coll)}/records` + (id ? `/${id}` : ""),
  attachment: (bucket: string, coll: string, id: string) =>
    `${ENDPOINTS.record(bucket, coll, id)}/attachment`,
};

const DEFAULT_REQUEST_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

const DEFAULT_REQUEST_MODE = "cors";
const DEFAULT_TIMEOUT = 0;

/**
 * Kinto server error code descriptors.
 */
const ERROR_CODES = {
  104: "Missing Authorization Token",
  105: "Invalid Authorization Token",
  106: "Request body was not valid JSON",
  107: "Invalid request parameter",
  108: "Missing request parameter",
  109: "Invalid posted data",
  110: "Invalid Token / id",
  111: "Missing Token / id",
  112: "Content-Length header was not provided",
  113: "Request body too large",
  114: "Resource was created, updated or deleted meanwhile",
  115: "Method not allowed on this end point (hint: server may be readonly)",
  116: "Requested version not available on this server",
  117: "Client has sent too many requests",
  121: "Resource access is forbidden for this user",
  122: "Another resource violates constraint",
  201: "Service Temporary unavailable due to high load",
  202: "Service deprecated",
  999: "Internal Server Error",
};

class NetworkTimeoutError extends Error {
  public url: string;
  public options: unknown;

  constructor(url: string, options: unknown) {
    super(
      `Timeout while trying to access ${url} with ${JSON.stringify(options)}`
    );

    this.url = url;
    this.options = options;
  }
}

class UnparseableResponseError extends Error {
  public status: number;
  public response: Response;
  public stack?: string;
  public error: Error;

  constructor(response: Response, body: string, error: Error) {
    const { status } = response;

    super(
      `Response from server unparseable (HTTP ${
        status || 0
      }; ${error}): ${body}`
    );

    this.status = status;
    this.response = response;
    this.stack = error.stack;
    this.error = error;
  }
}

export interface ServerResponseObject {
  code: number;
  errno: keyof typeof ERROR_CODES;
  error: string;
  message: string;
  info: string;
  details: unknown;
}

/**
 * "Error" subclass representing a >=400 response from the server.
 *
 * Whether or not this is an error depends on your application.
 *
 * The `json` field can be undefined if the server responded with an
 * empty response body. This shouldn't generally happen. Most "bad"
 * responses come with a JSON error description, or (if they're
 * fronted by a CDN or nginx or something) occasionally non-JSON
 * responses (which become UnparseableResponseErrors, above).
 */
class ServerResponse extends Error {
  public response: Response;
  public data?: ServerResponseObject;

  constructor(response: Response, json?: ServerResponseObject) {
    const { status } = response;
    let { statusText } = response;
    let errnoMsg;

    if (json) {
      // Try to fill in information from the JSON error.
      statusText = json.error || statusText;

      // Take errnoMsg from either ERROR_CODES or json.message.
      if (json.errno && json.errno in ERROR_CODES) {
        errnoMsg = ERROR_CODES[json.errno];
      } else if (json.message) {
        errnoMsg = json.message;
      }

      // If we had both ERROR_CODES and json.message, and they differ,
      // combine them.
      if (errnoMsg && json.message && json.message !== errnoMsg) {
        errnoMsg += ` (${json.message})`;
      }
    }

    let message = `HTTP ${status} ${statusText}`;
    if (errnoMsg) {
      message += `: ${errnoMsg}`;
    }

    super(message.trim());

    this.response = response;
    this.data = json;
  }
}

function getHeaders(
  baseObject: { headers?: Record<string, string> },
  options: { headers?: Record<string, string> }
): Record<string, string> {
  return { ...baseObject.headers, ...options.headers };
}

function getRetry(
  baseObject: { retry: number },
  options: { retry?: number }
): number {
  return { ...baseObject, ...options }.retry;
}

function getSafe(
  baseObject: { safe: boolean },
  options: { safe?: boolean }
): boolean {
  return { ...baseObject, ...options }.safe;
}

export interface HTTPClientOptions {
  safe?: boolean;
  headers?: Record<string, string>;
  retry?: number;
  bucket?: string;
  requestMode?: RequestMode;
  timeout?: number;
  batch?: boolean;
}

export interface HTTPClient {
  remote: string;
  endpoints: typeof ENDPOINTS;
  _isBatch: boolean;
  _requests: KintoRequest[];
  http: HttpRequest;
  retry: number;
  safe: boolean;
  headers: Record<string, string>;
  serverInfo: HelloResponse | null;
}

export function httpClient(
  remote: string,
  options: HTTPClientOptions = {}
): HTTPClient {
  return {
    remote,
    endpoints: ENDPOINTS,
    _isBatch: !!options.batch,
    _requests: [],
    http: {
      requestMode: options.requestMode || DEFAULT_REQUEST_MODE,
      timeout: options.timeout || DEFAULT_TIMEOUT,
    },
    retry: options.retry || 0,
    safe: !!options.safe,
    headers: options.headers || {},
    serverInfo: null,
  };
}

function _checkForDeprecationHeader(headers: Headers): void {
  const alertHeader = headers.get("Alert");
  if (!alertHeader) {
    return;
  }
  let alert;
  try {
    alert = JSON.parse(alertHeader);
  } catch (err) {
    console.warn("Unable to parse Alert header message", alertHeader);
    return;
  }
  console.warn(alert.message, alert.url);
}

function _checkForRetryAfterHeader(headers: Headers): number | undefined {
  const retryAfter = headers.get("Retry-After");
  if (!retryAfter) {
    return;
  }
  const delay = parseInt(retryAfter, 10) * 1000;
  const tryAgainAfter = new Date().getTime() + delay;
  return delay;
}

interface HttpRequest {
  requestMode: RequestMode;
  timeout: number;
}

function timedFetch(
  req: HttpRequest,
  url: string,
  options: RequestInit
): Promise<Response> {
  let hasTimedout = false;
  return new Promise((resolve, reject) => {
    // Detect if a request has timed out.
    let _timeoutId: ReturnType<typeof setTimeout>;
    if (req.timeout) {
      _timeoutId = setTimeout(() => {
        hasTimedout = true;
        if (options && options.headers) {
          options = {
            ...options,
            headers: obscureAuthorizationHeader(options.headers),
          };
        }
        reject(new NetworkTimeoutError(url, options));
      }, req.timeout);
    }
    function proceedWithHandler(fn: (arg: any) => void): (arg: any) => void {
      return (arg: any) => {
        if (!hasTimedout) {
          if (_timeoutId) {
            clearTimeout(_timeoutId);
          }
          fn(arg);
        }
      };
    }
    console.log("Calling fetch with options", { url, options });
    fetch(url, options)
      .then(proceedWithHandler(resolve))
      .catch(proceedWithHandler(reject));
  });
}

async function retry<T>(
  req: HttpRequest,
  url: string,
  retryAfter: number,
  _request: RequestInit,
  options: RequestOptions
): Promise<HttpResponse<T>> {
  await delay(retryAfter);
  return request<T>(req, url, _request, {
    ...options,
    retry: options.retry - 1,
  });
}

async function processResponse<T>(
  response: Response
): Promise<HttpResponse<T>> {
  const { status, headers } = response;
  const text = await response.text();
  // Check if we have a body; if so parse it as JSON.
  let json: unknown;
  if (text.length !== 0) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new UnparseableResponseError(response, text, err);
    }
  }
  if (status >= 400) {
    throw new ServerResponse(response, json as ServerResponseObject);
  }
  return { status, json: json as T, headers };
}

interface RequestOptions {
  retry: number;
}

async function request<T>(
  req: HttpRequest,
  url: string,
  request: RequestInit = { headers: {} },
  options: RequestOptions = { retry: 0 }
): Promise<HttpResponse<T>> {
  // Ensure default request headers are always set
  request.headers = { ...DEFAULT_REQUEST_HEADERS, ...request.headers };
  // If a multipart body is provided, remove any custom Content-Type header as
  // the fetch() implementation will add the correct one for us.
  if (request.body && request.body instanceof FormData) {
    if (request.headers instanceof Headers) {
      request.headers.delete("Content-Type");
    } else if (!Array.isArray(request.headers)) {
      delete request.headers["Content-Type"];
    }
  }
  request.mode = req.requestMode;

  const response = await timedFetch(req, url, request);
  const { headers } = response;

  _checkForDeprecationHeader(headers);

  // Check if the server summons the client to retry after a while.
  const retryAfter = _checkForRetryAfterHeader(headers);
  // If number of allowed of retries is not exhausted, retry the same request.
  if (retryAfter && options.retry > 0) {
    return retry<T>(req, url, retryAfter, request, options);
  } else {
    return processResponse<T>(response);
  }
}

async function execute<T>(
  client: HTTPClient,
  _request: KintoRequest,
  options: {
    raw?: boolean;
    stringify?: boolean;
    retry?: number;
    query?: { [key: string]: string };
    fields?: string[];
  } = {}
): Promise<T | HttpResponse<T>> {
  const { raw = false, stringify = true } = options;
  // If we're within a batch, add the request to the stack to send at once.
  if (client._isBatch) {
    client._requests.push(_request);
    // Resolve with a message in case people attempt at consuming the result
    // from within a batch operation.
    const msg = (("This result is generated from within a batch " +
      "operation and should not be consumed.") as unknown) as T;
    return raw
      ? ({ status: 0, json: msg, headers: new Headers() } as HttpResponse<T>)
      : msg;
  }
  const uri = client.remote + addEndpointOptions(_request.path, options);
  const result = await request<T>(
    client.http,
    uri,
    cleanUndefinedProperties({
      // Limit requests to only those parts that would be allowed in
      // a batch request -- don't pass through other fancy fetch()
      // options like integrity, redirect, mode because they will
      // break on a batch request.  A batch request only allows
      // headers, method, path (above), and body.
      method: _request.method,
      headers: _request.headers,
      body: stringify ? JSON.stringify(_request.body) : _request.body,
    }),
    { retry: getRetry(client, options) }
  );
  return raw ? result : result.json;
}

export interface BucketOptions {
  safe?: boolean;
  headers?: Record<string, string>;
  retry?: number;
}

interface BucketHTTPClient {
  client: HTTPClient;
  name: string;
  headers: Record<string, string>;
}

export function bucketHTTPClient(
  client: HTTPClient,
  name: string,
  options: BucketOptions = {}
): BucketHTTPClient {
  return {
    client,
    name,
    headers: options.headers ?? {},
  };
}

export interface CollectionOptions {
  headers?: Record<string, string>;
  safe?: boolean;
  retry?: number;
}

export interface CollectionHTTPClient {
  client: HTTPClient;
  bucket: string;
  name: string;
  _endpoints: HTTPClient["endpoints"];
  headers: Record<string, string>;
  retry: number;
  safe: boolean;
}

export function collectionHTTPClient(
  client: HTTPClient,
  bucket: string,
  name: string,
  options: CollectionOptions = {}
): CollectionHTTPClient {
  return {
    client,
    bucket,
    name,
    _endpoints: client.endpoints,
    headers: { ...options.headers },
    retry: options.retry ?? 0,
    safe: !!options.safe,
  };
}

export async function getData<T>(
  coll: CollectionHTTPClient,
  options: {
    headers?: Record<string, string>;
    query?: { [key: string]: string };
    fields?: string[];
    retry?: number;
  } = {}
): Promise<T> {
  const path = coll._endpoints.collection(coll.bucket, coll.name);
  const request = { headers: getHeaders(coll, options), path };
  const { data } = (await execute(coll.client, request, {
    retry: getRetry(coll, options),
    query: options.query,
    fields: options.fields,
  })) as { data: T };
  return data;
}

async function paginatedOperation<T>(
  client: HTTPClient,
  path: string,
  params: PaginatedParams = {},
  options: {
    headers?: Record<string, string>;
    retry?: number;
    method?: HttpMethod;
  } = {}
): Promise<PaginationResult<T>> {
  // FIXME: this is called even in batch requests, which doesn't
  // make any sense (since all batch requests get a "dummy"
  // response; see execute() above).
  const { sort, filters, limit, pages, since, fields } = {
    sort: "-last_modified",
    ...params,
  };
  // Safety/Consistency check on ETag value.
  if (since && typeof since !== "string") {
    throw new Error(
      `Invalid value for since (${since}), should be ETag value.`
    );
  }

  const query: { [key: string]: any } = {
    ...filters,
    _sort: sort,
    _limit: limit,
    _since: since,
  };
  if (fields) {
    query._fields = fields;
  }
  const querystring = qsify(query);
  let results: T[] = [],
    current = 0;

  const next = async function (
    nextPage: string | null
  ): Promise<PaginationResult<T>> {
    if (!nextPage) {
      throw new Error("Pagination exhausted.");
    }

    return processNextPage(nextPage);
  };

  const processNextPage = async (
    nextPage: string
  ): Promise<PaginationResult<T>> => {
    const { headers } = options;
    return handleResponse(await request(client.http, nextPage, { headers }));
  };

  const pageResults = (
    results: T[],
    nextPage: string | null,
    etag: string | null
  ): PaginationResult<T> => {
    // ETag string is supposed to be opaque and stored «as-is».
    // ETag header values are quoted (because of * and W/"foo").
    return {
      last_modified: etag ? etag.replace(/"/g, "") : etag,
      data: results,
      next: next.bind(null, nextPage),
      hasNextPage: !!nextPage,
      totalRecords: -1,
    };
  };

  const handleResponse = async function ({
    headers = new Headers(),
    json = {} as DataResponse<T[]>,
  }: HttpResponse<DataResponse<T[]>>): Promise<PaginationResult<T>> {
    const nextPage = headers.get("Next-Page");
    const etag = headers.get("ETag");

    if (!pages) {
      return pageResults(json.data, nextPage, etag);
    }
    // Aggregate new results with previous ones
    results = results.concat(json.data);
    current += 1;
    if (current >= pages || !nextPage) {
      // Pagination exhausted
      return pageResults(results, nextPage, etag);
    }
    // Follow next page
    return processNextPage(nextPage);
  };

  return handleResponse(
    (await execute(
      client,
      // N.B.: This doesn't use _getHeaders, because all calls to
      // `paginatedList` are assumed to come from calls that already
      // have headers merged at e.g. the bucket or collection level.
      {
        headers: options.headers ? options.headers : {},
        path: path + "?" + querystring,
        method: options.method,
      },
      // N.B. This doesn't use _getRetry, because all calls to
      // `paginatedList` are assumed to come from calls that already
      // used `_getRetry` at e.g. the bucket or collection level.
      { raw: true, retry: options.retry || 0 }
    )) as HttpResponse<DataResponse<T[]>>
  );
}

async function listHistory<T>(
  coll: CollectionHTTPClient,
  options: PaginatedParams & {
    headers?: Record<string, string>;
    retry?: number;
  } = {}
): Promise<PaginationResult<HistoryEntry<T>>> {
  const path = coll._endpoints.history(coll.bucket);
  return paginatedOperation<HistoryEntry<T>>(coll.client, path, options, {
    headers: getHeaders(coll, options),
    retry: getRetry(coll, options),
  });
}

async function isHistoryComplete(coll: CollectionHTTPClient): Promise<boolean> {
  // We consider that if we have the collection creation event part of the
  // history, then all records change events have been tracked.
  const {
    data: [oldestHistoryEntry],
  } = await listHistory(coll, {
    limit: 1,
    filters: {
      action: "create",
      resource_name: "collection",
      collection_id: coll.name,
    },
  });
  return !!oldestHistoryEntry;
}

async function listChangesBackTo<T>(
  coll: CollectionHTTPClient,
  at: number
): Promise<HistoryEntry<T>[]> {
  // Ensure we have enough history data to retrieve the complete list of
  // changes.
  if (!(await isHistoryComplete(coll))) {
    throw new Error(
      "Computing a snapshot is only possible when the full history for a " +
        "collection is available. Here, the history plugin seems to have " +
        "been enabled after the creation of the collection."
    );
  }
  const { data: changes } = await listHistory<T>(coll, {
    pages: Infinity, // all pages up to target timestamp are required
    sort: "-target.data.last_modified",
    filters: {
      resource_name: "record",
      collection_id: coll.name,
      "max_target.data.last_modified": String(at), // eq. to <=
    },
  });
  return changes;
}

async function getSnapshot<T extends KintoObject>(
  coll: CollectionHTTPClient,
  at: number
): Promise<PaginationResult<T>> {
  if (!at || !Number.isInteger(at) || at <= 0) {
    throw new Error("Invalid argument, expected a positive integer.");
  }
  // Retrieve history and check it covers the required time range.
  const changes = await listChangesBackTo<T>(coll, at);
  // Replay changes to compute the requested snapshot.
  const seenIds = new Set();
  let snapshot: T[] = [];
  for (const {
    action,
    target: { data: record },
  } of changes) {
    if (action == "delete") {
      seenIds.add(record.id); // ensure not reprocessing deleted entries
      snapshot = snapshot.filter((r) => r.id !== record.id);
    } else if (!seenIds.has(record.id)) {
      seenIds.add(record.id);
      snapshot.push(record);
    }
  }
  return {
    last_modified: String(at),
    data: snapshot.sort((a, b) => b.last_modified - a.last_modified),
    next: () => {
      throw new Error("Snapshots don't support pagination");
    },
    hasNextPage: false,
    totalRecords: snapshot.length,
  } as PaginationResult<T>;
}

export async function listRecords<T extends KintoObject>(
  coll: CollectionHTTPClient,
  options: PaginatedParams & {
    headers?: Record<string, string>;
    retry?: number;
    at?: number;
  } = {}
): Promise<PaginationResult<T>> {
  const path = coll._endpoints.record(coll.bucket, coll.name);
  if (options.at) {
    return getSnapshot<T>(coll, options.at);
  } else {
    return paginatedOperation<T>(coll.client, path, options, {
      headers: getHeaders(coll, options),
      retry: getRetry(coll, options),
    });
  }
}

export async function batch(
  coll: CollectionHTTPClient,
  fn: (coll: CollectionHTTPClient) => void,
  options: {
    safe?: boolean;
    retry?: number;
    bucket?: string;
    collection?: string;
    headers?: Record<string, string>;
    aggregate?: boolean;
  } = {}
): Promise<OperationResponse<KintoObject>[] | AggregateResponse> {
  const rootBatch = httpClient(coll.client.remote, {
    batch: true,
    safe: getSafe(coll, options),
    retry: getRetry(coll, options),
  });
  const client = collectionHTTPClient(rootBatch, coll.bucket, coll.name, {
    safe: rootBatch.safe,
    retry: rootBatch.retry,
    headers: rootBatch.headers,
  });

  fn(client);

  const responses = await _batchRequests(
    coll.client,
    rootBatch._requests,
    options
  );
  if (options.aggregate) {
    return aggregate(responses, rootBatch._requests);
  } else {
    return responses;
  }
}

async function getHello(
  client: HTTPClient,
  options: {
    retry?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<HelloResponse> {
  const path = client.remote + ENDPOINTS.root();
  const { json } = await request<HelloResponse>(
    client.http,
    path,
    { headers: getHeaders(client, options) },
    { retry: getRetry(client, options) }
  );
  return json;
}

async function fetchServerInfo(
  client: HTTPClient,
  options: { retry?: number } = {}
): Promise<HelloResponse> {
  if (client.serverInfo) {
    return client.serverInfo;
  }
  client.serverInfo = await getHello(client, {
    retry: getRetry(client, options),
  });
  return client.serverInfo!;
}

async function fetchServerSettings(
  client: HTTPClient,
  options: { retry?: number } = {}
): Promise<ServerSettings> {
  const { settings } = await fetchServerInfo(client, options);
  return settings;
}

async function _batchRequests(
  client: HTTPClient,
  requests: KintoRequest[],
  options: {
    retry?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<OperationResponse[]> {
  const headers = getHeaders(client, options);
  if (!requests.length) {
    return [];
  }
  const serverSettings = await fetchServerSettings(client, {
    retry: getRetry(client, options),
  });
  const maxRequests = serverSettings["batch_max_requests"];
  if (maxRequests && requests.length > maxRequests) {
    const chunks = partition(requests, maxRequests);
    const results = [];
    for (const chunk of chunks) {
      const result = await _batchRequests(client, chunk, options);
      results.push(...result);
    }
    return results;
  }
  const { responses } = (await execute<BatchResponse>(
    client,
    {
      // FIXME: is this really necessary, since it's also present in
      // the "defaults"?
      headers,
      path: ENDPOINTS.batch(),
      method: "POST",
      body: {
        defaults: { headers },
        requests,
      },
    },
    { retry: getRetry(client, options) }
  )) as BatchResponse;
  return responses;
}

export function aggregate(
  responses: KintoBatchResponse[] = [],
  requests: KintoRequest[] = []
): AggregateResponse {
  console.log({ requests, responses });
  if (responses.length !== requests.length) {
    throw new Error("Responses length should match requests one.");
  }
  const results: AggregateResponse = {
    errors: [],
    published: [],
    conflicts: [],
    skipped: [],
  };
  return responses.reduce((acc, response, index) => {
    const { status } = response;
    const request = requests[index];
    if (status >= 200 && status < 400) {
      acc.published.push(response.body);
    } else if (status === 404) {
      // Extract the id manually from request path while waiting for Kinto/kinto#818
      const regex = /(buckets|groups|collections|records)\/([^/]+)$/;
      const extracts = request.path.match(regex);
      const id = extracts && extracts.length === 3 ? extracts[2] : undefined;
      acc.skipped.push({
        id,
        path: request.path,
        error: response.body,
      });
    } else if (status === 412) {
      acc.conflicts.push({
        // XXX: specifying the type is probably superfluous
        type: "outgoing",
        local: request.body,
        remote:
          (response.body.details && response.body.details.existing) || null,
      });
    } else {
      acc.errors.push({
        path: request.path,
        sent: request,
        error: response.body,
      });
    }
    return acc;
  }, results);
}

export async function createRecord<T extends MappableObject>(
  coll: CollectionHTTPClient,
  record: T & { id?: string },
  options: {
    headers?: Record<string, string>;
    retry?: number;
    safe?: boolean;
    permissions?: { [key in Permission]?: string[] };
  } = {}
): Promise<KintoResponse<T>> {
  const { permissions } = options;
  const path = coll._endpoints.record(coll.bucket, coll.name, record.id);
  const request = requests.createRequest(
    path,
    { data: record, permissions },
    {
      headers: getHeaders(coll, options),
      safe: getSafe(coll, options),
    }
  );
  return execute<KintoResponse<T>>(coll.client, request, {
    retry: getRetry(coll, options),
  }) as Promise<KintoResponse<T>>;
}

export async function updateRecord<T>(
  coll: CollectionHTTPClient,
  record: T & { id: string },
  options: {
    headers?: Record<string, string>;
    retry?: number;
    safe?: boolean;
    last_modified?: number;
    permissions?: { [key in Permission]?: string[] };
    patch?: boolean;
  } = {}
): Promise<KintoResponse<T>> {
  if (!isObject(record)) {
    throw new Error("A record object is required.");
  }
  if (!record.id) {
    throw new Error("A record id is required.");
  }
  const { permissions } = options;
  const { last_modified } = { ...record, ...options };
  const path = coll._endpoints.record(coll.bucket, coll.name, record.id);
  const request = requests.updateRequest(
    path,
    { data: record, permissions },
    {
      headers: getHeaders(coll, options),
      safe: getSafe(coll, options),
      last_modified,
      patch: !!options.patch,
    }
  );
  return execute<KintoResponse<T>>(coll.client, request, {
    retry: getRetry(coll, options),
  }) as Promise<KintoResponse<T>>;
}

export async function deleteRecord(
  coll: CollectionHTTPClient,
  record: string | KintoIdObject,
  options: {
    headers?: Record<string, string>;
    retry?: number;
    safe?: boolean;
    last_modified?: number;
  } = {}
): Promise<KintoResponse<{ deleted: boolean }>> {
  const recordObj = toDataBody(record);
  if (!recordObj.id) {
    throw new Error("A record id is required.");
  }
  const { id } = recordObj;
  const { last_modified } = { ...recordObj, ...options };
  const path = coll._endpoints.record(coll.bucket, coll.name, id);
  const request = requests.deleteRequest(path, {
    last_modified,
    headers: getHeaders(coll, options),
    safe: getSafe(coll, options),
  });
  return execute<KintoResponse<{ deleted: boolean }>>(coll.client, request, {
    retry: getRetry(coll, options),
  }) as Promise<KintoResponse<{ deleted: boolean }>>;
}
