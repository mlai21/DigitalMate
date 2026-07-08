import Link from "next/link";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;

  return (
    <main className="login-page">
      <form className="login-panel" action="/api/login" method="post">
        <p className="eyebrow">DigitalMate</p>
        <h1>欢迎回来</h1>
        <p className="muted">输入口令后，就能继续和你的数字伙伴聊天。</p>
        {params.error ? <p className="form-error">口令不对，再试一次。</p> : null}
        <label className="field-label" htmlFor="password">
          口令
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" />
        <button className="primary-button" type="submit">
          进入
        </button>
        <Link className="ghost-link" href="/">
          返回聊天
        </Link>
      </form>
    </main>
  );
}
