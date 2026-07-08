"use client";

import { useState } from "react";
import type { ModelCatalogEntry } from "@/server/llm/catalog";

const CUSTOM_VALUE = "__custom__";

export function ModelRoutingForm({
  catalog,
  currentMain,
  currentLight,
}: {
  catalog: ModelCatalogEntry[];
  currentMain: string;
  currentLight: string;
}) {
  return (
    <form className="admin-card admin-form" action="/api/admin/settings" method="post">
      <input type="hidden" name="redirectTo" value="/admin/models" />
      <ModelPicker
        label="主对话模型"
        hint="用于日常对话与复杂任务，优先选能力强的模型。"
        name="modelMain"
        catalog={catalog}
        purpose="main"
        current={currentMain}
      />
      <ModelPicker
        label="轻量任务模型"
        hint="用于记忆抽取、轮后复盘、插话判断等高频调用，优先选便宜快速的模型。"
        name="modelLight"
        catalog={catalog}
        purpose="light"
        current={currentLight}
      />
      <button className="primary-button" type="submit">
        保存模型路由
      </button>
    </form>
  );
}

function ModelPicker({
  label,
  hint,
  name,
  catalog,
  purpose,
  current,
}: {
  label: string;
  hint: string;
  name: string;
  catalog: ModelCatalogEntry[];
  purpose: "main" | "light";
  current: string;
}) {
  const inCatalog = catalog.some((entry) => entry.id === current);
  const [selected, setSelected] = useState(inCatalog ? current : CUSTOM_VALUE);
  const [customValue, setCustomValue] = useState(inCatalog ? "" : current);
  const isCustom = selected === CUSTOM_VALUE;

  const providers = [...new Set(catalog.map((entry) => entry.provider))];

  return (
    <div className="model-picker">
      <label>
        {label}
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          {providers.map((provider) => (
            <optgroup key={provider} label={provider}>
              {catalog
                .filter((entry) => entry.provider === provider)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                    {entry.recommendedFor.includes(purpose) ? "（推荐）" : ""}
                  </option>
                ))}
            </optgroup>
          ))}
          <option value={CUSTOM_VALUE}>自定义模型 ID…</option>
        </select>
      </label>
      {isCustom ? (
        <label>
          自定义模型 ID
          <input
            value={customValue}
            onChange={(event) => setCustomValue(event.target.value)}
            placeholder="例如 my-provider-model-id"
          />
        </label>
      ) : null}
      <input type="hidden" name={name} value={isCustom ? customValue : selected} />
      <p className="model-picker-hint">{hint}</p>
    </div>
  );
}
