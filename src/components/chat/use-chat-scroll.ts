"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { collectUnreadMessageIds, isNearChatBottom } from "./chat-scroll-state";

type UseChatScrollInput = {
  conversationId?: string;
  messageIds: string[];
};

type UseChatScrollResult = {
  containerRef: RefObject<HTMLDivElement | null>;
  endRef: RefObject<HTMLDivElement | null>;
  unreadCount: number;
  jumpToLatest: () => void;
};

export function useChatScroll({
  conversationId,
  messageIds,
}: UseChatScrollInput): UseChatScrollResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const previousIdsRef = useRef<Set<string>>(new Set());
  const unreadIdsRef = useRef<Set<string>>(new Set());
  const previousConversationIdRef = useRef<string | undefined>(conversationId);
  const initializedRef = useRef(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const clearUnread = useCallback(() => {
    unreadIdsRef.current = new Set();
    setUnreadCount(0);
  }, []);

  const jumpToLatest = useCallback(() => {
    followLatestRef.current = true;
    clearUnread();
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [clearUnread]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const isNearBottom = isNearChatBottom(container);
      followLatestRef.current = isNearBottom;
      if (isNearBottom) clearUnread();
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [clearUnread]);

  useEffect(() => {
    const conversationChanged =
      !initializedRef.current || previousConversationIdRef.current !== conversationId;

    if (conversationChanged) {
      initializedRef.current = true;
      previousConversationIdRef.current = conversationId;
      previousIdsRef.current = new Set(messageIds);
      unreadIdsRef.current = new Set();
      followLatestRef.current = true;
      setUnreadCount(0);
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
      return;
    }

    const newIds = messageIds.filter((id) => !previousIdsRef.current.has(id));
    previousIdsRef.current = new Set([...previousIdsRef.current, ...messageIds]);

    if (!followLatestRef.current) {
      if (newIds.length > 0) {
        unreadIdsRef.current = collectUnreadMessageIds(unreadIdsRef.current, newIds);
        setUnreadCount(unreadIdsRef.current.size);
      }
      return;
    }

    const animationFrameId = requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });

    return () => cancelAnimationFrame(animationFrameId);
  }, [conversationId, messageIds]);

  return { containerRef, endRef, unreadCount, jumpToLatest };
}
