import type { SourceReferenceContext } from "write-once";

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearGitHubCaches, prepareGitHubFile } from "@/github-api";
import { githubPlugin } from "@/index";
import { parseGitHubReference } from "@/reference";
import { getRepositoryUrl } from "@/repository-url";

let temporary: string | undefined;

function git(args: string[], cwd?: string): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository() {
  temporary = await mkdtemp(join(tmpdir(), "write-once-github-test-"));
  const remoteRoot = join(temporary, "remotes");
  const remote = join(remoteRoot, "owner", "repo.git");
  const working = join(temporary, "source");
  await mkdir(join(remoteRoot, "owner"), { recursive: true });
  git(["init", "--bare", "--initial-branch=main", remote]);
  git(["init", "--initial-branch=main", working]);
  git(["config", "user.name", "Test"], working);
  git(["config", "user.email", "test@example.com"], working);
  await mkdir(join(working, "src"), { recursive: true });
  await mkdir(join(working, "docs"), { recursive: true });
  await writeFile(join(working, "src", "index.ts"), "export const value = 'main';\n");
  await writeFile(join(working, "docs", "guide.md"), "main guide\n");
  await symlink("src/index.ts", join(working, "linked.ts"));
  git(["add", "."], working);
  git(["commit", "-m", "initial"], working);
  const mainCommit = git(["rev-parse", "HEAD"], working);
  git(["tag", "v1.0.0"], working);
  git(["tag", "-a", "v2.0.0", "-m", "annotated release", "main"], working);
  git(["checkout", "-b", "feature/nested", "main"], working);
  git(["push", remote, "feature/nested"], working);
  git(["checkout", "-b", "develop"], working);
  await writeFile(join(working, "src", "index.ts"), "export const value = 'develop';\n");
  git(["commit", "-am", "develop"], working);
  git(["push", remote, "main", "develop", "--tags"], working);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);
  vi.stubEnv("GITHUB_GIT_BASE_URL", `file://${remoteRoot}`);
  vi.stubEnv("GITHUB_GIT_PROTOCOL", "https");
  return { working, remote, remoteRoot, mainCommit, root: join(temporary, "plugin-work") };
}

afterEach(async () => {
  clearGitHubCaches();
  vi.unstubAllEnvs();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

function sourceReference(source: string, destination: string): SourceReferenceContext {
  const location = {
    resource: destination,
    start: { line: 1, column: 1 },
    end: { line: 1, column: 1 },
  };
  const token = {
    raw: "",
    attributes: { source },
    span: { start: 0, end: 0 },
    lineSpan: { start: 0, end: 0 },
    location,
  };
  return {
    source,
    destination,
    selector: { kind: "whole" },
    marker: {
      opening: { ...token, kind: "open" },
      closing: { ...token, kind: "close" },
      span: { start: 0, end: 0 },
      bodySpan: { start: 0, end: 0 },
    },
  };
}

describe("getRepositoryUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses HTTPS by default and supports configured SSH", () => {
    expect(getRepositoryUrl({ owner: "owner", repository: "repo", path: "README.md" })).toBe(
      "https://github.com/owner/repo.git",
    );
    vi.stubEnv("GITHUB_GIT_PROTOCOL", "ssh");
    expect(getRepositoryUrl({ owner: "owner", repository: "repo", path: "README.md" })).toBe(
      "git@github.com:owner/repo.git",
    );
  });

  it("allows a custom Git remote base URL for testing and GitHub Enterprise", () => {
    vi.stubEnv("GITHUB_GIT_BASE_URL", "https://github.example.test/");
    expect(getRepositoryUrl({ owner: "owner", repository: "repo", path: "README.md" })).toBe(
      "https://github.example.test/owner/repo.git",
    );
  });
});

