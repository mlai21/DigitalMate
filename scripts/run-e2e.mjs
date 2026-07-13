import { spawnSync } from "node:child_process";

const inputArgs = process.argv.slice(2);
const dryRun = inputArgs.includes("--dry-run");
const forwardedArgs = inputArgs.filter((arg) => arg !== "--dry-run");
const plan = createPlan(forwardedArgs);

if (dryRun) {
  process.stdout.write(JSON.stringify(plan));
} else {
  for (const step of plan) {
    const script = step.suite === "app" ? "test:e2e:app" : "test:e2e:scroll";
    const result = spawnSync("npm", ["run", script, "--", ...step.args], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

function createPlan(args) {
  const specFiles = args.filter(isSpecFile);
  const sharedArgs = args.filter((arg) => !isSpecFile(arg));
  if (specFiles.length === 0) {
    return [
      { suite: "app", args: sharedArgs },
      { suite: "scroll", args: sharedArgs },
    ];
  }

  const appFiles = specFiles.filter((file) => !isScrollSpec(file));
  const scrollFiles = specFiles.filter(isScrollSpec);
  return [
    ...(appFiles.length > 0 ? [{ suite: "app", args: [...sharedArgs, ...appFiles] }] : []),
    ...(scrollFiles.length > 0 ? [{ suite: "scroll", args: [...sharedArgs, ...scrollFiles] }] : []),
  ];
}

function isSpecFile(arg) {
  return /\.spec\.[cm]?[jt]sx?$/.test(arg);
}

function isScrollSpec(file) {
  return /(^|[/\\])chat-scroll\.spec\.[cm]?[jt]sx?$/.test(file);
}
