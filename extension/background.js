// SAID Background Service Worker
// Manages daemon connection, cloud proxy, caching, and message routing.

// Connection modes
const MODE_DAEMON = 'daemon';
const MODE_CLOUD = 'cloud';

const DEFAULT_DAEMON_URL = "http://127.0.0.1:3000";
const CLOUD_API_BASE = "https://api.said.id/v1";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = {
  context: null,
  contextTimestamp: 0,
  status: null,
  statusTimestamp: 0,
};

// --- Mode helpers ---

async function getConnectionMode() {
  const { connectionMode } = await chrome.storage.local.get('connectionMode');
  return connectionMode || MODE_DAEMON;
}

async function getDaemonConfig() {
  const result = await chrome.storage.local.get(["daemonUrl", "token"]);
  return {
    daemonUrl: result.daemonUrl || DEFAULT_DAEMON_URL,
    token: result.token || "",
  };
}

// --- Daemon mode (existing) ---

async function mcpCall(name, args = {}) {
  const config = await getDaemonConfig();
  if (!config.token) {
    throw new Error("No UCAN token configured");
  }

  const response = await fetch(`${config.daemonUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: Date.now(),
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "MCP call failed");
  }
  return data.result;
}

async function pingDaemon() {
  const config = await getDaemonConfig();
  try {
    const response = await fetch(`${config.daemonUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: Date.now(),
      }),
    });

    if (!response.ok) {
      return { connected: false };
    }

    const data = await response.json();
    const tools = data.result?.tools || [];
    const capabilities = tools.map((t) => t.name);

    // Try to get DID from status tool if available
    let did = null;
    if (config.token) {
      try {
        const statusResult = await mcpCall("said_get_system_prompt", {});
        const content = statusResult?.content;
        if (Array.isArray(content)) {
          const text = content.map((c) => c.text || "").join("");
          const didMatch = text.match(/did:key:\w+/);
          if (didMatch) {
            did = didMatch[0];
          }
        }
      } catch (_) {
        // DID extraction is best-effort
      }
    }

    return { connected: true, did, capabilities };
  } catch (_) {
    return { connected: false };
  }
}

async function getDaemonStatus() {
  const now = Date.now();
  if (cache.status && now - cache.statusTimestamp < CACHE_TTL_MS) {
    return cache.status;
  }

  const status = await pingDaemon();
  cache.status = status;
  cache.statusTimestamp = now;
  return status;
}

async function getDaemonContext() {
  const now = Date.now();
  if (cache.context && now - cache.contextTimestamp < CACHE_TTL_MS) {
    return cache.context;
  }

  const result = await mcpCall("said_get_system_prompt", {});
  const content = result?.content;
  let text = "";
  if (Array.isArray(content)) {
    text = content.map((c) => c.text || "").join("\n");
  } else if (typeof content === "string") {
    text = content;
  }

  cache.context = text;
  cache.contextTimestamp = now;
  return text;
}

async function getDaemonRelevantContext(snippet) {
  const result = await mcpCall("said_search_knowledge", { query: snippet });
  const content = result?.content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text || "").join("\n");
  }
  return typeof content === "string" ? content : "";
}

// --- Cloud mode ---

