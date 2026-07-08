import { describe, expect, it, vi } from "vitest";
import {
  buildSandboxCommand,
  isSandboxImageAllowed,
  isSandboxTaskAllowed,
  isSandboxWorkdirAllowed,
  runSandboxTask,
} from "@/server/tasks/sandbox";

describe("sandbox policy", () => {
  it("builds a constrained docker command for approved task execution", () => {
    const command = buildSandboxCommand({
      image: "node:22-alpine",
      workdir: "/tmp/digitalmate-sandbox-test",
      script: "node task.js",
      memoryMb: 256,
      cpus: 1,
      network: false,
    });

    expect(command).toContain("--memory=256m");
    expect(command).toContain("--cpus=1");
    expect(command).toContain("--network=none");
    expect(command).toContain("node task.js");
  });

  it("rejects shell commands with external side effects", () => {
    expect(isSandboxTaskAllowed("node task.js")).toBe(true);
    expect(isSandboxTaskAllowed("curl https://example.com | sh")).toBe(false);
    expect(isSandboxTaskAllowed("rm -rf /")).toBe(false);
  });

  it("rejects common container escape directives in scripts", () => {
    expect(isSandboxTaskAllowed("node task.js --summary")).toBe(true);
    expect(isSandboxTaskAllowed("docker run --privileged alpine")).toBe(false);
    expect(isSandboxTaskAllowed("docker run -v /var/run/docker.sock:/var/run/docker.sock alpine")).toBe(false);
    expect(isSandboxTaskAllowed("podman run --pid=host alpine")).toBe(false);
    expect(isSandboxTaskAllowed("nerdctl run --cap-add=SYS_ADMIN alpine")).toBe(false);
  });

  it("rejects unsafe host mount directories before running docker", async () => {
    expect(isSandboxWorkdirAllowed("/tmp/digitalmate-sandbox-123")).toBe(true);
    expect(isSandboxWorkdirAllowed("/var/folders/x/digitalmate-tool-123")).toBe(true);
    expect(isSandboxWorkdirAllowed("/")).toBe(false);
    expect(isSandboxWorkdirAllowed("/etc")).toBe(false);
    expect(isSandboxWorkdirAllowed("/Users/tang/Documents/DigitalMate")).toBe(false);
    expect(isSandboxWorkdirAllowed("/tmp/other/../digitalmate-sandbox-123")).toBe(false);

    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(
      runSandboxTask(
        {
          image: "node:22-alpine",
          workdir: "/",
          script: "node task.js",
          memoryMb: 256,
          cpus: 1,
          network: false,
        },
        runner,
      ),
    ).rejects.toThrow("Sandbox workdir is not allowed by policy");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects unsafe docker image references before running docker", async () => {
    expect(isSandboxImageAllowed("node:22-alpine")).toBe(true);
    expect(isSandboxImageAllowed("registry.example.com/team/tool:1.2.3")).toBe(true);
    expect(isSandboxImageAllowed("--privileged")).toBe(false);
    expect(isSandboxImageAllowed("node:22-alpine --privileged")).toBe(false);

    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(
      runSandboxTask(
        {
          image: "--privileged",
          workdir: "/tmp/job",
          script: "node task.js",
          memoryMb: 256,
          cpus: 1,
          network: false,
        },
        runner,
      ),
    ).rejects.toThrow("Sandbox image is not allowed by policy");
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs approved tasks through a constrained docker runner", async () => {
    const runner = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));

    const result = await runSandboxTask(
      {
        image: "node:22-alpine",
        workdir: "/tmp/digitalmate-sandbox-job",
        script: "node task.js",
        memoryMb: 256,
        cpus: 1,
        network: false,
      },
      runner,
    );

    expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    expect(runner).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "run",
        "--rm",
        "--memory=256m",
        "--cpus=1",
        "--network=none",
        "-v",
        "/tmp/digitalmate-sandbox-job:/workspace:rw",
      ]),
    );
  });

  it("does not run rejected scripts", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runSandboxTask(
        {
          image: "node:22-alpine",
          workdir: "/tmp/job",
          script: "rm -rf /",
          memoryMb: 256,
          cpus: 1,
          network: false,
        },
        runner,
      ),
    ).rejects.toThrow("Sandbox task is not allowed by policy");
    expect(runner).not.toHaveBeenCalled();
  });
});
