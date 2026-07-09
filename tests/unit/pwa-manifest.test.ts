import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import manifest from "@/app/manifest";

describe("PWA manifest", () => {
  it("describes DigitalMate as an installable mobile app shell", () => {
    const data = manifest();

    expect(data.name).toBe("DigitalMate");
    expect(data.start_url).toBe("/");
    expect(data.display).toBe("standalone");
    expect(data.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          src: "/digitalmate-icon.png",
          purpose: "maskable",
        }),
      ]),
    );
  });

  it("ships a service worker for the installable shell", async () => {
    const worker = await readFile(path.join(process.cwd(), "public/service-worker.js"), "utf8");

    expect(worker).toContain("digitalmate-v2");
    expect(worker).toContain('self.addEventListener("install"');
    expect(worker).toContain('self.addEventListener("fetch"');
  });
});
