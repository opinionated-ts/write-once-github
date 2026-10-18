import type { SourceReferenceContext } from "write-once";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearGitHubCaches, prepareGitHubFile } from "@/github-api";
import { githubPlugin } from "@/index";
import { parseGitHubReference } from "@/reference";
const repoUrl = "https://api.github.com/repos/owner/repo";
const commit = "commit-sha";
const blob = "blob-sha";
function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers });
}
function mockApi(
  options: {
    branches?: string[];
    tags?: string[];
    blobContent?: string;
    status?: number;
    rateLimited?: boolean;
    annotatedTag?: boolean;
    truncated?: boolean;
    blobEncoding?: string;
  } = {},
) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, headers: new Headers(init?.headers) });
    if (options.status)
      return json(
        {},
        options.status,
        options.rateLimited === false ? {} : { "retry-after": "60", "x-ratelimit-remaining": "0" },
      );
    if (url === repoUrl) return json({ default_branch: "main" });
    if (url.includes("/git/matching-refs/heads/")) {
      const branches = options.branches ?? ["main", "feature/nested"];
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return json(
        branches.slice((page - 1) * 100, page * 100).map((name) => ({
          name: `refs/heads/${name}`,
        })),
      );
    }
    if (url.includes("/git/matching-refs/tags/")) {
      const tags = options.tags ?? ["v1.0.0"];
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return json(
        tags.slice((page - 1) * 100, page * 100).map((name) => ({ name: `refs/tags/${name}` })),
      );
    }
    if (url.includes("/git/ref/heads/")) {
      const ref = decodeURIComponent(url.split("/git/ref/heads/")[1] ?? "");
      return (options.branches ?? ["main", "feature/nested"]).includes(ref)
        ? json({ object: { sha: commit, type: "commit" } })
        : json({}, 404);
    }
    if (url.includes("/git/ref/tags/")) {
      const ref = decodeURIComponent(url.split("/git/ref/tags/")[1] ?? "");
      return (options.tags ?? ["v1.0.0"]).includes(ref)
        ? json({
            object: options.annotatedTag
              ? { sha: "tag-sha", type: "tag" }
              : { sha: commit, type: "commit" },
          })
        : json({}, 404);
    }
    if (url.endsWith("/git/tags/tag-sha"))
      return json({ object: { sha: "nested-tag-sha", type: "tag" } });
    if (url.endsWith("/git/tags/nested-tag-sha"))
      return json({ object: { sha: commit, type: "commit" } });
    if (url.includes(`/git/trees/${commit}?recursive=1`))
      return json({
        truncated: options.truncated ?? false,
        tree: [
          { path: "src/index.ts", mode: "100644", type: "blob", sha: blob },
          { path: "docs/guide.md", mode: "100644", type: "blob", sha: blob },
          { path: "image.png", mode: "100644", type: "blob", sha: "binary-sha" },
        ],
      });
    if (url.endsWith(`/git/blobs/${blob}`))
      return json({
        encoding: options.blobEncoding ?? "base64",
        content: options.blobContent ?? btoa("hello world\n"),
      });
    if (url.endsWith("/git/blobs/binary-sha"))
      return json({ encoding: "base64", content: btoa("a\0b") });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearGitHubCaches();
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
describe("githubPlugin", () => {
  it("prepares each unique source once and resolves its prepared resource", async () => {
    const { calls } = mockApi();
    vi.stubEnv("GITHUB_TOKEN", "");
    const workingDirectory = await mkdtemp(join(tmpdir(), "write-once-github-test-"));
    try {
      const plugin = githubPlugin();
      const preparer = plugin.preparers![0]!;
      const resolver = plugin.resolvers![0]!;
      expect(plugin.extractors).toBeUndefined();
      const source = "repo:owner/repo/src/index.ts";
      const references = [sourceReference(source, "README.md"), sourceReference(source, "docs.md")];
      expect(preparer.canPrepare(references[0]!, { cwd: workingDirectory })).toBe(true);
      const result = await preparer.prepare(references, {
        cwd: workingDirectory,
        workingDirectory,
      });

      expect(result.resources).toHaveLength(1);
      expect(calls.filter(({ url }) => url.includes("/git/trees/")).length).toBe(1);
      expect(calls.filter(({ url }) => url.endsWith(`/git/blobs/${blob}`))).toHaveLength(1);
      expect(await readFile(join(workingDirectory, "files/0.txt"), "utf8")).toBe("hello world\n");

      const resolved = resolver.resolve(source, {
        cwd: workingDirectory,
        preparation: { preparerId: "write-once-github", workingDirectory, result },
      });
      expect(resolved).toMatchObject({
        root: workingDirectory,
        path: "files/0.txt",
        metadata: { provider: "github", repository: "owner/repo", sourcePath: "src/index.ts" },
      });
      expect(resolver.canResolve("./local.ts", { cwd: workingDirectory })).toBe(false);
      expect(
        resolver.canResolve(source, {
          cwd: workingDirectory,
          preparation: { preparerId: "another-plugin", workingDirectory, result },
        }),
      ).toBe(false);
      expect(() => resolver.resolve(source, { cwd: workingDirectory })).toThrow(
        "No GitHub preparation was assigned",
      );
      expect(() =>
        resolver.resolve(source, {
          cwd: workingDirectory,
          preparation: {
            preparerId: "write-once-github",
            workingDirectory,
            result: { resources: [{ root: workingDirectory }] },
          },
        }),
      ).toThrow("was not included in the assigned preparation batch");
      expect(() =>
        resolver.resolve(source, {
          cwd: workingDirectory,
          preparation: {
            preparerId: "write-once-github",
            workingDirectory,
            result: {
              resources: [{ root: workingDirectory }],
              metadata: { files: { [source]: { path: 1 } } },
            },
          },
        }),
      ).toThrow("was not included in the assigned preparation batch");
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});

describe("prepareGitHubFile", () => {
  it("discovers default branch and uses tree/blob APIs", async () => {
    const { calls } = mockApi();
    const result = await prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts"));
    expect(result.resolved).toMatchObject({
      ref: "main",
      commit,
      path: "src/index.ts",
      blob: { sha: blob },
    });
    expect(result.text).toBe("hello world\n");
    expect(calls.some(({ url }) => url.includes("/git/trees/"))).toBe(true);
  });
  it("supports refs containing slashes", async () => {
    mockApi();
    expect(
      (await prepareGitHubFile(parseGitHubReference("repo:owner/repo@feature/nested/src/index.ts")))
        .resolved,
    ).toMatchObject({ ref: "feature/nested", path: "src/index.ts" });
  });
  it("resolves tags", async () => {
    const { calls } = mockApi();
    expect(
      (await prepareGitHubFile(parseGitHubReference("repo:owner/repo@v1.0.0/src/index.ts")))
        .resolved.ref,
    ).toBe("v1.0.0");
    expect(calls.some(({ url }) => url.includes("/git/ref/tags/v1.0.0"))).toBe(true);
  });
  it("follows nested annotated tags to their commit", async () => {
    const { calls } = mockApi({ annotatedTag: true });
    const result = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo@v1.0.0/src/index.ts"),
    );
    expect(result.resolved.commit).toBe(commit);
    expect(
      calls.filter(({ url }) => url.includes("/git/tags/")).map(({ url }) => url.split("/").at(-1)),
    ).toEqual(["tag-sha", "nested-tag-sha"]);
  });
  it("paginates branch and tag discovery beyond 100 refs", async () => {
    const branches = Array.from({ length: 100 }, (_, index) => `branch-${index}`);
    branches.push("feature/nested");
    const { calls } = mockApi({ branches });
    const result = await prepareGitHubFile(
      parseGitHubReference("repo:owner/repo@feature/nested/src/index.ts"),
    );
    expect(result.resolved.ref).toBe("feature/nested");
    expect(
      calls.some(({ url }) => url.includes("/git/matching-refs/heads/?per_page=100&page=2")),
    ).toBe(true);
  });
  it("prefers branches on branch/tag name collision", async () => {
    const { calls } = mockApi({ branches: ["release"], tags: ["release"] });
    await prepareGitHubFile(parseGitHubReference("repo:owner/repo@release/src/index.ts"));
    expect(calls.some(({ url }) => url.includes("/git/ref/heads/release"))).toBe(true);
  });
  it("caches tree metadata and duplicate blob downloads", async () => {
    const { calls } = mockApi();
    await prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts"));
    await prepareGitHubFile(parseGitHubReference("repo:owner/repo/docs/guide.md"));
    expect(calls.filter(({ url }) => url.endsWith(`/git/blobs/${blob}`))).toHaveLength(1);
    expect(calls.filter(({ url }) => url.includes("/git/trees/"))).toHaveLength(1);
  });
  it("reuses blob downloads across refs that point to the same content", async () => {
    const { calls } = mockApi();
    await prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts"));
    await prepareGitHubFile(parseGitHubReference("repo:owner/repo@v1.0.0/docs/guide.md"));
    expect(calls.filter(({ url }) => url.endsWith(`/git/blobs/${blob}`))).toHaveLength(1);
  });
  it("reports missing refs", async () => {
    mockApi({ branches: ["main"], tags: ["v1.0.0"] });
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo@missing/src/index.ts")),
    ).rejects.toThrow('GitHub ref "missing" was not found in owner/repo');
  });
  it("explains permission failures", async () => {
    mockApi({ status: 403, rateLimited: false });
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts")),
    ).rejects.toThrow(
      "Check token repository access and Contents: Read-only / Metadata: Read-only permissions.",
    );
  });
  it("sends tokens for private repository access", async () => {
    const { calls } = mockApi();
    await prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts"), "secret");
    expect(calls.every(({ headers }) => headers.get("authorization") === "Bearer secret")).toBe(
      true,
    );
  });
  it("rejects truncated repository trees", async () => {
    mockApi({ truncated: true });
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts")),
    ).rejects.toThrow("truncated file tree");
  });
  it("rejects unsafe paths even when called with a manually constructed reference", async () => {
    mockApi();
    await expect(
      prepareGitHubFile({ owner: "owner", repository: "repo", path: "../secret" }),
    ).rejects.toThrow('Unsafe GitHub file path "../secret"');
  });
  it("reports unsupported blob encodings", async () => {
    mockApi({ blobEncoding: "utf-8" });
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts")),
    ).rejects.toThrow('unsupported blob encoding "utf-8"');
  });
  it("reports missing files", async () => {
    mockApi();
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/missing.ts")),
    ).rejects.toThrow("was not found in owner/repo@main");
  });
  it("reports binary content", async () => {
    mockApi();
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/image.png")),
    ).rejects.toThrow("is binary");
  });
  it("reports invalid UTF-8", async () => {
    mockApi({ blobContent: btoa(String.fromCharCode(255, 254)) });
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts")),
    ).rejects.toThrow("not valid UTF-8");
  });
  it("explains authentication failures", async () => {
    const { fetchMock } = mockApi();
    fetchMock.mockImplementation(async () => json({}, 401));
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts")),
    ).rejects.toThrow("Check GITHUB_TOKEN");
  });
  it("includes Retry-After guidance", async () => {
    mockApi({ status: 429 });
    await expect(
      prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts")),
    ).rejects.toThrow("Retry after 60 seconds");
  });
});