describe("prepareGitHubFile", () => {
  it("materializes the default branch and returns a path inside the checkout", async () => {
    const setup = await createRepository();
    const result = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo/src/index.ts"),
      setup.root,
    );
    expect(result.root).toBe(join(setup.root, "owner", "repo", "branch-main"));
    expect(result.resolved).toMatchObject({
      ref: "main",
      commit: setup.mainCommit,
      path: "src/index.ts",
    });
    expect(await readFile(join(result.root, result.path), "utf8")).toBe(
      "export const value = 'main';\n",
    );
  });

  it("resolves branch names containing slashes and keeps states in separate checkouts", async () => {
    const setup = await createRepository();
    const main = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo/src/index.ts"),
      setup.root,
    );
    const develop = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo@develop/src/index.ts"),
      setup.root,
    );
    const nested = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo@feature/nested/src/index.ts"),
      setup.root,
    );
    const tag = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo@v1.0.0/src/index.ts"),
      setup.root,
    );
    const annotatedTag = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo@v2.0.0/src/index.ts"),
      setup.root,
    );
    const commit = await prepareGitHubFile(
      parseGitHubReference(`repo:owner/repo@${setup.mainCommit}/src/index.ts`),
      setup.root,
    );

    expect(develop.root).toContain("branch-develop");
    expect(nested.resolved.ref).toBe("feature/nested");
    expect(nested.path).toBe("src/index.ts");
    expect(tag.root).toContain("tag-v1.0.0");
    expect(commit.root).toContain(`commit-${setup.mainCommit}`);
    expect(
      new Set([main.root, develop.root, nested.root, tag.root, annotatedTag.root, commit.root])
        .size,
    ).toBe(6);
    expect(await readFile(join(develop.root, develop.path), "utf8")).toContain("develop");
    expect(await readFile(join(tag.root, tag.path), "utf8")).toContain("main");
    expect(annotatedTag.resolved.commit).toBe(setup.mainCommit);
    expect(await readFile(join(annotatedTag.root, annotatedTag.path), "utf8")).toContain("main");
  });

  it("shares a checkout for multiple files in the same repository state", async () => {
    const setup = await createRepository();
    const first = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo/src/index.ts"),
      setup.root,
    );
    clearGitHubCaches();
    const second = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo/docs/guide.md"),
      setup.root,
    );
    expect(second.root).toBe(first.root);
    expect(second.path).toBe("docs/guide.md");
    expect(await readFile(join(second.root, second.path), "utf8")).toBe("main guide\n");
  });

  it("refreshes a branch checkout when the remote commit changes", async () => {
    const setup = await createRepository();
    const reference = parseGitHubReference("repo:owner/repo/src/index.ts");
    const first = await prepareGitHubFile(reference, setup.root);
    git(["checkout", "main"], setup.working);
    await writeFile(join(setup.working, "src", "index.ts"), "export const value = 'updated';\n");
    git(["commit", "-am", "updated"], setup.working);
    git(["push", setup.remote, "main"], setup.working);
    clearGitHubCaches();
    const second = await prepareGitHubFile(reference, setup.root);
    expect(second.root).toBe(first.root);
    expect(second.resolved.commit).not.toBe(first.resolved.commit);
    expect(await readFile(join(second.root, second.path), "utf8")).toContain("updated");
  });

  it("integrates with Write Once by resolving files inside shared repository checkouts", async () => {
    const setup = await createRepository();
    const plugin = githubPlugin();
    const preparer = plugin.preparers![0]!;
    const resolver = plugin.resolvers![0]!;
    expect(plugin.extractors).toBeUndefined();
    expect(
      preparer.canPrepare(sourceReference("./local.ts", "README.md"), { cwd: setup.root }),
    ).toBe(false);
    const firstSource = "repo:owner/repo/src/index.ts";
    const secondSource = "repo:owner/repo/docs/guide.md";
    const references = [
      sourceReference(firstSource, "README.md"),
      sourceReference(secondSource, "docs.md"),
    ];
    const result = await preparer.prepare(references, {
      cwd: setup.root,
      workingDirectory: setup.root,
    });
    expect(result.resources).toHaveLength(1);
    const preparation = { preparerId: "write-once-github", workingDirectory: setup.root, result };
    expect(resolver.canResolve("./local.ts", { cwd: setup.root })).toBe(false);
    expect(
      resolver.canResolve(firstSource, {
        cwd: setup.root,
        preparation: { ...preparation, preparerId: "other" },
      }),
    ).toBe(false);
    expect(() => resolver.resolve(firstSource, { cwd: setup.root })).toThrow(
      "No GitHub preparation was assigned",
    );
    expect(() =>
      resolver.resolve(firstSource, {
        cwd: setup.root,
        preparation: {
          ...preparation,
          result: { resources: [], metadata: { files: { [firstSource]: { root: 42 } } } },
        },
      }),
    ).toThrow("was not included in the assigned preparation batch");
    expect(() =>
      resolver.resolve(firstSource, {
        cwd: setup.root,
        preparation: { ...preparation, result: { resources: [] } },
      }),
    ).toThrow("was not included in the assigned preparation batch");
    const first = await resolver.resolve(firstSource, { cwd: setup.root, preparation });
    const second = await resolver.resolve(secondSource, { cwd: setup.root, preparation });
    expect(first.root).toBe(second.root);
    expect(first.path).toBe("src/index.ts");
    expect(second.path).toBe("docs/guide.md");
    expect(await readFile(join(first.root, first.path), "utf8")).toContain("main");
  });

  it("reuses a clean checkout and accepts an HTTPS token", async () => {
    const setup = await createRepository();
    const reference = parseGitHubReference("repo:owner/repo/src/index.ts");
    const first = await prepareGitHubFile(reference, setup.root, "test-token");
    clearGitHubCaches();
    const second = await prepareGitHubFile(reference, setup.root, "test-token");
    expect(second.root).toBe(first.root);
    expect(second.resolved.commit).toBe(first.resolved.commit);
  });

  it("reports when a repository has no default branch", async () => {
    temporary = await mkdtemp(join(tmpdir(), "write-once-github-empty-"));
    const remoteRoot = join(temporary, "remotes");
    const remote = join(remoteRoot, "owner", "repo.git");
    await mkdir(join(remoteRoot, "owner"), { recursive: true });
    git(["init", "--bare", "--initial-branch=main", remote]);
    vi.stubEnv("GITHUB_GIT_BASE_URL", `file://${remoteRoot}`);
    await expect(
      prepareGitHubFile(
        parseGitHubReference("repo:owner/repo/README.md"),
        join(temporary, "plugin-work"),
      ),
    ).rejects.toThrow("Could not determine the default branch");
  });

  it("reports Git failures when the repository cannot be reached", async () => {
    const setup = await createRepository();
    vi.stubEnv("GITHUB_GIT_BASE_URL", join(temporary!, "missing-remote"));
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts"), setup.root),
    ).rejects.toThrow("Git command failed");
  });

  it("replaces a checkout whose Git metadata is corrupted", async () => {
    const setup = await createRepository();
    const reference = parseGitHubReference("repo:owner/repo/src/index.ts");
    const prepared = await prepareGitHubFile(reference, setup.root);
    await rm(join(prepared.root, ".git"), { recursive: true, force: true });
    await mkdir(join(prepared.root, ".git"), { recursive: true });
    clearGitHubCaches();
    const refreshed = await prepareGitHubFile(reference, setup.root);
    expect(await readFile(join(refreshed.root, refreshed.path), "utf8")).toContain("main");
  });

  it("replaces a dirty checkout before resolving content", async () => {
    const setup = await createRepository();
    const reference = parseGitHubReference("repo:owner/repo/src/index.ts");
    const prepared = await prepareGitHubFile(reference, setup.root);
    await writeFile(join(prepared.root, prepared.path), "tampered\n");
    clearGitHubCaches();
    const refreshed = await prepareGitHubFile(reference, setup.root);
    expect(await readFile(join(refreshed.root, refreshed.path), "utf8")).toContain("main");
  });

  it("rejects missing refs and symbolic-link paths", async () => {
    const setup = await createRepository();
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo@missing/src/index.ts"), setup.root),
    ).rejects.toThrow("was not found");
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/linked.ts"), setup.root),
    ).rejects.toThrow("symbolic link");
  });

  it("reuses a clean checkout and accepts an HTTPS token", async () => {
    const setup = await createRepository();
    const reference = parseGitHubReference("repo:owner/repo/src/index.ts");
    const first = await prepareGitHubFile(reference, setup.root, "test-token");
    clearGitHubCaches();
    const second = await prepareGitHubFile(reference, setup.root, "test-token");
    expect(second.root).toBe(first.root);
    expect(second.resolved.commit).toBe(first.resolved.commit);
  });

  it("reports when a repository has no default branch", async () => {
    temporary = await mkdtemp(join(tmpdir(), "write-once-github-empty-"));
    const remoteRoot = join(temporary, "remotes");
    const remote = join(remoteRoot, "owner", "repo.git");
    await mkdir(join(remoteRoot, "owner"), { recursive: true });
    git(["init", "--bare", "--initial-branch=main", remote]);
    vi.stubEnv("GITHUB_GIT_BASE_URL", `file://${remoteRoot}`);
    await expect(
      prepareGitHubFile(
        parseGitHubReference("repo:owner/repo/README.md"),
        join(temporary, "plugin-work"),
      ),
    ).rejects.toThrow("Could not determine the default branch");
  });

  it("reports Git failures when the repository cannot be reached", async () => {
    const setup = await createRepository();
    vi.stubEnv("GITHUB_GIT_BASE_URL", join(temporary!, "missing-remote"));
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts"), setup.root),
    ).rejects.toThrow("Git command failed");
  });

  it("replaces a checkout whose Git metadata is corrupted", async () => {
    const setup = await createRepository();
    const reference = parseGitHubReference("repo:owner/repo/src/index.ts");
    const prepared = await prepareGitHubFile(reference, setup.root);
    await rm(join(prepared.root, ".git"), { recursive: true, force: true });
    await mkdir(join(prepared.root, ".git"), { recursive: true });
    clearGitHubCaches();
    const refreshed = await prepareGitHubFile(reference, setup.root);
    expect(await readFile(join(refreshed.root, refreshed.path), "utf8")).toContain("main");
  });

  it("replaces a dirty checkout before resolving content", async () => {
    const setup = await createRepository();
    const reference = parseGitHubReference("repo:owner/repo/src/index.ts");
    const prepared = await prepareGitHubFile(reference, setup.root);
    await writeFile(join(prepared.root, prepared.path), "tampered\n");
    clearGitHubCaches();
    const refreshed = await prepareGitHubFile(reference, setup.root);
    expect(await readFile(join(refreshed.root, refreshed.path), "utf8")).toContain("main");
  });

  it("rejects missing refs and symbolic-link paths", async () => {
    const setup = await createRepository();
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo@missing/src/index.ts"), setup.root),
    ).rejects.toThrow("was not found");
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/linked.ts"), setup.root),
    ).rejects.toThrow("symbolic link");
  });

  it("rejects missing files and unsafe paths", async () => {
    const setup = await createRepository();
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/missing.ts"), setup.root),
    ).rejects.toThrow("was not found");
    await expect(
      prepareGitHubFile({ owner: "owner", repository: "repo", path: "../secret" }, setup.root),
    ).rejects.toThrow("Unsafe GitHub file path");
    await Promise.all(
      ["/absolute", "src\\secret", "src//secret", "src/./secret", ""].map((path) =>
        expect(
          prepareGitHubFile({ owner: "owner", repository: "repo", path }, setup.root),
        ).rejects.toThrow("Unsafe GitHub file path"),
      ),
    );
  }, 20_000);
});
