"use client";

import { Globe2, Send, Sparkles, X } from "lucide-react";
import { FormEvent, KeyboardEvent, Ref, useEffect, useRef, useState } from "react";

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
  onSubmit: (value: string, options?: { skillIds?: string[]; searchEnabled?: boolean }) => void;
  shellRef?: Ref<HTMLFormElement>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<SkillOption[]>([]);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [skillOptions, setSkillOptions] = useState<SkillOption[] | null>(null);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const slashQuery =
    value.startsWith("/") && !value.includes("\n") && !value.startsWith(`${CREATE_SKILL_COMMAND} `)
      ? value.slice(1)
      : null;
  const pickerOpen = slashQuery !== null && !pickerDismissed;

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

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = value.trim();
    const skillIds = selectedSkills.map((skill) => skill.id);
    const content =
      text || (selectedSkills.length > 0 ? `使用 Skill：${selectedSkills.map((skill) => skill.name).join("、")}` : "");
    if (!content || disabled) return;
    if (skillIds.length > 0 || searchEnabled) {
      onSubmit(content, {
        ...(skillIds.length > 0 ? { skillIds } : {}),
        ...(searchEnabled ? { searchEnabled: true } : {}),
      });
    } else {
      onSubmit(content);
    }
    setValue("");
    setSelectedSkills([]);
    setSearchEnabled(false);
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
    <form ref={shellRef} className="chat-input-shell" onSubmit={submit}>
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
          <button
            type="button"
            className={`search-toggle${searchEnabled ? " active" : ""}`}
            aria-label={searchEnabled ? "关闭联网搜索" : "开启联网搜索"}
            aria-pressed={searchEnabled}
            disabled={disabled}
            onClick={() => setSearchEnabled((enabled) => !enabled)}
          >
            <Globe2 size={18} strokeWidth={2} aria-hidden="true" />
            {searchEnabled ? <span>搜索</span> : null}
          </button>
          <button className="send-button" type="submit" disabled={disabled} aria-label="发送">
            <Send size={18} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </form>
  );
}
