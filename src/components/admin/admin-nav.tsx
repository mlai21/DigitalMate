"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Brain,
  Cpu,
  FileClock,
  Gauge,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  Puzzle,
  Settings,
  Sparkles,
  Wrench,
  Hammer,
} from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
};

type NavGroup = {
  title: string | null;
  items: NavItem[];
};

const groups: NavGroup[] = [
  {
    title: null,
    items: [{ href: "/admin-legacy", label: "概览", icon: <Gauge size={16} /> }],
  },
  {
    title: "对话",
    items: [
      { href: "/admin-legacy/conversations", label: "会话日志", icon: <MessagesSquare size={16} /> },
      { href: "/admin-legacy/interjections", label: "插话决策", icon: <MessageSquare size={16} /> },
      { href: "/admin-legacy/reminders", label: "主动消息", icon: <Bell size={16} /> },
    ],
  },
  {
    title: "自进化",
    items: [
      { href: "/admin-legacy/memories", label: "记忆", icon: <Brain size={16} /> },
      { href: "/admin-legacy/reflections", label: "反思", icon: <Sparkles size={16} /> },
      { href: "/admin-legacy/skills", label: "Skills", icon: <Puzzle size={16} /> },
    ],
  },
  {
    title: "工作区",
    items: [
      { href: "/admin-legacy/tasks", label: "任务", icon: <ListTodo size={16} /> },
      { href: "/admin-legacy/tools", label: "工具日志", icon: <Wrench size={16} /> },
      { href: "/admin-legacy/tool-registrations", label: "工具注册", icon: <Hammer size={16} /> },
      { href: "/admin-legacy/usage", label: "用量", icon: <FileClock size={16} /> },
    ],
  },
  {
    title: "设置",
    items: [
      { href: "/admin-legacy/models", label: "模型", icon: <Cpu size={16} /> },
      { href: "/admin-legacy/settings", label: "设置", icon: <Settings size={16} /> },
    ],
  },
  {
    title: "迁移",
    items: [
      { href: "/admin", label: "返回新控制台", icon: <Gauge size={16} /> },
    ],
  },
];

export function AdminNav() {
  const pathname = usePathname() ?? "";

  function isActive(href: string): boolean {
    if (href === "/admin-legacy") return pathname === "/admin-legacy";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="admin-nav" aria-label="后台导航">
      {groups.map((group, index) => (
        <div className="admin-nav-group" key={group.title ?? `group-${index}`}>
          {group.title ? <p className="admin-nav-group-title">{group.title}</p> : null}
          {group.items.map((item) => (
            <Link key={item.href} href={item.href} className={isActive(item.href) ? "active" : undefined}>
              {item.icon}
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
