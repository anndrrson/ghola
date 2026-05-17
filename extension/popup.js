// SAID Popup Script

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const didDisplay = document.getElementById("did-display");
const capabilitiesSection = document.getElementById("capabilities-section");
const capabilitiesList = document.getElementById("capabilities-list");

// Daemon elements
const daemonUrlInput = document.getElementById("daemon-url");
const tokenInput = document.getElementById("token");
const saveUrlBtn = document.getElementById("save-url");
const saveTokenBtn = document.getElementById("save-token");
const configDaemon = document.getElementById("config-daemon");

// Cloud elements
const cloudTokenInput = document.getElementById("cloud-token");
const saveCloudTokenBtn = document.getElementById("save-cloud-token");
const cloudEmailInput = document.getElementById("cloud-email");
const cloudPasswordInput = document.getElementById("cloud-password");
const cloudLoginBtn = document.getElementById("cloud-login-btn");
const cloudLoginError = document.getElementById("cloud-login-error");
const configCloud = document.getElementById("config-cloud");

// Mode tabs
const tabDaemon = document.getElementById("tab-daemon");
const tabCloud = document.getElementById("tab-cloud");

let currentMode = "daemon";

// --- Status display ---

function setStatus(connected, did, extra) {
  statusDot.className = "status-dot " + (connected ? "connected" : "disconnected");

  if (connected) {
    const modeLabel = currentMode === "cloud" ? "Cloud" : "Daemon";
    statusText.textContent = `Connected (${modeLabel})`;
  } else {
    if (extra && extra.reason === "token_expired") {
      statusText.textContent = "Token Expired";
    } else {
      statusText.textContent = "Disconnected";
    }
  }

  if (did) {
    const truncated = did.length > 30
      ? did.slice(0, 16) + "..." + did.slice(-8)
      : did;
    didDisplay.textContent = truncated;
    didDisplay.title = did;
    didDisplay.style.display = "block";
  } else {
    didDisplay.style.display = "none";
  }
}

function setCapabilities(capabilities) {
  if (!capabilities || capabilities.length === 0) {
    capabilitiesSection.style.display = "none";
    return;
  }

  capabilitiesList.innerHTML = "";
  for (const cap of capabilities) {
    const li = document.createElement("li");
    li.textContent = cap;
    capabilitiesList.appendChild(li);
  }
  capabilitiesSection.style.display = "block";
}

// --- Mode switching ---

function switchMode(mode) {
  currentMode = mode;

  tabDaemon.classList.toggle("active", mode === "daemon");
  tabCloud.classList.toggle("active", mode === "cloud");

  configDaemon.style.display = mode === "daemon" ? "block" : "none";
  configCloud.style.display = mode === "cloud" ? "block" : "none";

  // Clear error on switch
  cloudLoginError.textContent = "";
}

tabDaemon.addEventListener("click", async () => {
  switchMode("daemon");
  await chrome.runtime.sendMessage({ type: "setConnectionMode", mode: "daemon" });
  checkStatus();
});

tabCloud.addEventListener("click", async () => {
  switchMode("cloud");
  await chrome.runtime.sendMessage({ type: "setConnectionMode", mode: "cloud" });
  checkStatus();
});

// --- Config loading ---

async function loadConfig() {
  const result = await chrome.storage.local.get(["daemonUrl", "token", "cloudToken", "connectionMode"]);

  if (result.daemonUrl) {
    daemonUrlInput.value = result.daemonUrl;
  }
  if (result.token) {
    tokenInput.value = result.token;
  }
  if (result.cloudToken) {
    cloudTokenInput.value = result.cloudToken;
  }

  const mode = result.connectionMode || "daemon";
  switchMode(mode);
}

// --- Status check ---

async function checkStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "getStatus" });
    if (response && !response.error) {
      setStatus(response.connected, response.did, response);
      setCapabilities(response.capabilities);
    } else {
      setStatus(false, null);
    }
  } catch (_) {
    setStatus(false, null);
  }
}

// --- Daemon config handlers ---

saveUrlBtn.addEventListener("click", async () => {
  const url = daemonUrlInput.value.trim();
  if (!url) return;

  saveUrlBtn.textContent = "...";
  await chrome.runtime.sendMessage({ type: "saveDaemonUrl", url });
  saveUrlBtn.textContent = "Saved";
  setTimeout(() => { saveUrlBtn.textContent = "Save"; }, 1500);

  checkStatus();
});

saveTokenBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) return;

  saveTokenBtn.textContent = "...";
  await chrome.runtime.sendMessage({ type: "saveToken", token });
  saveTokenBtn.textContent = "Saved";
  setTimeout(() => { saveTokenBtn.textContent = "Save"; }, 1500);

  checkStatus();
});

// --- Cloud config handlers ---

saveCloudTokenBtn.addEventListener("click", async () => {
  const token = cloudTokenInput.value.trim();
  if (!token) return;

  saveCloudTokenBtn.textContent = "...";
  cloudLoginError.textContent = "";

  const response = await chrome.runtime.sendMessage({ type: "saveCloudToken", token });
  if (response && response.error) {
    cloudLoginError.textContent = response.error;
    saveCloudTokenBtn.textContent = "Save";
  } else {
    saveCloudTokenBtn.textContent = "Saved";
    setTimeout(() => { saveCloudTokenBtn.textContent = "Save"; }, 1500);
  }

  checkStatus();
});

cloudLoginBtn.addEventListener("click", async () => {
  const email = cloudEmailInput.value.trim();
  const password = cloudPasswordInput.value;

  if (!email || !password) {
    cloudLoginError.textContent = "Email and password are required";
    return;
  }

  cloudLoginBtn.textContent = "Logging in...";
  cloudLoginBtn.disabled = true;
  cloudLoginError.textContent = "";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "cloudLogin",
      email,
      password,
    });

    if (response && response.error) {
      cloudLoginError.textContent = response.error;
    } else if (response && response.success) {
      cloudLoginBtn.textContent = "Logged in!";
      cloudPasswordInput.value = "";
      if (response.token) {
        cloudTokenInput.value = response.token;
      }
      checkStatus();
      setTimeout(() => {
        cloudLoginBtn.textContent = "Log In";
        cloudLoginBtn.disabled = false;
      }, 2000);
      return;
    }
  } catch (err) {
    cloudLoginError.textContent = "Login failed: " + err.message;
  }

  cloudLoginBtn.textContent = "Log In";
  cloudLoginBtn.disabled = false;
});

// --- Initialize ---

loadConfig();
checkStatus();
