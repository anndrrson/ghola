"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { streamChat } from "@/lib/thumper-stream";
import { SessionSidebar } from "@/components/chat/SessionSidebar";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { LocalSetupBanner } from "@/components/chat/LocalSetupBanner";
import { SovereigntyPicker } from "@/components/SovereigntyPicker";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import { handleTwitterSession } from "@/lib/thumper-api";
import { createChatVault, didKeyFromVerifying } from "@/lib/chat-vault";
import {
  loadSessions as loadSessionsFromStore,
  saveSessions as saveSessionsToStore,
} from "@/lib/chat-history-store";
import {
  fetchPrivateAvailability,
  selectRoute,
  useSovereigntyMode,
  type SovereigntyMode,
} from "@/lib/sovereignty";
import { makeReceipt, submitReceiptToService } from "@/lib/receipt";
import { streamLocalChat } from "@/lib/local-inference";
import {
  streamWebGPUChat,
  warmEngine,
  detectWebGPU,
  DEFAULT_WEBGPU_MODEL,
} from "@/lib/webgpu-inference";
import { streamSealedChat } from "@/lib/sealed-stream";
import bs58 from "bs58";
import type { ThumperSession, ThumperChatMessage, ThumperInlineAction } from "@/lib/thumper-types";

/** Convert a Solana wallet address (base58 Ed25519 pubkey) to a `did:key:z…`. */
function solanaAddressToDid(address: string): string | null {
  try {
    const pub = bs58.decode(address);
    if (pub.length !== 32) return null;
    return didKeyFromVerifying(pub);
  } catch {
    return null;
  }
}

