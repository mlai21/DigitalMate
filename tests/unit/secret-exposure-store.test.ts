import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_USER_SECRET_EXPOSURE_FINGERPRINTS,
  readSecretExposureFingerprints,
} from "@/server/admin/secret-exposure-store";

const USER_ID = "10000000-0000-4000-8000-000000000001";

describe("user credential exposure history reads", () => {
  it("rejects an oversized history after COUNT and before fetching rows", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("count(*)")) {
        return {
          rows: [{
            count:
              String(MAX_USER_SECRET_EXPOSURE_FINGERPRINTS + 1),
          }],
        };
      }
      throw new Error("fingerprint_rows_must_not_be_fetched");
    });

    await expect(readSecretExposureFingerprints(
      { query } as unknown as PoolClient,
      USER_ID,
    )).rejects.toThrow("channel_secret_exposure_limit_exceeded");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reads an allowed history in stable batches of at most 256", async () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      key_version: 1,
      digest: Buffer.alloc(32, index % 255),
      utf8_bytes: 16,
      character_length: 16,
    }));
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("count(*)")) {
        return { rows: [{ count: "300" }] };
      }
      const offset = Number(text.match(/OFFSET (\d+)/)?.[1] ?? 0);
      return { rows: rows.slice(offset, offset + 256) };
    });

    await expect(readSecretExposureFingerprints(
      { query } as unknown as PoolClient,
      USER_ID,
    )).resolves.toHaveLength(300);
    const fetches = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => !sql.includes("count(*)"));
    expect(fetches).toHaveLength(2);
    expect(fetches.every((sql) => sql.includes("LIMIT 256"))).toBe(
      true,
    );
    expect(fetches[0]).toContain(
      "ORDER BY key_version ASC, digest ASC",
    );
    expect(fetches[0]).toContain("OFFSET 0");
    expect(fetches[1]).toContain("OFFSET 256");
  });
});