async function callCloudApi(path, options = {}) {
  const { cloudToken } = await chrome.storage.local.get('cloudToken');
  if (!cloudToken) throw new Error('Not logged in to SAID Cloud');

  const response = await fetch(`${CLOUD_API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cloudToken}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('Cloud token expired or invalid');
    throw new Error(`Cloud API error: ${response.status}`);
  }
  return response.json();
}

function parseJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload;
  } catch (_) {
    return null;
  }
}

function isJwtValid(token) {
  const payload = parseJwt(token);
  if (!payload || !payload.exp) return false;
  // Allow 60s grace period
  return payload.exp * 1000 > Date.now() - 60000;
}

async function getCloudStatus() {
  const now = Date.now();
  if (cache.status && now - cache.statusTimestamp < CACHE_TTL_MS) {
    return cache.status;
  }

  const { cloudToken } = await chrome.storage.local.get('cloudToken');
  if (!cloudToken) {
    return { connected: false, mode: MODE_CLOUD };
  }

  if (!isJwtValid(cloudToken)) {
    return { connected: false, mode: MODE_CLOUD, reason: 'token_expired' };
  }

  try {
    const profile = await callCloudApi('/consumer/profile');
    const status = {
      connected: true,
      mode: MODE_CLOUD,
      did: profile.did || null,
      displayName: profile.display_name || null,
      capabilities: ['said_get_preferences', 'said_get_system_prompt'],
    };
    cache.status = status;
    cache.statusTimestamp = now;
    return status;
  } catch (err) {
    return { connected: false, mode: MODE_CLOUD, reason: err.message };
  }
}

async function getCloudContext() {
  const now = Date.now();
  if (cache.context && now - cache.contextTimestamp < CACHE_TTL_MS) {
    return cache.context;
  }

  const profile = await callCloudApi('/consumer/profile');

  let context = `# SAID Identity\n`;
  if (profile.did) context += `DID: ${profile.did}\n`;
  if (profile.display_name) context += `Name: ${profile.display_name}\n`;
  if (profile.bio) context += `Bio: ${profile.bio}\n`;
  if (profile.timezone) context += `Timezone: ${profile.timezone}\n`;

  const prefs = profile.agent_preferences;
  if (prefs) {
    context += `\n## Preferences\n`;
    if (prefs.communication_style) context += `Communication Style: ${prefs.communication_style}\n`;
    if (prefs.response_format) context += `Response Format: ${prefs.response_format}\n`;
    if (prefs.expertise_areas?.length) context += `Expertise: ${prefs.expertise_areas.join(', ')}\n`;
    if (prefs.dietary_restrictions?.length) context += `Dietary Restrictions: ${prefs.dietary_restrictions.join(', ')}\n`;
    if (prefs.accessibility_needs?.length) context += `Accessibility Needs: ${prefs.accessibility_needs.join(', ')}\n`;
  }

  cache.context = context;
  cache.contextTimestamp = now;
  return context;
}

// --- Cache management ---

function invalidateCache() {
  cache.context = null;
  cache.contextTimestamp = 0;
  cache.status = null;
  cache.statusTimestamp = 0;
}

// --- Message routing ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = async () => {
    try {
      const mode = await getConnectionMode();

      switch (message.type) {
        case "getStatus":
          if (mode === MODE_CLOUD) {
            return await getCloudStatus();
          } else {
            return await getDaemonStatus();
          }

        case "getContext":
          if (mode === MODE_CLOUD) {
            const context = await getCloudContext();
            return { context };
          } else {
            return { context: await getDaemonContext() };
          }

        case "getRelevantContext":
          if (mode === MODE_CLOUD) {
            // Knowledge search not available in cloud mode; return empty
            return { context: "" };
          } else {
            return { context: await getDaemonRelevantContext(message.snippet || "") };
          }

        case "saveToken":
          await chrome.storage.local.set({ token: message.token });
          invalidateCache();
          return { saved: true };

        case "saveDaemonUrl":
          await chrome.storage.local.set({ daemonUrl: message.url });
          invalidateCache();
          return { saved: true };

        case "saveCloudToken":
          await chrome.storage.local.set({ cloudToken: message.token });
          invalidateCache();
          return { saved: true };

        case "setConnectionMode":
          await chrome.storage.local.set({ connectionMode: message.mode });
          invalidateCache();
          return { mode: message.mode };

        case "getConnectionMode":
          return { mode };

        case "cloudLogin": {
          const response = await fetch(`${CLOUD_API_BASE}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: message.email,
              password: message.password,
            }),
          });

          if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Login failed: ${response.status} ${errBody}`);
          }

          const data = await response.json();
          const token = data.token || data.access_token || data.jwt;
          if (!token) throw new Error("No token in login response");

          await chrome.storage.local.set({ cloudToken: token });
          invalidateCache();
          return { success: true, token };
        }

        default:
          return { error: "Unknown message type" };
      }
    } catch (err) {
      return { error: err.message };
    }
  };

  handler().then(sendResponse);
  return true; // Keep message channel open for async response
});
