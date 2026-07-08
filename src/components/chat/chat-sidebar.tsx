"use client";

import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Folder,
  MoreHorizontal,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
  Pencil,
  FolderInput,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type ConversationItem = {
  id: string;
  title: string;
  channel: string;
  projectId: string | null;
  pinned: boolean;
  updatedAt: string;
  messageCount: number;
};

export type ProjectItem = {
  id: string;
  name: string;
  description: string;
};

export function ChatSidebar({
  conversations,
  projects,
  activeConversationId,
  onSelectConversation,
  onNewChat,
  onCreateProject,
  onRenameConversation,
  onTogglePin,
  onMoveToProject,
  onDeleteConversation,
  onRenameProject,
  onDeleteProject,
}: {
  conversations: ConversationItem[];
  projects: ProjectItem[];
  activeConversationId?: string;
  onSelectConversation: (id: string) => void;
  onNewChat: (projectId?: string) => void;
  onCreateProject: () => void;
  onRenameConversation: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onMoveToProject: (id: string, projectId: string | null) => void;
  onDeleteConversation: (id: string) => void;
  onRenameProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  const normalizedQuery = query.trim().toLowerCase();
  const matches = (conversation: ConversationItem) =>
    !normalizedQuery || conversation.title.toLowerCase().includes(normalizedQuery);

  const webConversations = conversations.filter((conversation) => conversation.channel === "web");
  const pinnedItems = webConversations.filter((conversation) => conversation.pinned && matches(conversation));
  const recentItems = webConversations.filter(
    (conversation) => !conversation.pinned && !conversation.projectId && matches(conversation),
  );
  const projectItems = (projectId: string) =>
    webConversations.filter(
      (conversation) => !conversation.pinned && conversation.projectId === projectId && matches(conversation),
    );

  function toggleProject(projectId: string) {
    setExpandedProjects((current) => ({ ...current, [projectId]: !current[projectId] }));
  }

  return (
    <aside className="sidebar chat-sidebar">
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <div>
            <p className="eyebrow">DigitalMate</p>
            <h1>数字伙伴</h1>
          </div>
          <button className="icon-button" type="button" aria-label="新建会话" title="新建会话" onClick={() => onNewChat()}>
            <SquarePen size={17} />
          </button>
        </div>

        <label className="sidebar-search">
          <Search size={14} />
          <input
            type="search"
            placeholder="搜索会话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索会话"
          />
        </label>
      </div>

      <div className="sidebar-scroll">
        <section className="sidebar-section">
          <p className="sidebar-section-title">项目</p>
          <button className="sidebar-row sidebar-action" type="button" onClick={onCreateProject}>
            <FolderPlus size={15} />
            新建项目
          </button>
          {projects.map((project) => {
            const expanded = expandedProjects[project.id] ?? false;
            const items = projectItems(project.id);
            return (
              <div key={project.id}>
                <div className="sidebar-row sidebar-project-row">
                  <button className="sidebar-row-main" type="button" onClick={() => toggleProject(project.id)}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Folder size={15} />
                    <span className="sidebar-row-label">{project.name}</span>
                  </button>
                  <RowMenu
                    label={`项目 ${project.name} 操作`}
                    items={[
                      { icon: <SquarePen size={14} />, label: "在项目中新建会话", onClick: () => onNewChat(project.id) },
                      { icon: <Pencil size={14} />, label: "重命名项目", onClick: () => onRenameProject(project.id) },
                      { icon: <Trash2 size={14} />, label: "删除项目", danger: true, onClick: () => onDeleteProject(project.id) },
                    ]}
                  />
                </div>
                {expanded ? (
                  <div className="sidebar-project-children">
                    {items.length === 0 ? <p className="sidebar-empty">项目内还没有会话</p> : null}
                    {items.map((conversation) => (
                      <ConversationRow
                        key={conversation.id}
                        conversation={conversation}
                        active={conversation.id === activeConversationId}
                        projects={projects}
                        onSelect={onSelectConversation}
                        onRename={onRenameConversation}
                        onTogglePin={onTogglePin}
                        onMoveToProject={onMoveToProject}
                        onDelete={onDeleteConversation}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </section>

        {pinnedItems.length > 0 ? (
          <section className="sidebar-section">
            <p className="sidebar-section-title">置顶</p>
            {pinnedItems.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeConversationId}
                projects={projects}
                onSelect={onSelectConversation}
                onRename={onRenameConversation}
                onTogglePin={onTogglePin}
                onMoveToProject={onMoveToProject}
                onDelete={onDeleteConversation}
              />
            ))}
          </section>
        ) : null}

        <section className="sidebar-section">
          <p className="sidebar-section-title">最近</p>
          {recentItems.length === 0 ? <p className="sidebar-empty">还没有会话，点右上角开始新对话。</p> : null}
          {recentItems.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeConversationId}
              projects={projects}
              onSelect={onSelectConversation}
              onRename={onRenameConversation}
              onTogglePin={onTogglePin}
              onMoveToProject={onMoveToProject}
              onDelete={onDeleteConversation}
            />
          ))}
        </section>
      </div>

      <nav className="side-nav sidebar-footer">
        <Link href="/admin">
          <Settings size={16} />
          管理后台
        </Link>
      </nav>
    </aside>
  );
}

function ConversationRow({
  conversation,
  active,
  projects,
  onSelect,
  onRename,
  onTogglePin,
  onMoveToProject,
  onDelete,
}: {
  conversation: ConversationItem;
  active: boolean;
  projects: ProjectItem[];
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onMoveToProject: (id: string, projectId: string | null) => void;
  onDelete: (id: string) => void;
}) {
  const moveTargets = projects.filter((project) => project.id !== conversation.projectId);
  return (
    <div className={`sidebar-row sidebar-conversation-row${active ? " active" : ""}`}>
      <button className="sidebar-row-main" type="button" onClick={() => onSelect(conversation.id)}>
        <span className="sidebar-row-label">{conversation.title}</span>
      </button>
      <RowMenu
        label={`会话 ${conversation.title} 操作`}
        items={[
          { icon: <Pencil size={14} />, label: "重命名", onClick: () => onRename(conversation.id) },
          conversation.pinned
            ? { icon: <PinOff size={14} />, label: "取消置顶", onClick: () => onTogglePin(conversation.id, false) }
            : { icon: <Pin size={14} />, label: "置顶", onClick: () => onTogglePin(conversation.id, true) },
          ...moveTargets.map((project) => ({
            icon: <FolderInput size={14} />,
            label: `移入「${project.name}」`,
            onClick: () => onMoveToProject(conversation.id, project.id),
          })),
          ...(conversation.projectId
            ? [{ icon: <FolderInput size={14} />, label: "移出项目", onClick: () => onMoveToProject(conversation.id, null) }]
            : []),
          { icon: <Trash2 size={14} />, label: "删除会话", danger: true, onClick: () => onDelete(conversation.id) },
        ]}
      />
    </div>
  );
}

type RowMenuItem = {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
};

function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="row-menu" ref={containerRef}>
      <button
        className="icon-button row-menu-trigger"
        type="button"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div className="row-menu-panel" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              className={`row-menu-item${item.danger ? " danger" : ""}`}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
