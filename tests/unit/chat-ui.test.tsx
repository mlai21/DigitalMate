import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "@/components/chat/message-bubble";

describe("MessageBubble", () => {
  it("does not render internal tool details", () => {
    render(<MessageBubble role="assistant" content='{"tool_call":"web_search"}最后结果' />);

    expect(screen.queryByText(/tool_call/)).toBeNull();
    expect(screen.getByText(/最后结果/)).toBeInTheDocument();
  });
});
