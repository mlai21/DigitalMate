import { describe, expect, it, vi } from "vitest";

import type { AdminCompatContext } from "@/server/admin/compat/types";
import {
  createGetActiveModelsHandler,
  createListModelsHandler,
  createUpdateActiveModelsHandler,
  projectModelProviders,
  type AdminModelsService,
} from "@/server/admin/compat/handlers/models";
import { UPSTREAM_API_CONTRACT } from "@/server/admin/compat/upstream-contract";
import { MODEL_CATALOG } from "@/server/llm/catalog";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

describe("admin compatibility models", () => {
  it("模型目录来自现有 catalog，凭据只返回配置状态", () => {
    const providers = projectModelProviders(
      MODEL_CATALOG,
      true,
    );

    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "anthropic",
          credential_status: "configured",
          models: expect.arrayContaining([
            expect.objectContaining({
              id: "claude-opus-4-8",
            }),
          ]),
        }),
        expect.objectContaining({
          id: "google",
        }),
        expect.objectContaining({
          id: "openai",
        }),
      ]),
    );
    expect(JSON.stringify(providers)).not.toMatch(
      /sk-super-secret|Bearer |https?:\/\/[^"]*@/iu,
    );
  });

  it("读取有效用途路由时保留 main/light、scope 与 revision", async () => {
    const getActiveModels = vi
      .fn<AdminModelsService["getActiveModels"]>()
      .mockResolvedValue({
        scope: "effective",
        routes: {
          main: "claude-opus-4-8",
          light: "gemini-3-5-flash-openai",
        },
        revision: 7,
        active_llm: {
          provider_id: "anthropic",
          model: "claude-opus-4-8",
        },
        effective_max_input_length: null,
      });
    const handler = createGetActiveModelsHandler({
      getActiveModels,
    } as unknown as AdminModelsService);

    const result = await handler(
      context(
        "GET",
        "/models/active?scope=effective",
      ),
    );

    expect(result).toMatchObject({
      routes: {
        main: "claude-opus-4-8",
        light: "gemini-3-5-flash-openai",
      },
      revision: 7,
    });
    expect(getActiveModels).toHaveBeenCalledWith(
      scope,
      {
        scope: "effective",
        agentId: undefined,
      },
      expect.any(AbortSignal),
    );
  });

  it("用途路由写入必须携带 revision 和操作 ID，并校验 provider shape", async () => {
    const updateActiveModel = vi
      .fn<AdminModelsService["updateActiveModel"]>()
      .mockResolvedValue({
        scope: "agent",
        routes: {
          main: "claude-opus-4-8",
          light: "gemini-3-5-flash-openai",
        },
        revision: 8,
        active_llm: {
          provider_id: "anthropic",
          model: "claude-opus-4-8",
        },
        effective_max_input_length: null,
      });
    const handler = createUpdateActiveModelsHandler({
      updateActiveModel,
    } as unknown as AdminModelsService);
    const operationId =
      "10000000-0000-4000-8000-000000000099";

    await expect(
      handler(
        context("PUT", "/models/active", {
          provider_id: "google",
          model: "claude-opus-4-8",
          purpose: "main",
          scope: "agent",
          agent_id: scope.agentId,
          revision: 7,
          operation_id: operationId,
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_model_provider",
    });

    await handler(
      context("PUT", "/models/active", {
        provider_id: "anthropic",
        model: "claude-opus-4-8",
        purpose: "main",
        scope: "agent",
        agent_id: scope.agentId,
        revision: 7,
        operation_id: operationId,
      }),
    );
    expect(updateActiveModel).toHaveBeenCalledWith(
      scope,
      {
        providerId: "anthropic",
        model: "claude-opus-4-8",
        purpose: "main",
        scope: "agent",
        agentId: scope.agentId,
        expectedRevision: 7,
        operationId,
      },
      expect.any(AbortSignal),
    );
  });

  it("模型读取与用途路由 mapped，凭据和本地模型管理准确禁用", async () => {
    const listProviders = vi
      .fn<AdminModelsService["listProviders"]>()
      .mockResolvedValue([]);
    await expect(
      createListModelsHandler({
        listProviders,
      } as unknown as AdminModelsService)(
        context("GET", "/models"),
      ),
    ).resolves.toEqual([]);

    expect(endpoint("GET /models")).toMatchObject({
      status: "mapped",
    });
    expect(endpoint("GET /models/active")).toMatchObject({
      status: "mapped",
    });
    expect(endpoint("PUT /models/active")).toMatchObject({
      status: "mapped",
    });
    expect(
      endpoint("PUT /models/:providerId/config"),
    ).toMatchObject({
      status: "disabled",
      disabledCode: "model_provider_credentials",
    });
    expect(
      UPSTREAM_API_CONTRACT.localModel.endpoints[0],
    ).toMatchObject({
      status: "disabled",
      disabledCode: "local_models",
    });
  });
});

function context(
  method: string,
  path: string,
  body?: unknown,
): AdminCompatContext {
  return {
    request: new Request(
      `https://mate.example/api/admin/compat${path}`,
      {
        method,
        headers:
          body === undefined
            ? undefined
            : { "content-type": "application/json" },
        body:
          body === undefined
            ? undefined
            : JSON.stringify(body),
      },
    ),
    params: {},
    scope,
    csrfVerified: method !== "GET",
    resources: {} as AdminCompatContext["resources"],
    signal: new AbortController().signal,
  };
}

function endpoint(path: string) {
  const result =
    UPSTREAM_API_CONTRACT.provider.endpoints.find(
      (candidate) =>
        `${candidate.method} ${candidate.path}` === path,
    );
  expect(result).toBeDefined();
  return result;
}
