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
  const pendingFrameRef = useRef<number | null>(null);
  const skipNextFollowFrameRef = useRef(false);
  const previousConversationIdRef = useRef<string | undefined>(conversationId);
  const initializedRef = useRef(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const cancelPendingFrame = useCallback(() => {
    if (pendingFrameRef.current === null) return;
    cancelAnimationFrame(pendingFrameRef.current);
    pendingFrameRef.current = null;
  }, []);

  const clearUnread = useCallback(() => {
    unreadIdsRef.current = new Set();
    setUnreadCount(0);
  }, []);

  const jumpToLatest = useCallback(() => {
    const hadUnread = unreadIdsRef.current.size > 0;
    cancelPendingFrame();
    followLatestRef.current = true;
    if (hadUnread) skipNextFollowFrameRef.current = true;
    clearUnread();
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [cancelPendingFrame, clearUnread]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const isNearBottom = isNearChatBottom(container);
      followLatestRef.current = isNearBottom;
      if (isNearBottom) {
        clearUnread();
      } else {
        cancelPendingFrame();
      }
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [cancelPendingFrame, clearUnread]);

  useEffect(() => {
    const conversationChanged =
      !initializedRef.current || previousConversationIdRef.current !== conversationId;

    if (conversationChanged) {
      initializedRef.current = true;
      previousConversationIdRef.current = conversationId;
      previousIdsRef.current = new Set(messageIds);
      unreadIdsRef.current = new Set();
      skipNextFollowFrameRef.current = false;
      followLatestRef.current = true;
      setUnreadCount(0);
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
      return;
    }

    const newIds = messageIds.filter((id) => !previousIdsRef.current.has(id));
    previousIdsRef.current = new Set([...previousIdsRef.current, ...messageIds]);

    if (skipNextFollowFrameRef.current) {
      skipNextFollowFrameRef.current = false;
      if (newIds.length === 0) return;
    }

    if (!followLatestRef.current) {
      if (newIds.length > 0) {
        unreadIdsRef.current = collectUnreadMessageIds(unreadIdsRef.current, newIds);
        setUnreadCount(unreadIdsRef.current.size);
      }
      return;
    }

    pendingFrameRef.current = requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      if (!followLatestRef.current) return;
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });

    return cancelPendingFrame;
  }, [cancelPendingFrame, conversationId, messageIds]);

  useEffect(() => {
    // Keep jump suppression scoped to the render caused by clearing unread state.
    skipNextFollowFrameRef.current = false;
  });

  return { containerRef, endRef, unreadCount, jumpToLatest };
}
