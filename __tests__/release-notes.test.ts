import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const releaseItBin = join(dirname(require.resolve("release-it/package.json")), "bin/release-it.js");
const releaseConfig = fileURLToPath(new URL("../.release-it.json", import.meta.url));
const initialCommit = "chore: create package";
const fixes = ["fix: before first beta", "fix: between betas", "fix: after second beta"];
const betaCommits = ["chore: release v1.1.0-beta.0", "chore: release v1.1.0-beta.1"];

async function withReleaseHistory(
  options: { stableTag?: boolean; currentVersion?: string },
  run: (repository: { changelog: (...args: string[]) => Promise<string[]> }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "openapi-release-notes-"));
  const manifest = join(directory, "package.json");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  const git = (...args: string[]) =>
    execFileAsync("git", args, { cwd: directory, env, timeout: 10_000 });
  const commit = async (subject: string, version?: string) => {
    if (version) {
      await writeFile(manifest, JSON.stringify({ name: "release-notes-fixture", version }));
    }
    await writeFile(join(directory, "change.txt"), subject);
    await git("add", ".");
    await git("commit", "-m", subject);
  };

  try {
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Release Notes Test");
    await git("config", "user.email", "release-notes@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await git("config", "tag.gpgsign", "false");
    await commit(initialCommit, "1.0.0");
    if (options.stableTag !== false) await git("tag", "v1.0.0");
    await commit(fixes[0]);
    await commit(betaCommits[0], "1.1.0-beta.0");
    await git("tag", "v1.1.0-beta.0");
    await commit(fixes[1]);
    await commit(betaCommits[1], "1.1.0-beta.1");
    await git("tag", "v1.1.0-beta.1");
    await commit(fixes[2], options.currentVersion ?? "1.1.0");

    await run({
      async changelog(...args) {
        const before = await git("show-ref", "--head");
        const packageBefore = await readFile(manifest, "utf8");
        // --changelog exits before bump/release hooks. Disable publishing and remote
        // requirements as well; this repository has no remotes and allows only file transport.
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            releaseItBin,
            "--config",
            releaseConfig,
            "--changelog",
            "--no-git.push",
            "--no-git.requireUpstream",
            "--no-npm.publish",
            "--no-github",
            "--no-gitlab",
            ...args,
          ],
          { cwd: directory, env, timeout: 15_000 },
        );
        expect((await git("show-ref", "--head")).stdout).toBe(before.stdout);
        expect((await git("status", "--porcelain")).stdout).toBe("");
        expect(await readFile(manifest, "utf8")).toBe(packageBefore);
        return stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("* "))
          .map((line) => line.replace(/^\* (.*) \([0-9a-f]+\)$/, "$1"));
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("release notes across beta releases", () => {
  test.each([
    { name: "incremented stable release", args: [] },
    { name: "current untagged version with --no-increment", args: ["--no-increment"] },
  ])(
    "$name includes every change since the previous stable release",
    async ({ args }) => {
      await withReleaseHistory({}, async ({ changelog }) => {
        expect(await changelog(...args)).toEqual([
          fixes[2],
          betaCommits[1],
          fixes[1],
          betaCommits[0],
          fixes[0],
        ]);
      });
    },
    30_000,
  );

  test("next-channel beta notes include only changes after the latest beta", async () => {
    await withReleaseHistory({ currentVersion: "1.1.0-beta.1" }, async ({ changelog }) => {
      expect(await changelog("--preRelease=beta", "--npm.tag=next", "--git.tagExclude=")).toEqual([
        fixes[2],
      ]);
    });
  }, 30_000);

  test("the first stable release includes the entire history even when beta tags exist", async () => {
    await withReleaseHistory({ stableTag: false }, async ({ changelog }) => {
      expect(await changelog()).toEqual([
        fixes[2],
        betaCommits[1],
        fixes[1],
        betaCommits[0],
        fixes[0],
        initialCommit,
      ]);
    });
  }, 30_000);
});
