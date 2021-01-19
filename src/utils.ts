export const RE_RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function hasOwnProperty(obj: unknown, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Checks if a value is undefined.
 * @param  {Any}  value
 * @return {Boolean}
 */
function _isUndefined(value: unknown): boolean {
  return typeof value === "undefined";
}

/**
 * Sorts records in a list according to a given ordering.
 *
 * @param  {String} order The ordering, eg. `-last_modified`.
 * @param  {Array}  list  The collection to order.
 * @return {Array}
 */
export function sortObjects<T extends { [key: string]: any }>(
  order: string,
  list: T[]
): T[] {
  const hasDash = order[0] === "-";
  const field = hasDash ? order.slice(1) : order;
  const direction = hasDash ? -1 : 1;
  return list.slice().sort((a, b) => {
    if (a[field] && _isUndefined(b[field])) {
      return direction;
    }
    if (b[field] && _isUndefined(a[field])) {
      return -direction;
    }
    if (_isUndefined(a[field]) && _isUndefined(b[field])) {
      return 0;
    }
    return a[field] > b[field] ? direction : -direction;
  });
}

/**
 * Test if a single object matches all given filters.
 *
 * @param  {Object} filters  The filters object.
 * @param  {Object} entry    The object to filter.
 * @return {Boolean}
 */
export function filterObject<T extends { [key: string]: any }>(
  filters: { [key: string]: any },
  entry: T
): boolean {
  return Object.keys(filters).every((filter) => {
    const value = filters[filter];
    if (Array.isArray(value)) {
      return value.some((candidate) => candidate === entry[filter]);
    } else if (typeof value === "object") {
      return filterObject(value, entry[filter]);
    } else if (!hasOwnProperty(entry, filter)) {
      console.error(`The property ${filter} does not exist`);
      return false;
    }
    return entry[filter] === value;
  });
}

/**
 * Filters records in a list matching all given filters.
 *
 * @param  {Object} filters  The filters object.
 * @param  {Array}  list     The collection to filter.
 * @return {Array}
 */
export function filterObjects<T>(
  filters: { [key: string]: any },
  list: T[]
): T[] {
  return list.filter((entry) => {
    return filterObject(filters, entry);
  });
}

/**
 * Simple deep object comparison function. This only supports comparison of
 * serializable JavaScript objects.
 *
 * @param  {Object} a The source object.
 * @param  {Object} b The compared object.
 * @return {Boolean}
 */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (!(a && typeof a === "object") || !(b && typeof b === "object")) {
    return false;
  }
  if (Object.keys(a).length !== Object.keys(b).length) {
    return false;
  }
  for (const k in a) {
    if (!deepEqual(a[k], b[k])) {
      return false;
    }
  }
  return true;
}

/**
 * Return an object without the specified keys.
 *
 * @param  {Object} obj        The original object.
 * @param  {Array}  keys       The list of keys to exclude.
 * @return {Object}            A copy without the specified keys.
 */
export function omitKeys<
  T extends { [key: string]: unknown },
  K extends string
>(obj: T, keys: K[] = []): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

export function arrayEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = a.length; i--; ) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function makeNestedObjectFromArr(
  arr: string[],
  val: any,
  nestedFiltersObj: { [key: string]: any }
): { [key: string]: any } {
  const last = arr.length - 1;
  return arr.reduce((acc, cv, i) => {
    if (i === last) {
      return (acc[cv] = val);
    } else if (hasOwnProperty(acc, cv)) {
      return acc[cv];
    } else {
      return (acc[cv] = {});
    }
  }, nestedFiltersObj);
}

export function transformSubObjectFilters(filtersObj: { [key: string]: any }) {
  const transformedFilters = {};
  for (const key in filtersObj) {
    const keysArr = key.split(".");
    const val = filtersObj[key];
    makeNestedObjectFromArr(keysArr, val, transformedFilters);
  }
  return transformedFilters;
}

/**
 * Deeply access an object's properties
 * @param obj - The object whose property you want to compare
 * @param key - A dot notation path to the property you want to compare
 */
export function getDeepKey(obj: any, key: string): unknown {
  const segments = key.split(".");
  let result = obj;
  for (let p = 0; p < segments.length; p++) {
    result = result ? result[segments[p]] : undefined;
  }
  return result ?? undefined;
}

