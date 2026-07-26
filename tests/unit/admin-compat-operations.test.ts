import { describe, expect, it, vi } from "vitest";

import type { AdminCompatContext } from "@/server/admin/compat/types";
import {
  createGetAgentHealthHandler,
  createGetAgentStatsHandler,
  createGetBackendDebugLogsHandler,
  createGetEnvironmentHandler,
  createGetTokenUsageDetailsHandler,
  createGetTokenUsageHandler,
  createGetVoiceOverviewHandler,
  type AdminOperationsService,
} from "@/server/admin/compat/handlers/operations";
import {
  createGetSecurityOverviewHandler,
  type AdminSecurityService,
} from "@/server/admin/views/security";
import { UPSTREAM_API_CONTRACT } from "@/server/admin/compat/upstream-contract";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

describe("admin compatibility operations", () => {
  it("Stats 与 Token Usage 读取严格校验日期并按当前分身查询", async () => {
    const getAgentStats = vi
      .fn<AdminOperationsService["getAgentStats"]>()
      .mockResolvedValue({
        total_active_sessions: 1,
        total_messages: 2,
        total_user_messages: 1,
        total_assistant_messages: 1,
        total_prompt_tokens: 10,
        total_completion_tokens: 5,
        total_llm_calls: 1,
        total_tool_calls: 0,
        by_date: [],
        channel_stats: [],
        start_date: "2026-07-01",
        end_date: "2026-07-27",
      });
    const service = {
      getAgentStats,
      getTokenUsage: vi.fn().mockResolvedValue({
        total_prompt_tokens: 10,
        total_completion_tokens: 5,
        total_calls: 1,
        by_model: {},
        by_date: {},
      }),
      getTokenUsageDetails: vi.fn().mockResolvedValue([]),
    } as unknown as AdminOperationsService;

    await createGetAgentStatsHandler(service)(
      context(
        "GET",
        "/agent-stats?start_date=2026-07-01&end_date=2026-07-27",
      ),
    );
    expect(getAgentStats).toHaveBeenCalledWith(
      scope,
      {
        startDate: "2026-07-01",
        endDate: "2026-07-27",
      },
      expect.any(AbortSignal),
    );
    await expect(
      createGetTokenUsageHandler(service)(
        context(
          "GET",
          "/token-usage?start_date=2026-07-28&end_date=2026-07-01",
        ),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_date_range",
    });
    await expect(
      createGetTokenUsageDetailsHandler(service)(
        context(
          "GET",
          "/token-usage/details?start_date=2026-07-01&end_date=2026-07-27&provider=anthropic&model=claude-opus-4-8",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("Environment、Agent Health 与 Voice 只返回状态，不返回 env 或凭据值", async () => {
    const service = {
      getEnvironment: vi.fn().mockResolvedValue([
        { key: "web", value: "healthy · 0.1.0" },
        { key: "channel-node", value: "connected · 0.1.0" },
      ]),
      getAgentHealth: vi.fn().mockResolvedValue({
        status: "healthy",
        services: {
          web: "healthy",
          agent: "healthy",
          channel_nodes: "connected",
        },
      }),
      getVoiceOverview: vi.fn().mockResolvedValue({
        connections: [
          {
            type: "voice",
            enabled: true,
            health: "connected",
            revision: 3,
            stt_provider: "deepgram",
            secrets: {
              twilio_auth_token: { configured: true },
            },
          },
        ],
      }),
    } as unknown as AdminOperationsService;

    const environment =
      await createGetEnvironmentHandler(service)(
        context("GET", "/envs"),
      );
    const health = await createGetAgentHealthHandler(service)(
      context("GET", "/agent/health"),
    );
    const voice = await createGetVoiceOverviewHandler(service)(
      context("GET", "/voice/overview"),
    );

    expect({ environment, health, voice }).toMatchObject({
      environment: expect.any(Array),
      health: { status: "healthy" },
      voice: {
        connections: [
          expect.objectContaining({
            type: "voice",
            revision: 3,
          }),
        ],
      },
    });
    expect(
      JSON.stringify({ environment, health, voice }),
    ).not.toMatch(
      /DATABASE_URL|APP_SECRET|CHANNEL_SECRETS_KEY|twilio-secret|ciphertext|nonce|storage_key/iu,
    );
  });

  it("上游 Voice 读取保持原字段形状，同时明确关闭聊天音频转写", async () => {
    const service = {
      getVoiceOverview: vi.fn().mockResolvedValue({
        connections: [],
        chat_audio_transcription: {
          enabled: false,
        },
      }),
    } as unknown as AdminOperationsService;

    const {
      createGetAudioModeHandler,
      createGetLocalWhisperStatusHandler,
      createGetTranscriptionProvidersHandler,
      createGetTranscriptionProviderTypeHandler,
    } = await import(
      "@/server/admin/compat/handlers/operations"
    );

    await expect(
      createGetAudioModeHandler(service)(
        context("GET", "/workspace/audio-mode"),
      ),
    ).resolves.toMatchObject({ audio_mode: "auto" });
    await expect(
      createGetTranscriptionProvidersHandler(service)(
        context(
          "GET",
          "/workspace/transcription-providers",
        ),
      ),
    ).resolves.toMatchObject({
      providers: [],
      configured_provider_id: "",
    });
    await expect(
      createGetTranscriptionProviderTypeHandler(service)(
        context(
          "GET",
          "/workspace/transcription-provider-type",
        ),
      ),
    ).resolves.toEqual({
      transcription_provider_type: "disabled",
      enabled: false,
      reason: "audio_attachment_not_supported",
    });
    await expect(
      createGetLocalWhisperStatusHandler(service)(
        context(
          "GET",
          "/workspace/local-whisper-status",
        ),
      ),
    ).resolves.toMatchObject({
      available: false,
      ffmpeg_installed: false,
      whisper_installed: false,
    });
  });

  it("Debug 只返回脱敏事件，不回传原始提示、载荷、正文或存储路径", async () => {
    const getDebugLogs = vi
      .fn<AdminOperationsService["getDebugLogs"]>()
      .mockResolvedValue({
        path: "database://diagnostics",
        exists: true,
        lines: 2,
        updated_at: 1_785_105_600,
        size: 120,
        content: [
          '{"kind":"audit","action":"skill.enable","status":"success"}',
          '{"kind":"delivery","status":"dead_letter","error_code":"timeout"}',
        ].join("\n"),
        next_cursor: null,
        retention_days: 30,
      });
    const result =
      await createGetBackendDebugLogsHandler({
        getDebugLogs,
      } as unknown as AdminOperationsService)(
        context(
          "GET",
          "/console/debug/backend-logs?lines=200",
        ),
      );

    expect(result).toMatchObject({
      path: "database://diagnostics",
      exists: true,
      lines: 2,
      retention_days: 30,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /system prompt|raw_payload|normalized_payload|input_summary|output_summary|ciphertext|nonce|storage_key|Bearer /iu,
    );
  });

  it("Security overview 只投影权限、审计、证书与密钥状态", async () => {
    const result =
      await createGetSecurityOverviewHandler({
        getOverview: vi.fn().mockResolvedValue({
          channels: [],
          grants: [],
          tools: [],
          audits: [
            {
              action: "channel_connection.update",
              status: "success",
              created_at: "2026-07-27T00:00:00.000Z",
            },
          ],
          runtime_nodes: [
            {
              name: "Mac Node",
              status: "connected",
              certificate: {
                configured: true,
                expires_at: "2026-08-27T00:00:00.000Z",
              },
            },
          ],
        }),
      } as unknown as AdminSecurityService)(
        context("GET", "/security/overview"),
      );

    expect(result).toMatchObject({
      audits: [
        expect.objectContaining({
          action: "channel_connection.update",
        }),
      ],
      runtime_nodes: [
        expect.objectContaining({
          certificate: expect.objectContaining({
            configured: true,
          }),
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /before_summary|after_summary|confirmation_source|fingerprint|certificate_fingerprint|secret|token|password/iu,
    );
  });

  it("运维读取 mapped，环境/安全写入和音频执行保持准确禁用", () => {
    expect(endpoint("agentStats", "GET /agent-stats"))
      .toMatchObject({ status: "mapped" });
    expect(endpoint("tokenUsage", "GET /token-usage"))
      .toMatchObject({ status: "mapped" });
    expect(endpoint("env", "GET /envs"))
      .toMatchObject({ status: "mapped" });
    expect(endpoint("env", "PUT /envs")).toMatchObject({
      status: "disabled",
      disabledCode: "environment_mutation",
    });
    expect(
      endpoint("debug", "GET /console/debug/backend-logs"),
    ).toMatchObject({ status: "mapped" });
    expect(
      endpoint("security", "GET /config/security/tool-guard"),
    ).toMatchObject({ status: "mapped" });
    expect(
      endpoint("agent", "POST /workspace/transcribe"),
    ).toMatchObject({
      status: "disabled",
      disabledCode: "voice_transcription_execution",
    });
  });
});

function context(
  method: string,
  path: string,
): AdminCompatContext {
  return {
    request: new Request(
      `https://mate.example/api/admin/compat${path}`,
      { method },
    ),
    params: {},
    scope,
    csrfVerified: method === "GET",
    resources: {} as AdminCompatContext["resources"],
    signal: new AbortController().signal,
  };
}

function endpoint(
  module:
    | "agent"
    | "agentStats"
    | "debug"
    | "env"
    | "security"
    | "tokenUsage",
  key: string,
) {
  const result =
    UPSTREAM_API_CONTRACT[module].endpoints.find(
      (candidate) =>
        `${candidate.method} ${candidate.path}` === key,
    );
  expect(result).toBeDefined();
  return result;
}
