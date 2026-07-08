import Link from "next/link";

const items = [
  { href: "/admin", label: "概览" },
  { href: "/admin/conversations", label: "会话" },
  { href: "/admin/memories", label: "记忆" },
  { href: "/admin/tools", label: "工具" },
  { href: "/admin/usage", label: "用量" },
  { href: "/admin/reminders", label: "提醒" },
  { href: "/admin/interjections", label: "插话决策" },
  { href: "/admin/reflections", label: "反思" },
  { href: "/admin/skills", label: "Skills" },
  { href: "/admin/tasks", label: "任务" },
  { href: "/admin/tool-registrations", label: "工具注册" },
  { href: "/admin/settings", label: "设置" },
];

export function AdminNav() {
  return (
    <nav className="admin-nav" aria-label="后台导航">
      {items.map((item) => (
        <Link key={item.href} href={item.href}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
