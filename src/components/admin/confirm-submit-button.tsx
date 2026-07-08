"use client";

import type { MouseEvent, ReactNode } from "react";

export function ConfirmSubmitButton({
  children,
  confirmMessage,
  className = "danger-button",
  name,
  value,
}: {
  children: ReactNode;
  confirmMessage: string;
  className?: string;
  name?: string;
  value?: string;
}) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (!window.confirm(confirmMessage)) {
      event.preventDefault();
    }
  }

  return (
    <button className={className} name={name} value={value} type="submit" onClick={handleClick}>
      {children}
    </button>
  );
}
