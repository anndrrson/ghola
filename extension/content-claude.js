// SAID Content Script for Claude.ai
// Injects portable context into new conversations.

(function () {
  "use strict";

  const BADGE_ID = "said-badge";
  let contextInjected = false;
  let lastUrl = location.href;
  let cachedContext = null;

  function createBadge() {
    if (document.getElementById(BADGE_ID)) return;

    const badge = document.createElement("div");
    badge.id = BADGE_ID;
    badge.innerHTML = `
      <span class="said-dot"></span>
      <span class="said-label">SAID</span>
      <button class="said-dismiss" aria-label="Dismiss SAID badge">&times;</button>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #${BADGE_ID} {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: #1a1a2e;
        color: #e0e0e0;
        border-radius: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: default;
        user-select: none;
        transition: opacity 0.2s;
      }
      #${BADGE_ID}.said-disconnected {
        opacity: 0.6;
      }
      #${BADGE_ID} .said-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #4caf50;
        flex-shrink: 0;
      }
      #${BADGE_ID}.said-disconnected .said-dot {
        background: #f44336;
      }
      #${BADGE_ID} .said-label {
        font-weight: 600;
        letter-spacing: 0.5px;
      }
      #${BADGE_ID} .said-dismiss {
        background: none;
        border: none;
        color: #888;
        font-size: 14px;
        cursor: pointer;
        padding: 0 0 0 4px;
        line-height: 1;
      }
      #${BADGE_ID} .said-dismiss:hover {
        color: #fff;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(badge);

    badge.querySelector(".said-dismiss").addEventListener("click", () => {
      badge.remove();
    });

    chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
      if (response && !response.connected) {
        badge.classList.add("said-disconnected");
      }
    });
  }

  function isNewConversation() {
    const path = location.pathname;
    // Claude.ai: new conversation at /new, /chat, or root
    return (
      path === "/" ||
      path === "/new" ||
      path === "/chat" ||
      path.endsWith("/new")
    );
  }

  function getTextarea() {
    // Claude.ai uses a contenteditable div for its input
    return (
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector(".ProseMirror") ||
      document.querySelector("textarea")
    );
  }

  function prefixContext(context) {
    if (!context || contextInjected) return;

    const textarea = getTextarea();
    if (!textarea) return;

    const prefix = `[SAID Context - My portable AI identity and preferences follow]\n${context}\n\n[End SAID Context]\n\n`;

    if (textarea.contentEditable === "true") {
      const existingText = textarea.innerText || "";
      if (existingText.includes("[SAID Context")) return;

      const p = document.createElement("p");
      p.textContent = prefix;
      textarea.insertBefore(p, textarea.firstChild);

      // Trigger input event for Claude's editor to recognize the change
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const existingValue = textarea.value || "";
      if (existingValue.includes("[SAID Context")) return;

      textarea.value = prefix + existingValue;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    contextInjected = true;
  }

  async function fetchAndInjectContext() {
    if (contextInjected) return;

    try {
      if (!cachedContext) {
        const response = await chrome.runtime.sendMessage({
          type: "getContext",
        });
        if (response && response.context) {
          cachedContext = response.context;
        }
      }

      if (cachedContext) {
        prefixContext(cachedContext);
      }
    } catch (_) {
      // Silently fail if background script is unavailable
    }
  }

  function onUrlChange() {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      contextInjected = false;

      if (isNewConversation()) {
        fetchAndInjectContext();
      }
    }
  }

  const observer = new MutationObserver(() => {
    onUrlChange();

    if (!contextInjected && isNewConversation() && getTextarea()) {
      fetchAndInjectContext();
    }
  });

  function init() {
    createBadge();

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    if (isNewConversation()) {
      fetchAndInjectContext();
    }

    document.addEventListener(
      "focusin",
      (e) => {
        const textarea = getTextarea();
        if (
          textarea &&
          (e.target === textarea || textarea.contains(e.target))
        ) {
          if (!contextInjected && isNewConversation()) {
            fetchAndInjectContext();
          }
        }
      },
      true
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
