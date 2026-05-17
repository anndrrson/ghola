import type { ChatAgent, ChatMessageLocal } from "./types";

const DB_NAME = "ghola-chat";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("agents")) {
        const agentStore = db.createObjectStore("agents", { keyPath: "id" });
        agentStore.createIndex("lastMessageAt", "lastMessageAt");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const msgStore = db.createObjectStore("messages", { keyPath: "id" });
        msgStore.createIndex("agentId", "agentId");
        msgStore.createIndex("timestamp", "timestamp");
        msgStore.createIndex("agentId_timestamp", ["agentId", "timestamp"]);
      }
    };
  });
}

// ── Agents ──

export async function getAgents(): Promise<ChatAgent[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("agents", "readonly");
    const store = tx.objectStore("agents");
    const request = store.getAll();
    request.onsuccess = () => {
      const agents = request.result as ChatAgent[];
      agents.sort((a, b) => {
        const aTime = a.lastMessageAt || a.createdAt;
        const bTime = b.lastMessageAt || b.createdAt;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
      resolve(agents);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getAgent(id: string): Promise<ChatAgent | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("agents", "readonly");
    const store = tx.objectStore("agents");
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as ChatAgent | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAgent(agent: ChatAgent): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("agents", "readwrite");
    const store = tx.objectStore("agents");
    store.put(agent);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteAgentData(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["agents", "messages"], "readwrite");
    tx.objectStore("agents").delete(id);
    // Delete all messages for this agent
    const msgStore = tx.objectStore("messages");
    const index = msgStore.index("agentId");
    const request = index.openCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Messages ──

export async function getMessages(agentId: string): Promise<ChatMessageLocal[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index("agentId_timestamp");
    const range = IDBKeyRange.bound([agentId, ""], [agentId, "\uffff"]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as ChatMessageLocal[]);
    request.onerror = () => reject(request.error);
  });
}

export async function saveMessage(message: ChatMessageLocal): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    store.put(message);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateMessage(id: string, content: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if (getReq.result) {
        const msg = getReq.result;
        msg.content = content;
        store.put(msg);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearMessages(agentId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const index = store.index("agentId");
    const request = index.openCursor(IDBKeyRange.only(agentId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
