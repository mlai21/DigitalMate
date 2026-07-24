import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const channelSecretsKey = { marker: "test-channel-key" };

const mocks = vi.hoisted(() => ({
  requireCurrentUser: vi.fn(async () => ({ id: USER_ID })),
  exportData: vi.fn(),
  withFreshUserDataLease: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: mocks.requireCurrentUser,
}));

vi.mock("@/server/config/env", () => ({
  readEnv: vi.fn(() => ({
    channelSecretsKey: {
      status: "ready",
      key: channelSecretsKey,
    },
  })),
}));

vi.mock("@/server/admin/user-data-lease", () => ({
  withFreshUserDataLease: mocks.withFreshUserDataLease,
}));

import { GET } from "@/app/api/admin/data/export/route";

describe("admin personal data export route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportData.mockResolvedValue({
      userId: USER_ID,
      exportedAt: "2026-07-25T00:00:00.000Z",
      tables: {},
    });
    mocks.withFreshUserDataLease.mockImplementation(
      async (
        userId: string,
        work: (
          repositories: {
            personalData: {
              export: typeof mocks.exportData;
            };
          },
        ) => Promise<Response>,
      ) => {
        expect(userId).toBe(USER_ID);
        return work({
          personalData: {
            export: mocks.exportData,
          },
        });
      },
    );
  });

  it("exports under the fresh user-data lease with the channel credential key", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="digitalmate-data-${USER_ID}.json"`,
    );
    expect(mocks.exportData).toHaveBeenCalledWith(
      USER_ID,
      channelSecretsKey,
    );
    await expect(response.json()).resolves.toEqual({
      userId: USER_ID,
      exportedAt: "2026-07-25T00:00:00.000Z",
      tables: {},
    });
  });

  it("returns only the stable export failure code", async () => {
    mocks.exportData.mockRejectedValueOnce(
      new Error("SENTINEL_SECRET_MUST_NOT_LEAK"),
    );
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "personal_data_export_failed",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "SENTINEL_SECRET_MUST_NOT_LEAK",
    );
    consoleError.mockRestore();
  });
});