/**
 * Clones an object with all its undefined keys removed.
 * @private
 */
export function cleanUndefinedProperties(obj: {
  [key: string]: any;
}): {
  [key: string]: any;
} {
  const result: { [key: string]: any } = {};
  for (const key in obj) {
    if (typeof obj[key] !== "undefined") {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Transforms an object into an URL query string, stripping out any undefined
 * values.
 *
 * @param  {Object} obj
 * @return {String}
 */
export function qsify(obj: { [key: string]: any }): string {
  const encode = (v: any): string =>
    encodeURIComponent(typeof v === "boolean" ? String(v) : v);
  const stripped = cleanUndefinedProperties(obj);
  return Object.keys(stripped)
    .map((k) => {
      const ks = encode(k) + "=";
      if (Array.isArray(stripped[k])) {
        return ks + stripped[k].map((v: any) => encode(v)).join(",");
      } else {
        return ks + encode(stripped[k]);
      }
    })
    .join("&");
}

/**
 * Handle common query parameters for Kinto requests.
 *
 * @param  {String}  [path]  The endpoint base path.
 * @param  {Array}   [options.fields]    Fields to limit the
 *   request to.
 * @param  {Object}  [options.query={}]  Additional query arguments.
 */
export function addEndpointOptions(
  path: string,
  options: { fields?: string[]; query?: { [key: string]: string } } = {}
): string {
  const query: { [key: string]: any } = { ...options.query };
  if (options.fields) {
    query._fields = options.fields;
  }
  const queryString = qsify(query);
  if (queryString) {
    return path + "?" + queryString;
  }
  return path;
}

/**
 * Replace authorization header with an obscured version
 */
export function obscureAuthorizationHeader(
  headers: HeadersInit
): {
  [key: string]: string;
} {
  const h = new Headers(headers);
  if (h.has("authorization")) {
    h.set("authorization", "**** (suppressed)");
  }

  const obscuredHeaders: { [key: string]: string } = {};
  for (const [header, value] of h.entries()) {
    obscuredHeaders[header] = value;
  }

  return obscuredHeaders;
}

/**
 * Returns a Promise always resolving after the specified amount in milliseconds.
 *
 * @return Promise<void>
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RECORD_FIELDS_TO_CLEAN = ["_status"];

/**
 * Compare two records omitting local fields and synchronization
 * attributes (like _status and last_modified)
 * @param {Object} a    A record to compare.
 * @param {Object} b    A record to compare.
 * @param {Array} localFields Additional fields to ignore during the comparison
 * @return {boolean}
 */
export function recordsEqual(
  a: { [key: string]: unknown },
  b: { [key: string]: unknown },
  localFields: readonly string[] = []
): boolean {
  const fieldsToClean = [
    ...RECORD_FIELDS_TO_CLEAN,
    "last_modified",
    ...localFields,
  ];
  const cleanLocal = (r: { [key: string]: unknown }) =>
    omitKeys(r, fieldsToClean);
  return deepEqual(cleanLocal(a), cleanLocal(b));
}

export function markStatus<T extends { _status?: string }>(
  record: T,
  status: string
) {
  return { ...record, _status: status };
}

export function markDeleted<T extends { _status?: string }>(record: T) {
  return markStatus(record, "deleted");
}

export function markSynced<T extends { _status?: string }>(record: T) {
  return markStatus(record, "synced");
}

/**
 * Chunks an array into n pieces.
 *
 * @private
 * @param  {Array}  array
 * @param  {Number} n
 * @return {Array}
 */
export function partition<T>(array: T[], n: number): T[][] {
  if (n <= 0) {
    return [array];
  }
  return array.reduce<T[][]>((acc, x, i) => {
    if (i === 0 || i % n === 0) {
      acc.push([x]);
    } else {
      acc[acc.length - 1].push(x);
    }
    return acc;
  }, []);
}

export function isObject(thing: unknown): boolean {
  return typeof thing === "object" && thing !== null && !Array.isArray(thing);
}

export function toDataBody<T extends { id: string }>(
  resource: T | string
): { id: string } {
  if (isObject(resource)) {
    return resource as T;
  }
  if (typeof resource === "string") {
    return { id: resource };
  }
  throw new Error("Invalid argument.");
}
