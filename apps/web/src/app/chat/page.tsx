"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { streamChat } from "@/lib/thumper-stream";
import { SessionSidebar } from "@/components/chat/SessionSidebar";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import { handleTwitterToken } from "@/lib/thumper-api";
import { createChatVault, didKeyFromVerifying } from "@/lib/chat-vault";
import {
  loadSessions as loadSessionsFromStore,
  saveSessions as saveSessionsToStore,
} from "@/lib/chat-history-store";
import { selectRoute, useSovereigntyMode } from "@/lib/sovereignty";
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

export default function ChatPage() {
  const [sessions, setSessions] = useState<ThumperSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [providerInfo, setProviderInfo] = useState<{ type: string; model?: string; provider_name?: string } | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const { setAuth } = useThumperAuth();
  const { createWallet, walletAddress, signBytes } = useTurnkeyWallet();

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
        .then((data: { token: string }) => {
          const res = handleTwitterToken(data.token);
          setAuth(res.token, res.user);
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

  const handleSend = async (text: string) => {
    if (isStreaming) return;

    let sessionId = activeSessionId;

    // Auto-create session if none active
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
        // Fire-and-forget: the store handles its own errors and falls
        // back to localStorage if the encrypted path is unavailable.
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

    // Set title from first message
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

    setIsStreaming(true);
    setProviderInfo(null);
    let fullContent = "";
    const currentSessionId = sessionId;

    // v1: route is informational. The transport differences land in
    // the next two PRs (sealed inference + local inference). Log the
    // caveat so anyone tailing the console sees that Private / Local
    // are not yet enforcing what their labels imply.
    const route = selectRoute(sovereigntyMode);
    if (route.caveat) {
      // eslint-disable-next-line no-console
      console.info(`[sovereignty:${route.mode}] ${route.caveat}`);
    }

    // Try to seal the user's message under the session's DEK before
    // sending. If sealing fails (no wallet, vault unlock declined,
    // network error talking to Turnkey) we fall through to the
    // plaintext path so the user can still chat. The cloud handles
    // either path — see crates/thumper-cloud/src/routes/chat.rs.
    let envelopeBlobB64: string | undefined;
    if (chatVault) {
      try {
        const sealed = await chatVault.sealUserMessage(currentSessionId, text);
        envelopeBlobB64 = sealed.envelopeB64;
      } catch (err) {
        // Non-fatal: surface as a console warning, fall back to plaintext.
        // eslint-disable-next-line no-console
        console.warn("E2E sealing failed; falling back to plaintext:", err);
      }
    }

    await streamChat(currentSessionId, text, {
      envelopeBlobB64,
      onSession: (newId) => {
        // Server assigned a session ID — we can track it if needed
        // For now we keep using our local UUID
      },
      onProvider: (info) => setProviderInfo(info),
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
        // Detect actions in the final response
        const action = detectAction(fullContent);
        updateSession(currentSessionId, (s) => {
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = {
            ...msgs[msgs.length - 1],
            content: fullContent,
            action,
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
            />
            <ChatMessages messages={messages} isStreaming={isStreaming} providerInfo={providerInfo} />
            <ChatInput onSend={handleSend} disabled={isStreaming} />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <div className="w-16 h-16 rounded-2xl bg-[#3da8ff]/10 flex items-center justify-center mb-6">
              <span className="text-2xl font-bold text-[#3da8ff]">G</span>
            </div>
            <h2 className="text-xl font-semibold text-[#eef1f8] mb-2">
              Your AI assistant
            </h2>
            <p className="text-sm text-[#8b95a8] text-center max-w-sm mb-6">
              Ask me anything. I can make phone calls, send emails, manage your calendar, and help with everyday tasks.
            </p>
            <button
              onClick={handleNewChat}
              className="rounded-xl bg-[#3da8ff] px-6 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
            >
              Start a conversation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
