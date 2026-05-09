// Vitest global test setup.
//
// `jsdom` does not ship an IndexedDB implementation, so the
// session-vault tests bring their own via `fake-indexeddb`. We import
// `auto` for the side effect of installing the polyfill on `globalThis`.
//
// Web Crypto (`crypto.subtle`) is available natively under Node 20+ via
// the global `crypto` object, so no shim is needed there.

import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
} from "fake-indexeddb";
import { afterEach } from "vitest";

// jsdom does not ship IndexedDB. Wire fake-indexeddb's globals up
// manually — the package's `auto` subpath has TS-resolution issues
// with package.json `exports`.
//
// We deliberately don't use `fake-indexeddb/auto` to keep the import
// graph free of side-effectful subpaths.
const g = globalThis as unknown as Record<string, unknown>;
g.indexedDB = new IDBFactory();
g.IDBKeyRange = IDBKeyRange;
g.IDBCursor = IDBCursor;
g.IDBCursorWithValue = IDBCursorWithValue;
g.IDBDatabase = IDBDatabase;
g.IDBFactory = IDBFactory;
g.IDBIndex = IDBIndex;
g.IDBObjectStore = IDBObjectStore;
g.IDBOpenDBRequest = IDBOpenDBRequest;
g.IDBRequest = IDBRequest;
g.IDBTransaction = IDBTransaction;
g.IDBVersionChangeEvent = IDBVersionChangeEvent;

// Reset the IndexedDB universe between test files so vault state
// doesn't leak across cases.
afterEach(() => {
  g.indexedDB = new IDBFactory();
});
