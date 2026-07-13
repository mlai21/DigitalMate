"use client";

import { Globe2, Send, Sparkles, X } from "lucide-react";
import { FormEvent, KeyboardEvent, Ref, useEffect, useRef, useState } from "react";
import {
  AttachmentPicker,
  type UploadingAttachment,
} from "@/components/chat/attachment-picker";
import type { ChatAttachment } from "@/server/attachments/types";

export type SkillOption = {
  id: string;
  name: string;
  trigger: string;
};

type PickerItem =
  | { kind: "create" }
  | { kind: "skill"; skill: SkillOption };

const CREATE_SKILL_COMMAND = "/create-skill";
const MAX_SELECTED_SKILLS = 3;

export type ChatInputSubmitOptions = {
  skillIds?: string[];
  searchEnabled?: boolean;
  attachmentIds?: string[];
  attachments?: ChatAttachment[];
};

export function filterSkillOptions(options: SkillOption[], query: string): SkillOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return options;
  return options.filter(
    (option) =>
      option.name.toLowerCase().includes(normalized) || option.trigger.toLowerCase().includes(normalized),
  );
}

export function ChatInput({
  disabled,
  onSubmit,
  shellRef,
}: {
  disabled?: boolean;
  onSubmit: (value: string, options?: ChatInputSubmitOptions) => Promise<boolean>;
  shellRef?: Ref<HTMLFormElement>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<SkillOption[]>([]);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [skillOptions, setSkillOptions] = useState<SkillOption[] | null>(null);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [attachments, setAttachments] = useState<UploadingAttachment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const slashQuery =
    value.startsWith("/") && !value.includes("\n") && !value.startsWith(`${CREATE_SKILL_COMMAND} `)
      ? value.slice(1)
      : null;
  const pickerOpen = slashQuery !== null && !pickerDismissed;

  useEffect(() => {
    if (pickerOpen) document.dispatchEvent(new Event("chat-skill-picker-open"));
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen || skillOptions !== null) return;
    let cancelled = false;
    fetch("/api/skills")
      .then(async (response) => (response.ok ? ((await response.json()) as { skills?: SkillOption[] }) : {}))
      .then((data) => {
        if (!cancelled) setSkillOptions(data.skills ?? []);
      })
      .catch(() => {
        if (!cancelled) setSkillOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, skillOptions]);

  const pickerItems: PickerItem[] = pickerOpen
    ? [
        ...("create-skill".includes((slashQuery ?? "").trim().toLowerCase()) || !slashQuery?.trim()
          ? [{ kind: "create" } as PickerItem]
          : []),
        ...filterSkillOptions(skillOptions ?? [], slashQuery ?? "")
          .filter((option) => !selectedSkills.some((skill) => skill.id === option.id))
          .slice(0, 8)
          .map((skill) => ({ kind: "skill", skill }) as PickerItem),
      ]
    : [];

  function pickItem(item: PickerItem) {
    if (item.kind === "create") {
      setValue(`${CREATE_SKILL_COMMAND} `);
    } else {
      setSelectedSkills((current) =>
        current.length >= MAX_SELECTED_SKILLS || current.some((skill) => skill.id === item.skill.id)
          ? current
          : [...current, item.skill],
      );
      setValue("");
    }
    setActiveIndex(0);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = value.trim();
    const skillIds = selectedSkills.map((skill) => skill.id);
    const readyAttachments = attachments.filter(
      (attachment): attachment is UploadingAttachment & { id: string; status: "ready" } =>
        attachment.status === "ready" && Boolean(attachment.id),
    );
    const content =
      text || (selectedSkills.length > 0 ? `使用 Skill：${selectedSkills.map((skill) => skill.name).join("、")}` : "");
    const hasPendingUpload = attachments.some((attachment) => attachment.status === "uploading");
    if ((!content && readyAttachments.length === 0) || disabled || isSubmitting || hasPendingUpload) return;
    const options: ChatInputSubmitOptions = {
      ...(skillIds.length > 0 ? { skillIds } : {}),
      ...(searchEnabled ? { searchEnabled: true } : {}),
      ...(readyAttachments.length > 0
        ? {
            attachmentIds: readyAttachments.map((attachment) => attachment.id),
            attachments: readyAttachments.map(toSafeChatAttachment),
          }
        : {}),
    };
    const hasOptions = Object.keys(options).length > 0;
    setIsSubmitting(true);
    let succeeded = false;
    try {
      succeeded = hasOptions ? await onSubmit(content, options) : await onSubmit(content);
    } catch {
      succeeded = false;
    } finally {
      setIsSubmitting(false);
    }
    if (!succeeded) return;
    setValue("");
    setSelectedSkills([]);
    setSearchEnabled(false);
    setAttachments([]);
    setPickerDismissed(false);
    if (ref.current) ref.current.style.height = "";
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerOpen && pickerItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % pickerItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + pickerItems.length) % pickerItems.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        pickItem(pickerItems[Math.min(activeIndex, pickerItems.length - 1)]);
        if (ref.current) ref.current.style.height = "";
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPickerDismissed(true);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form
      ref={shellRef}
      className="chat-input-shell"
      onSubmit={submit}
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-attachment-picker-trigger]")) {
          setPickerDismissed(true);
        }
      }}
    >
      {pickerOpen ? (
        <div className="skill-picker-panel" role="listbox" aria-label="Skill 列表">
          {pickerItems.length === 0 ? (
            <div className="skill-picker-empty">{skillOptions === null ? "加载中…" : "没有匹配的 Skill"}</div>
          ) : (
            pickerItems.map((item, index) => (
              <button
                key={item.kind === "create" ? "__create__" : item.skill.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`skill-picker-item${index === activeIndex ? " active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickItem(item);
                  if (ref.current) {
                    ref.current.style.height = "";
                    ref.current.focus();
                  }
                }}
              >
                {item.kind === "create" ? (
                  <>
                    <span className="skill-picker-name">/create-skill</span>
                    <span className="skill-picker-trigger">创建一个新的 Skill</span>
                  </>
                ) : (
                  <>
                    <span className="skill-picker-name">{item.skill.name}</span>
                    <span className="skill-picker-trigger">{item.skill.trigger}</span>
                  </>
                )}
              </button>
            ))
          )}
        </div>
      ) : null}

      <div className="chat-input-stack">
        <AttachmentPicker
          attachments={attachments}
          disabled={disabled || isSubmitting}
          onChange={setAttachments}
        />
        {selectedSkills.length > 0 ? (
          <div className="skill-chip-row">
            {selectedSkills.map((skill) => (
              <span key={skill.id} className="skill-chip" title={skill.trigger}>
                <Sparkles size={13} aria-hidden="true" />
                <span className="skill-chip-name">{skill.name}</span>
                <button
                  type="button"
                  className="skill-chip-remove"
                  aria-label={`移除 Skill ${skill.name}`}
                  onClick={() =>
                    setSelectedSkills((current) => current.filter((item) => item.id !== skill.id))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="chat-input-row">
          <textarea
            ref={ref}
            aria-label="输入消息"
            placeholder={searchEnabled ? "搜索网页" : "今天想聊点什么？输入 / 可指定 Skill"}
            rows={1}
            disabled={disabled}
            value={value}
            onKeyDown={handleKeyDown}
            onChange={(event) => {
              setValue(event.target.value);
              if (!event.target.value.startsWith("/")) setPickerDismissed(false);
            }}
            onInput={(event) => {
              const element = event.currentTarget;
              element.style.height = "auto";
              element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
            }}
          />
        </div>
        <div className="chat-input-toolbar">
          <div className="chat-input-toolbar-left">
            <button
              type="button"
              className={`search-toggle${searchEnabled ? " active" : ""}`}
              aria-label={searchEnabled ? "关闭联网搜索" : "开启联网搜索"}
              aria-pressed={searchEnabled}
              disabled={disabled || isSubmitting}
              onClick={() => setSearchEnabled((enabled) => !enabled)}
            >
              <Globe2 size={18} strokeWidth={2} aria-hidden="true" />
              {searchEnabled ? <span>搜索</span> : null}
            </button>
          </div>
          <button
            className="send-button"
            type="submit"
            disabled={
              disabled
              || isSubmitting
              || attachments.some((attachment) => attachment.status === "uploading")
              || (!value.trim() && selectedSkills.length === 0 && !attachments.some((attachment) => attachment.status === "ready"))
            }
            aria-label="发送"
          >
            <Send size={18} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </form>
  );
}

function toSafeChatAttachment(
  attachment: UploadingAttachment & { id: string; status: "ready" },
): ChatAttachment {
  return {
    id: attachment.id,
    kind: attachment.kind,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    status: "ready",
    downloadUrl: `/api/chat/attachments/${attachment.id}/download`,
  };
}