function detectAction(text: string): ThumperInlineAction | undefined {
  // Detect call suggestions
  const callMatch = text.match(
    /(?:call|phone|dial|ring)\s+(?:.*?)\s*(?:at\s+)?(\+?[\d\s()-]{7,})/i
  );
  if (callMatch) {
    const phone = callMatch[1].trim();
    // Extract objective from context
    const objective = text.length > 200 ? text.slice(0, 200) + "..." : text;
    return {
      type: "call",
      status: "ready",
      data: { phone_number: phone, objective },
    };
  }

  // Detect email suggestions
  const emailMatch = text.match(
    /(?:email|send|write|draft)\s+(?:an?\s+)?(?:email\s+)?(?:to\s+)?([^\s,]+@[^\s,]+)/i
  );
  if (emailMatch) {
    const to = emailMatch[1];
    // Try to extract subject
    const subjectMatch = text.match(/subject[:\s]+["']?([^"'\n]+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : "Message from ghola";
    return {
      type: "email",
      status: "ready",
      data: { to, subject, body: "" },
    };
  }

  return undefined;
}

function emitPrivacyEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  // eslint-disable-next-line no-console
  console.warn("[privacy-event]", JSON.stringify({ event, ...payload }));
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<ThumperSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [providerInfo, setProviderInfo] = useState<{ type: string; model?: string; provider_name?: string } | null>(null);
  const [privateAvailable, setPrivateAvailable] = useState(true);
  const [privateUnavailableReason, setPrivateUnavailableReason] =
    useState<string | null>(null);
  const [pendingOpenSend, setPendingOpenSend] = useState<{
    text: string;
    reason: string;
  } | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const { setAuth, authenticated, loading: authLoading } = useThumperAuth();
  const { createWallet, walletAddress, signBytes } = useTurnkeyWallet();

  // Tier 1A: anonymous visitors land on a working Local-mode chat
  // (WebGPU in-browser inference). No redirect — modes that require
  // an identity (Private, history persistence, Turnkey-signed receipts)
  // surface a sign-in prompt at the point of use rather than blocking
  // access to the chat surface entirely.

  // Chat-side E2E: when a Turnkey wallet is connected, build a vault
  // whose unlock key is gated on a Turnkey signature. Sealing happens
  // lazily on first send; if Turnkey signing fails for any reason
  // (offline, user denial, API error) we fall back to the plaintext
  // path so chat keeps working.
  const e2eEnabled =
    process.env.NEXT_PUBLIC_GHOLA_E2E !== "0" &&
    typeof window !== "undefined";
  const userDid = useMemo(
    () => (walletAddress ? solanaAddressToDid(walletAddress) : null),
    [walletAddress],
  );
  const chatVault = useMemo(() => {
    if (!e2eEnabled || !userDid) return null;
    return createChatVault({ userDid, signBytes });
  }, [e2eEnabled, userDid, signBytes]);

  // Per-DID sovereignty preference. Today the value is informational —
  // it surfaces in the chat header and (once receipts land) gets
  // tagged into every receipt so users can audit the mode each
  // message ran under. selectRoute() returns honest v1 caveats per
  // mode; we surface those as a one-line dev console warning the
  // first time a chat is sent in Private or Local so the v1->v2 gap
  // is visible to anyone actually reading the network panel.
  const { mode: sovereigntyMode, setMode: setSovereigntyMode } =
    useSovereigntyMode(userDid);

  // WebGPU engine warm-up. Cold-loading the model on first send adds a
  // ~10-30s wait before the first token; pre-loading on chat mount lets
  // the multi-hundred-megabyte download + WebGPU shader compile happen
  // in the background while the user is reading the welcome surface.
  // The actual `streamWebGPUChat` call below transparently reuses the
  // already-warm singleton — no behavior change on the send path.
  const [warmupProgress, setWarmupProgress] = useState<number | null>(null);
  useEffect(() => {
    if (sovereigntyMode !== "local") return;
    const support = detectWebGPU();
    if (!support.supported) return;
    let cancelled = false;
    setWarmupProgress((prev) => (prev === null ? 0 : prev));
    // Defer to the next microtask so we don't compete with hydration
    // paint work. `warmEngine` is idempotent — StrictMode double-invoke
    // or a re-mount won't kick off a second download.
    void warmEngine(DEFAULT_WEBGPU_MODEL, (report) => {
      if (cancelled) return;
      setWarmupProgress(report.progress);
    })
      .then(() => {
        if (!cancelled) setWarmupProgress(1);
      })
      .catch(() => {
        // Swallow — the next user-initiated send through `streamWebGPUChat`
        // will surface a proper error in the chat bubble. We don't want
        // a background load failure to disrupt the chat UI on mount.
        if (!cancelled) setWarmupProgress(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sovereigntyMode]);

  // The Local-mode banner is for ghola-home pairing UX. Anonymous /
  // WebGPU users don't need an "install ghola-home" pitch in their
  // first chat — hide the banner unless they've already paired.
  const [hasPairedGholaHome, setHasPairedGholaHome] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setHasPairedGholaHome(
        window.localStorage.getItem("ghola:home-pair-token") !== null,
      );
    } catch {
      setHasPairedGholaHome(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const availability = await fetchPrivateAvailability();
      if (cancelled) return;
      setPrivateAvailable(availability.available);
      setPrivateUnavailableReason(availability.reason);
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadSessionsFromStore(chatVault)
      .then((loaded) => {
        if (!cancelled) setSessions(loaded);
      })
      .catch(() => {
        // The store falls back to legacy plaintext on its own; if even
        // that fails we just start with an empty list.
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [chatVault]);

  // Handle Twitter OAuth callback — exchange code for token
  useEffect(() => {
    const exchangeCode = searchParams.get("code");
    if (exchangeCode) {
      fetch("/api/auth/twitter/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: exchangeCode }),
      })
        .then((res) => {
          if (!res.ok) throw new Error("Exchange failed");
          return res.json();
        })
        .then((data: { user: { id: string; email: string; name?: string } }) => {
          const res = handleTwitterSession(data.user);
          setAuth(res.user);
          // Try to create Turnkey wallet (non-fatal)
          if (res.user.email) {
            createWallet(res.user.email).catch(() => {});
          }
        })
        .catch(() => {
          // Exchange failed — code may have expired
        })
        .finally(() => {
          // Clean the URL
          router.replace("/chat");
        });
    }
  }, [searchParams, setAuth, createWallet, router]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const messages = activeSession?.messages || [];

  const updateSession = useCallback(
    (sessionId: string, updater: (s: ThumperSession) => ThumperSession) => {
      setSessions((prev) => {
        const updated = prev.map((s) =>
          s.id === sessionId ? updater(s) : s
        );
        // Fire-and-forget: the store handles its own errors and falls
        // back to localStorage if the encrypted path is unavailable.
        void saveSessionsToStore(updated, chatVault);
        return updated;
      });
    },
    [chatVault]
  );

  const handleNewChat = useCallback(() => {
    const newSession: ThumperSession = {
      id: crypto.randomUUID(),
      title: "New conversation",
      lastMessage: "",
      lastMessageAt: new Date().toISOString(),
      messages: [],
    };
    setSessions((prev) => {
      const updated = [newSession, ...prev];
      void saveSessionsToStore(updated, chatVault);
      return updated;
    });
    setActiveSessionId(newSession.id);
    setMobileView("chat");
  }, [chatVault]);

  const handleSelectSession = useCallback((session: ThumperSession) => {
    setActiveSessionId(session.id);
    setMobileView("chat");
  }, []);

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      setSessions((prev) => {
        const updated = prev.filter((s) => s.id !== sessionId);
        // Fire-and-forget: the store handles its own errors and falls
        // back to localStorage if the encrypted path is unavailable.
        void saveSessionsToStore(updated, chatVault);
        return updated;
      });
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setMobileView("list");
      }
    },
    [activeSessionId, chatVault]
  );

  const sendWithMode = async (text: string, modeOverride?: SovereigntyMode) => {
    if (isStreaming) return;
    if (pendingOpenSend && modeOverride !== "open") {
      setPendingOpenSend({ text, reason: pendingOpenSend.reason });
      return;
    }
    const effectiveMode = modeOverride ?? sovereigntyMode;

    const route = await selectRoute(effectiveMode);
    if (route.caveat) {
      // eslint-disable-next-line no-console
      console.info(`[sovereignty:${route.mode}] ${route.caveat}`);
    }
    // Provider plurality signal — the Yahya anonymity-set property:
    // a Private send lands on one provider out of `poolSize`, chosen
    // uniformly at random. Surface it so an observer of the privacy
    // event log can audit the lower bound on the anonymity set.
    if (route.transport === "relay-sealed" && route.poolSize) {
      emitPrivacyEvent("attested_pool", {
        pool_size: route.poolSize,
        selected_enclave_key_id: route.enclave?.enclave_key_id ?? null,
      });
    }

    if (route.transport === "private-unavailable") {
      const reason = route.caveat ?? "Private mode unavailable.";
      emitPrivacyEvent("private_unavailable", {
        requested_mode: "private",
        reason_codes: route.reasonCodes ?? [],
      });
      emitPrivacyEvent("forced_open_switch", {
        from: "private",
        to: "open",
        reason,
      });
      setSovereigntyMode("open");
      setPendingOpenSend({ text, reason });
      setPrivateAvailable(false);
      setPrivateUnavailableReason(reason);
      return;
    }

    if (route.transport === "relay-sealed" && !userDid) {
      const reason = "Private mode requires a connected wallet DID.";
      emitPrivacyEvent("private_unavailable", {
        requested_mode: "private",
        reason_codes: ["wallet_did_missing"],
      });
      emitPrivacyEvent("forced_open_switch", {
        from: "private",
        to: "open",
        reason,
      });
      setSovereigntyMode("open");
      setPendingOpenSend({ text, reason });
      return;
    }

    let sessionId = activeSessionId;
    if (!sessionId) {
      const newSession: ThumperSession = {
        id: crypto.randomUUID(),
        title: text.slice(0, 50),
        lastMessage: text,
        lastMessageAt: new Date().toISOString(),
        messages: [],
      };
      setSessions((prev) => {
        const updated = [newSession, ...prev];
        void saveSessionsToStore(updated, chatVault);
        return updated;
      });
      sessionId = newSession.id;
      setActiveSessionId(sessionId);
      setMobileView("chat");
    }

    const userMsg: ThumperChatMessage = {
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    const assistantMsg: ThumperChatMessage = {
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };

    updateSession(sessionId, (s) => {
      const isFirstMessage = s.messages.length === 0;
      return {
        ...s,
        title: isFirstMessage ? text.slice(0, 50) : s.title,
        lastMessage: text,
        lastMessageAt: new Date().toISOString(),
        messages: [...s.messages, userMsg, assistantMsg],
      };
    });

    setPendingOpenSend(null);
    setIsStreaming(true);
    setProviderInfo(null);

    let fullContent = "";
    let pendingActions: ThumperInlineAction[] | null = null;
    let providerSupportsToolUse = true;
    const currentSessionId = sessionId;
    const currentMode = effectiveMode;
    const messageJobId = crypto.randomUUID();
    let localProviderInfo:
      | { type: string; model?: string; provider_name?: string }
      | null = null;

    if (route.transport === "relay-sealed" && route.enclave && userDid) {
      await streamSealedChat(
        currentSessionId,
        text,
        route.enclave,
        signBytes,
        userDid,
        {
          onChunk: (chunk) => {
            fullContent += chunk;
            updateSession(currentSessionId, (s) => {
              const msgs = [...s.messages];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: fullContent,
              };
              return { ...s, messages: msgs };
            });
          },
          onDone: (providerReceipt) => {
            const fallback = detectAction(fullContent);
            const actions: ThumperInlineAction[] | undefined = fallback
              ? [fallback]
              : undefined;
            updateSession(currentSessionId, (s) => {
              const msgs = [...s.messages];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: fullContent,
                actions,
                receipt: providerReceipt,
              };
              return {
                ...s,
                lastMessage: fullContent.slice(0, 100),
                lastMessageAt: new Date().toISOString(),
                messages: msgs,
              };
            });
            setIsStreaming(false);
            void submitReceiptToService(providerReceipt);
          },
          onError: (errMsg) => {
            updateSession(currentSessionId, (s) => {
              const msgs = [...s.messages];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: fullContent || `Sealed inference error: ${errMsg}`,
              };
              return { ...s, messages: msgs };
            });
            setIsStreaming(false);
          },
        },
      );
      return;
    }

    if (route.transport === "webgpu") {
      // Build conversation history from the session — drop the trailing
      // empty assistant slot we appended above so the model isn't fed
      // its own pending blank turn. Anonymous users have no userDid,
      // so receipts are skipped (Tier 1A.5 will add self-signed local
      // receipts once the signed-in upgrade path ships).
      const priorMessages = (() => {
        const all = activeSession?.messages ?? [];
        const trimmed = all[all.length - 1]?.content === ""
          ? all.slice(0, -1)
          : all;
        return trimmed.map((m) => ({
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
        }));
      })();
      await streamWebGPUChat(priorMessages, {
        onChunk: (chunk) => {
          fullContent += chunk;
          updateSession(currentSessionId, (s) => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = {
              ...msgs[msgs.length - 1],
              content: fullContent,
            };
            return { ...s, messages: msgs };
          });
        },
        onProgress: (report) => {
          // First-load only — show the download status in the streaming
          // bubble until the engine is ready and tokens start arriving.
          if (fullContent.length === 0) {
            updateSession(currentSessionId, (s) => {
              const msgs = [...s.messages];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: report.text,
              };
              return { ...s, messages: msgs };
            });
          }
        },
        onDone: () => {
          updateSession(currentSessionId, (s) => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = {
              ...msgs[msgs.length - 1],
              content: fullContent,
            };
            return {
              ...s,
              lastMessage: fullContent.slice(0, 100),
              lastMessageAt: new Date().toISOString(),
              messages: msgs,
            };
          });
          setIsStreaming(false);
        },
        onError: (errMsg) => {
          updateSession(currentSessionId, (s) => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = {
              ...msgs[msgs.length - 1],
              content: errMsg,
            };
            return { ...s, messages: msgs };
          });
          setIsStreaming(false);
        },
      });
      return;
    }

    if (route.transport === "ghola-home") {
      await streamLocalChat(currentSessionId, text, {
        onChunk: (chunk) => {
          fullContent += chunk;
          updateSession(currentSessionId, (s) => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = {
              ...msgs[msgs.length - 1],
              content: fullContent,
            };
            return { ...s, messages: msgs };
          });
        },
        onDone: () => {
          updateSession(currentSessionId, (s) => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = {
              ...msgs[msgs.length - 1],
              content: fullContent,
            };
            return {
              ...s,
              lastMessage: fullContent.slice(0, 100),
              lastMessageAt: new Date().toISOString(),
              messages: msgs,
            };
          });
          setIsStreaming(false);
          if (userDid) {
            void (async () => {
              try {
                const receipt = await makeReceipt({
                  jobId: messageJobId,
                  mode: currentMode,
                  providerId: "ghola-home",
                  modelId: null,
                  prompt: text,
                  response: fullContent,
                  signerDid: userDid,
                  signBytes,
                });
                updateSession(currentSessionId, (s) => {
                  const msgs = [...s.messages];
                  msgs[msgs.length - 1] = {
                    ...msgs[msgs.length - 1],
                    receipt,
                  };
                  return { ...s, messages: msgs };
                });
                void submitReceiptToService(receipt);
              } catch {
                // Receipt failed — Local message still displays.
              }
            })();
          }
        },
        onError: (errMsg) => {
          updateSession(currentSessionId, (s) => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = {
              ...msgs[msgs.length - 1],
              content: errMsg,
            };
            return { ...s, messages: msgs };
          });
          setIsStreaming(false);
        },
      });
      return;
    }

    let envelopeBlobB64: string | undefined;
    if (chatVault) {
      try {
        const sealed = await chatVault.sealUserMessage(currentSessionId, text);
        envelopeBlobB64 = sealed.envelopeB64;
      } catch (err) {
        // Fail-closed: a signed-in user with a chatVault has opted into
        // E2E sealing. If sealing fails we must NOT transparently send
        // plaintext — that's a fail-open privacy regression an a16z
        // security review would flag instantly. Surface the error and
        // abort the send so the user sees what happened.
        const reason = err instanceof Error ? err.message : "unknown error";
        emitPrivacyEvent("e2e_seal_failed_fail_closed", { reason });
        updateSession(currentSessionId, (s) => {
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = {
            ...msgs[msgs.length - 1],
            content: `Send aborted: end-to-end sealing failed (${reason}). The message was not sent. Try again, or sign out + sign back in to refresh the vault.`,
          };
          return { ...s, messages: msgs };
        });
        setIsStreaming(false);
        return;
      }
    }

    await streamChat(currentSessionId, text, {
      envelopeBlobB64,
      onSession: () => {},
      onProvider: (info) => {
        setProviderInfo(info);
        localProviderInfo = info;
        if (typeof info.tool_use_supported === "boolean") {
          providerSupportsToolUse = info.tool_use_supported;
        }
      },
      onChunk: (chunk) => {
        fullContent += chunk;
        updateSession(currentSessionId, (s) => {
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = {
            ...msgs[msgs.length - 1],
            content: fullContent,
          };
          return { ...s, messages: msgs };
        });
      },
      onActions: (actions) => {
        pendingActions = actions;
      },
      onDone: () => {
        let finalActions: ThumperInlineAction[] | undefined = pendingActions ?? undefined;
        if (!finalActions?.length && !providerSupportsToolUse) {
          const fallback = detectAction(fullContent);
          if (fallback) finalActions = [fallback];
        }
        updateSession(currentSessionId, (s) => {
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = {
            ...msgs[msgs.length - 1],
            content: fullContent,
            actions: finalActions,
          };
          return {
            ...s,
            lastMessage: fullContent.slice(0, 100),
            lastMessageAt: new Date().toISOString(),
            messages: msgs,
          };
        });
        setIsStreaming(false);

        if (userDid) {
          void (async () => {
            try {
              const receipt = await makeReceipt({
                jobId: messageJobId,
                mode: currentMode,
                providerId: localProviderInfo?.provider_name ?? "ghola-cloud",
                modelId: localProviderInfo?.model ?? null,
                prompt: text,
                response: fullContent,
                signerDid: userDid,
                signBytes,
              });
              updateSession(currentSessionId, (s) => {
                const msgs = [...s.messages];
                msgs[msgs.length - 1] = {
                  ...msgs[msgs.length - 1],
                  receipt,
                };
                return { ...s, messages: msgs };
              });
              void submitReceiptToService(receipt);
            } catch {
              // No receipt this time. Message still displays.
            }
          })();
        }
      },
      onError: (error) => {
        updateSession(currentSessionId, (s) => {
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = {
            ...msgs[msgs.length - 1],
            content: fullContent || `Error: ${error.message}`,
          };
          return { ...s, messages: msgs };
        });
        setIsStreaming(false);
      },
    });
  };

  const handleSend = async (text: string) => {
    await sendWithMode(text);
  };

  const handleConfirmOpenSend = async () => {
    if (!pendingOpenSend || isStreaming) return;
    const pendingText = pendingOpenSend.text;
    setPendingOpenSend(null);
    await sendWithMode(pendingText, "open");
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div
        className={`${
          mobileView === "list" ? "flex" : "hidden"
        } lg:flex w-full lg:w-80 xl:w-96 flex-col border-r border-[#1e2a3a] bg-[#0a0b10]`}
      >
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={handleSelectSession}
          onNew={handleNewChat}
          onDelete={handleDeleteSession}
        />
      </div>

      {/* Chat area */}
      <div
        className={`${
          mobileView === "chat" ? "flex" : "hidden"
        } lg:flex flex-1 flex-col`}
      >
        {activeSessionId ? (
          <>
            <ChatHeader
              title={activeSession?.title || "New conversation"}
              onBack={() => setMobileView("list")}
              mode={sovereigntyMode}
              onModeChange={setSovereigntyMode}
              privateAvailable={privateAvailable}
              privateUnavailableReason={privateUnavailableReason}
              activeModelId={
                sovereigntyMode === "local"
                  ? DEFAULT_WEBGPU_MODEL
                  : providerInfo?.model ?? null
              }
              warmupProgress={
                sovereigntyMode === "local" ? warmupProgress : null
              }
            />
            {sovereigntyMode === "local" && hasPairedGholaHome && <LocalSetupBanner />}
            {pendingOpenSend && (
              <div className="mx-4 mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                <p className="mb-2">
                  Private send is unavailable. Mode has switched to Open. Confirm before sending this message in plaintext.
                </p>
                <p className="mb-3 text-xs text-amber-100/90">{pendingOpenSend.reason}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleConfirmOpenSend}
                    className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-semibold text-[#201400] hover:bg-amber-200 cursor-pointer"
                  >
                    Send as Open
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingOpenSend(null)}
                    className="rounded-lg border border-amber-300/60 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:border-amber-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <ChatMessages messages={messages} isStreaming={isStreaming} providerInfo={providerInfo} />
            <ChatInput onSend={handleSend} disabled={isStreaming} />
          </>
        ) : (
          <div className="flex-1 flex flex-col">
            {sovereigntyMode === "local" && hasPairedGholaHome && <LocalSetupBanner />}
            {pendingOpenSend && (
              <div className="mx-4 mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                <p className="mb-2">
                  Private send is unavailable. Mode has switched to Open. Confirm before sending this message in plaintext.
                </p>
                <p className="mb-3 text-xs text-amber-100/90">{pendingOpenSend.reason}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleConfirmOpenSend}
                    className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-semibold text-[#201400] hover:bg-amber-200 cursor-pointer"
                  >
                    Send as Open
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingOpenSend(null)}
                    className="rounded-lg border border-amber-300/60 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:border-amber-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div className="flex-1 flex flex-col items-center justify-center px-4">
            <div className="w-16 h-16 rounded-2xl bg-[#3da8ff]/10 flex items-center justify-center mb-6">
              <span className="text-2xl font-bold text-[#3da8ff]">G</span>
            </div>
            <h2 className="text-xl font-semibold text-[#eef1f8] mb-2">
              Verifiably off the record.
            </h2>
            <p className="text-sm text-[#8b95a8] text-center max-w-sm mb-6">
              Pick where your chat runs. Every message ships with a
              cryptographic receipt you can audit.
            </p>
            <div className="mb-6">
              <SovereigntyPicker
                value={sovereigntyMode}
                onChange={setSovereigntyMode}
                privateAvailable={privateAvailable}
                privateUnavailableReason={privateUnavailableReason}
              />
            </div>
            <button
              onClick={handleNewChat}
              className="rounded-xl bg-[#3da8ff] px-6 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
            >
              New chat
            </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
