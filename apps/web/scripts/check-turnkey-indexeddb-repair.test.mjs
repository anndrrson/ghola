import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.window = globalThis;

const kitRoot = await realpath(new URL("../node_modules/@turnkey/react-wallet-kit", import.meta.url));
const stamperUrl = pathToFileURL(
  path.resolve(kitRoot, "../core/dist/__stampers__/api/web/stamper.mjs"),
).href;
const { IndexedDbStamper } = await import(stamperUrl);

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("TurnkeyStamperDB");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test database deletion was blocked"));
  });
}

function createDatabase(version, withKeyStore) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("TurnkeyStamperDB", version);
    request.onupgradeneeded = () => {
      if (withKeyStore) request.result.createObjectStore("KeyStore");
      else request.result.createObjectStore("LegacyStore");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function inspectDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("TurnkeyStamperDB");
    request.onsuccess = () => {
      const db = request.result;
      const result = {
        version: db.version,
        hasKeyStore: db.objectStoreNames.contains("KeyStore"),
      };
      db.close();
      resolve(result);
    };
    request.onerror = () => reject(request.error);
  });
}

test("repairs a higher-version database that is missing KeyStore", async () => {
  await deleteDatabase();
  const legacyDb = await createDatabase(7, false);
  legacyDb.close();

  const stamper = new IndexedDbStamper();
  const publicKey = await stamper.createKeyPair();
  const stamp = await stamper.stamp("ghola-preflight", publicKey);
  assert.equal(typeof stamp.stampHeaderValue, "string");
  assert.ok(stamp.stampHeaderValue.length > 0);
  assert.deepEqual(await inspectDatabase(), { version: 8, hasKeyStore: true });
  await stamper.deleteKeyPair(publicKey);
});

test("opens an intact higher-version database without VersionError", async () => {
  await deleteDatabase();
  const currentDb = await createDatabase(12, true);
  currentDb.close();

  const stamper = new IndexedDbStamper();
  const publicKey = await stamper.createKeyPair();
  assert.equal((await stamper.listKeyPairs()).includes(publicKey), true);
  assert.deepEqual(await inspectDatabase(), { version: 12, hasKeyStore: true });
  await stamper.deleteKeyPair(publicKey);
  await deleteDatabase();
});
