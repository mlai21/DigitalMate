"use client";

import { useRef, useState } from "react";
import styles from "./home.module.css";

const DEFAULT_POS = { x: -420, y: 20 };

export function DraggableMascot() {
  const imgRef = useRef<HTMLImageElement>(null);
  const [mascotPos, setMascotPos] = useState(DEFAULT_POS);
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, startX: 0, startY: 0 });

  // 把提议的 translate 夹取到 [data-mascot-bounds] 容器（红框）内
  const clamp = (nextX: number, nextY: number) => {
    const img = imgRef.current;
    const bounds = img?.closest("[data-mascot-bounds]") as HTMLElement | null;
    if (!img || !bounds) {
      return { x: nextX, y: nextY };
    }
    const imgRect = img.getBoundingClientRect();
    const boundRect = bounds.getBoundingClientRect();
    // 当前 translate 与 rect 的关系：改变 translate 会等量平移 rect
    const minX = mascotPos.x + (boundRect.left - imgRect.left);
    const maxX = mascotPos.x + (boundRect.right - imgRect.right);
    const minY = mascotPos.y + (boundRect.top - imgRect.top);
    const maxY = mascotPos.y + (boundRect.bottom - imgRect.bottom);
    return {
      x: Math.min(Math.max(nextX, minX), maxX),
      y: Math.min(Math.max(nextY, minY), maxY),
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startX: mascotPos.x,
      startY: mascotPos.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setMascotPos(clamp(dragStartRef.current.startX + dx, dragStartRef.current.startY + dy));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    draggingRef.current = false;
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      alt="DigitalMate 眨眼动画"
      className={styles.heroMascot}
      src="/home/blink.gif"
      style={{
        transform: `translate(${mascotPos.x}px, ${mascotPos.y}px)`,
        cursor: isDragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
