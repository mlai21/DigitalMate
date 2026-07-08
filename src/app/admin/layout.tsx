import Link from "next/link";
import { AdminNav } from "@/components/admin/admin-nav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="eyebrow">DigitalMate</p>
          <h1>管理后台</h1>
        </div>
        <Link className="secondary-link" href="/">
          回到聊天
        </Link>
      </header>
      <AdminNav />
      {children}
    </main>
  );
}
