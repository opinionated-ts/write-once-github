import { describe, expect, it } from "vitest";

import { isGitHubReference, parseGitHubReference } from "@/reference";

describe("GitHub references", () => {
  it("parses default branch references", () =>
    expect(parseGitHubReference("repo:owner/repo/src/index.ts")).toEqual({
      owner: "owner",
      repository: "repo",
      path: "src/index.ts",
    }));

  it("preserves the remaining path for remote resolution of refs containing slashes", () =>
    expect(parseGitHubReference("repo:owner/repo@feature/nested/src/index.ts")).toEqual({
      owner: "owner",
      repository: "repo",
      ref: "feature",
      path: "nested/src/index.ts",
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

  it("rejects sources owned by another resolver", () => {
    expect(() => parseGitHubReference("./src/index.ts")).toThrow(
      "Unsupported GitHub source reference",
    );
  });

  it("recognizes provider references", () => {
    expect(isGitHubReference("repo:owner/repo/a.ts")).toBe(true);
    expect(isGitHubReference("./a.ts")).toBe(false);
  });
});
