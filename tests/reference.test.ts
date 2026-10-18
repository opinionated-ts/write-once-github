import { describe, expect, it } from "vitest";

import { isGitHubReference, parseGitHubReference } from "@/reference";

describe("GitHub references", () => {
  it("parses default branch references", () =>
    expect(parseGitHubReference("repo:owner/repo/src/index.ts")).toEqual({
      owner: "owner",
      repository: "repo",
      path: "src/index.ts",
    }));
  it("parses explicit refs", () =>
    expect(parseGitHubReference("repo:owner/repo@develop/src/index.ts")).toEqual({
      owner: "owner",
      repository: "repo",
      ref: "develop",
      path: "src/index.ts",
    }));
  it.each([
    "repo:owner/repo",
    "repo:owner/repo/../secret",
    "repo:owner/repo/src/../secret",
    "repo:owner/repo/src\\secret",
    "repo:owner/repo@/src/index.ts",
    "repo:/repo/src/index.ts",
  ])("rejects invalid reference %s", (source) =>
    expect(() => parseGitHubReference(source)).toThrow(),
  );
  it("recognizes provider references", () => {
    expect(isGitHubReference("repo:owner/repo/a.ts")).toBe(true);
    expect(isGitHubReference("./a.ts")).toBe(false);
  });
});
