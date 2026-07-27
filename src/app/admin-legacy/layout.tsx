import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { AdminNav } from "@/components/admin/admin-nav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand">
          <p className="eyebrow">DigitalMate</p>
          <h1>管理后台</h1>
        </div>
        <AdminNav />
        <div className="admin-sidebar-footer">
          <Link className="secondary-link" href="/">
            <MessageCircle size={15} />
            回到聊天
          </Link>
        </div>
      </aside>
      <div className="admin-main">
        <div className="admin-content">{children}</div>
      </div>
    </main>
  );
}
