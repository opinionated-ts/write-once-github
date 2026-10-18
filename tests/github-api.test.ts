import { afterEach, describe, expect, it, vi } from "vitest";

import { clearGitHubCaches, prepareGitHubFile } from "@/github-api";
import { parseGitHubReference } from "@/reference";
const repoUrl = "https://api.github.com/repos/owner/repo";
const commit = "commit-sha";
const blob = "blob-sha";
function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers });
}
function mockApi(
  options: { branches?: string[]; tags?: string[]; blobContent?: string; status?: number } = {},
) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, headers: new Headers(init?.headers) });
    if (options.status)
      return json({}, options.status, { "retry-after": "60", "x-ratelimit-remaining": "0" });
    if (url === repoUrl) return json({ default_branch: "main" });
    if (url.includes("/git/matching-refs/heads/"))
      return json(
        (options.branches ?? ["main", "feature/nested"]).map((name) => ({
          name: `refs/heads/${name}`,
        })),
      );
    if (url.includes("/git/matching-refs/tags/"))
      return json((options.tags ?? ["v1.0.0"]).map((name) => ({ name: `refs/tags/${name}` })));
    if (url.includes("/git/ref/heads/")) {
      const ref = decodeURIComponent(url.split("/git/ref/heads/")[1] ?? "");
      return (options.branches ?? ["main", "feature/nested"]).includes(ref)
        ? json({ object: { sha: commit, type: "commit" } })
        : json({}, 404);
    }
    if (url.includes("/git/ref/tags/")) {
      const ref = decodeURIComponent(url.split("/git/ref/tags/")[1] ?? "");
      return (options.tags ?? ["v1.0.0"]).includes(ref)
        ? json({ object: { sha: commit, type: "commit" } })
        : json({}, 404);
    }
    if (url.includes(`/git/trees/${commit}?recursive=1`))
      return json({
        truncated: false,
        tree: [
          { path: "src/index.ts", mode: "100644", type: "blob", sha: blob },
          { path: "docs/guide.md", mode: "100644", type: "blob", sha: blob },
          { path: "image.png", mode: "100644", type: "blob", sha: "binary-sha" },
        ],
      });
    if (url.endsWith(`/git/blobs/${blob}`))
      return json({ encoding: "base64", content: options.blobContent ?? btoa("hello world\n") });
    if (url.endsWith("/git/blobs/binary-sha"))
      return json({ encoding: "base64", content: btoa("a\0b") });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
afterEach(() => {
  vi.unstubAllGlobals();
  clearGitHubCaches();
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
  it("sends tokens for private repository access", async () => {
    const { calls } = mockApi();
    await prepareGitHubFile(parseGitHubReference("repo:owner/repo/src/index.ts"), "secret");
    expect(calls.every(({ headers }) => headers.get("authorization") === "Bearer secret")).toBe(
      true,
    );
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
