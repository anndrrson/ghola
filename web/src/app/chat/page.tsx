"use client";

import { useState, useEffect, useCallback } from "react";
import { getAgents, saveAgent, deleteAgentData, getMessages, saveMessage } from "@/lib/chat-store";
import { streamChat } from "@/lib/chat-stream";
import { AgentList } from "@/components/chat/AgentList";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { AgentForm } from "@/components/chat/AgentForm";
import { EmptyState } from "@/components/chat/EmptyState";
import type { ChatAgent, ChatMessageLocal } from "@/lib/types";

export default function ChatPage() {
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [activeAgent, setActiveAgent] = useState<ChatAgent | null>(null);
  const [messages, setMessages] = useState<ChatMessageLocal[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<ChatAgent | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");

  // Load agents on mount
  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    const loaded = await getAgents();
    setAgents(loaded);
  };

  const loadMessages = useCallback(async (agentId: string) => {
    const msgs = await getMessages(agentId);
    setMessages(msgs);
  }, []);

  const selectAgent = useCallback(async (agent: ChatAgent) => {
    setActiveAgent(agent);
    await loadMessages(agent.id);
    setMobileView("chat");
  }, [loadMessages]);

  const handleCreateAgent = async (agent: ChatAgent) => {
    await saveAgent(agent);
    await loadAgents();
    setShowForm(false);
    setEditingAgent(null);
    await selectAgent(agent);
  };

  const handleUpdateAgent = async (agent: ChatAgent) => {
    await saveAgent(agent);
    await loadAgents();
    setShowForm(false);
    setEditingAgent(null);
    if (activeAgent?.id === agent.id) {
      setActiveAgent(agent);
    }
  };

  const handleDeleteAgent = async (agentId: string) => {
    await deleteAgentData(agentId);
    await loadAgents();
    if (activeAgent?.id === agentId) {
      setActiveAgent(null);
      setMessages([]);
      setMobileView("list");
    }
  };

  const handleSend = async (text: string) => {
    if (!activeAgent || isStreaming) return;

    const userMsg: ChatMessageLocal = {
      id: crypto.randomUUID(),
      agentId: activeAgent.id,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };

    await saveMessage(userMsg);
    setMessages((prev) => [...prev, userMsg]);

    const assistantMsg: ChatMessageLocal = {
      id: crypto.randomUUID(),
      agentId: activeAgent.id,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      model: activeAgent.model,
    };

    setMessages((prev) => [...prev, assistantMsg]);
    setIsStreaming(true);

    let fullContent = "";

    await streamChat(
      activeAgent,
      [...messages, userMsg],
      (chunk) => {
        fullContent += chunk;
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          updated[lastIdx] = { ...updated[lastIdx], content: fullContent };
          return updated;
        });
      },
      async () => {
        assistantMsg.content = fullContent;
        await saveMessage(assistantMsg);

        // Update agent's last message
        const updatedAgent = {
          ...activeAgent,
          lastMessageAt: new Date().toISOString(),
          lastMessagePreview: fullContent.slice(0, 100),
        };
        await saveAgent(updatedAgent);
        setActiveAgent(updatedAgent);
        await loadAgents();
        setIsStreaming(false);
      },
      async (error) => {
        assistantMsg.content = fullContent || `Error: ${error.message}`;
        await saveMessage(assistantMsg);
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          updated[lastIdx] = { ...updated[lastIdx], content: assistantMsg.content };
          return updated;
        });
        setIsStreaming(false);
      }
    );
  };

  const handleBack = () => {
    setMobileView("list");
  };

  return (
    <div className="flex h-full">
      {/* Sidebar - always visible on desktop, conditionally on mobile */}
      <div
        className={`${
          mobileView === "list" ? "flex" : "hidden"
        } lg:flex w-full lg:w-80 xl:w-96 flex-col border-r border-[#1e2a3a] bg-[#0a0b10]`}
      >
        <AgentList
          agents={agents}
          activeAgentId={activeAgent?.id || null}
          onSelect={selectAgent}
          onNew={() => { setEditingAgent(null); setShowForm(true); }}
          onEdit={(agent) => { setEditingAgent(agent); setShowForm(true); }}
          onDelete={handleDeleteAgent}
        />
      </div>

      {/* Chat area */}
      <div
        className={`${
          mobileView === "chat" ? "flex" : "hidden"
        } lg:flex flex-1 flex-col`}
      >
        {activeAgent ? (
          <>
            <ChatHeader
              agent={activeAgent}
              onBack={handleBack}
              onSettings={() => { setEditingAgent(activeAgent); setShowForm(true); }}
            />
            <ChatMessages messages={messages} isStreaming={isStreaming} />
            <ChatInput onSend={handleSend} disabled={isStreaming} />
          </>
        ) : (
          <EmptyState onNew={() => { setEditingAgent(null); setShowForm(true); }} />
        )}
      </div>

      {/* Agent form modal */}
      {showForm && (
        <AgentForm
          agent={editingAgent}
          onSave={editingAgent ? handleUpdateAgent : handleCreateAgent}
          onClose={() => { setShowForm(false); setEditingAgent(null); }}
        />
      )}
    </div>
  );
}
