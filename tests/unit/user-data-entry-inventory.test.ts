import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sharedLeaseMarkers = [
  "withUserDataLease(",
  "withUserDataFence(",
  "acquireUserDataLease(",
  "withFreshUserDataLease(",
] as const;

const apiEntries = [
  "src/app/api/admin/data/export/route.ts",
  "src/app/api/admin/memories/delete/route.ts",
  "src/app/api/admin/memories/update/route.ts",
  "src/app/api/admin/reflections/status/route.ts",
  "src/app/api/admin/settings/route.ts",
  "src/app/api/admin/skills/create/route.ts",
  "src/app/api/admin/skills/import/route.ts",
  "src/app/api/admin/skills/revisions/route.ts",
  "src/app/api/admin/skills/status/route.ts",
  "src/app/api/admin/tool-registrations/create/route.ts",
  "src/app/api/admin/tool-registrations/status/route.ts",
  "src/app/api/chat/attachments/[attachmentId]/download/route.ts",
  "src/app/api/chat/attachments/[attachmentId]/route.ts",
  "src/app/api/chat/attachments/route.ts",
  "src/app/api/chat/route.ts",
  "src/app/api/conversations/[conversationId]/messages/route.ts",
  "src/app/api/conversations/[conversationId]/route.ts",
  "src/app/api/conversations/route.ts",
  "src/app/api/messages/route.ts",
  "src/app/api/projects/[projectId]/route.ts",
  "src/app/api/projects/route.ts",
  "src/app/api/skills/route.ts",
  "src/app/api/tasks/artifacts/[artifactId]/route.ts",
  "src/app/api/tasks/csv/route.ts",
  "src/app/api/tasks/presentation/route.ts",
  "src/app/api/tasks/sandbox/route.ts",
] as const;

const pageEntries = [
  "src/app/page.tsx",
  "src/app/admin-legacy/page.tsx",
  "src/app/admin-legacy/conversations/page.tsx",
  "src/app/admin-legacy/conversations/[conversationId]/page.tsx",
  "src/app/admin-legacy/interjections/page.tsx",
  "src/app/admin-legacy/memories/page.tsx",
  "src/app/admin-legacy/models/page.tsx",
  "src/app/admin-legacy/reflections/page.tsx",
  "src/app/admin-legacy/reminders/page.tsx",
  "src/app/admin-legacy/settings/page.tsx",
  "src/app/admin-legacy/skills/page.tsx",
  "src/app/admin-legacy/tasks/page.tsx",
  "src/app/admin-legacy/tool-registrations/page.tsx",
  "src/app/admin-legacy/tools/page.tsx",
  "src/app/admin-legacy/usage/page.tsx",
] as const;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function holdsSharedLease(path: string): boolean {
  const contents = source(path);
  return sharedLeaseMarkers.some((marker) => contents.includes(marker));
}

describe("user data entry inventory", () => {
  it.each([...apiEntries, ...pageEntries])("%s acquires a shared lease", (path) => {
    expect(holdsSharedLease(path)).toBe(true);
  });

  it("holds one shared lease around the complete channel dispatch", () => {
    expect(
      holdsSharedLease(
        "src/server/channels/runtime/start.ts",
      ),
    ).toBe(true);
    expect(
      holdsSharedLease(
        "src/server/channels/adapters/webhook/route-runtime.ts",
      ),
    ).toBe(true);
  });

  it("holds shared leases around agent startup, each tick, and attachment cleanup scope", () => {
    const contents = source("src/agent-service/index.ts");
    expect(contents.match(/withUserDataLease\(/g)).toHaveLength(3);
    expect(contents).toContain("cleanupStaleTaskArtifacts({");
  });

  it("uses the exclusive clear lease only at the personal-data clear boundary", () => {
    const clearRoute = source("src/app/api/admin/data/clear/route.ts");
    expect(clearRoute).toContain("acquireExclusiveClearLease(");
    expect(clearRoute).not.toContain("acquireSharedLease(");
  });

  it("uses a single non-blocking shared lock only for webhook admission", () => {
    const repositories = source("src/server/db/repositories.ts");
    expect(repositories.match(/pg_try_advisory_lock_shared/g)).toHaveLength(1);
    expect(repositories).not.toContain("pg_try_advisory_lock(");
  });
});
