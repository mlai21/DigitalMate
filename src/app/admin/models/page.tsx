import { ModelRoutingForm } from "@/components/admin/model-routing-form";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { groupCatalogByProvider, MODEL_CATALOG } from "@/server/llm/catalog";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const user = await getCurrentUser();
  if (!user) return <section className="admin-card">需要登录后管理模型。</section>;

  const settings = await createRepositories().settings.get(user.id);
  const groups = groupCatalogByProvider();

  return (
    <>
      <header className="admin-page-header">
        <h2>模型</h2>
        <p>按用途路由模型：主对话用能力优先的模型，记忆抽取、复盘等高频调用用低成本模型。</p>
      </header>
      <section className="admin-list">
        <ModelRoutingForm
          catalog={MODEL_CATALOG}
          currentMain={settings.modelRouting.main}
          currentLight={settings.modelRouting.light}
        />

        {groups.map((group) => (
          <article className="admin-card" key={group.provider}>
            <h3 className="model-provider-title">{group.provider}</h3>
            <div className="model-grid">
              {group.models.map((model) => {
                const isMain = settings.modelRouting.main === model.id;
                const isLight = settings.modelRouting.light === model.id;
                return (
                  <div className={`model-card${isMain || isLight ? " model-card-active" : ""}`} key={model.id}>
                    <div className="model-card-header">
                      <strong>{model.label}</strong>
                      <div className="conversation-list-tags">
                        {isMain ? <span className="tag tag-accent">主对话</span> : null}
                        {isLight ? <span className="tag tag-accent">轻量</span> : null}
                      </div>
                    </div>
                    <code className="model-card-id">{model.id}</code>
                    <p>{model.description}</p>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
