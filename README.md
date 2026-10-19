# write-once-github

[![npm version](https://img.shields.io/npm/v/write-once-github)](https://www.npmjs.com/package/write-once-github)
[![npm downloads](https://img.shields.io/npm/dm/write-once-github)](https://www.npmjs.com/package/write-once-github)
[![CI](https://img.shields.io/github/actions/workflow/status/opinionated-ts/write-once-github/check-and-release.yml?label=CI)](https://github.com/opinionated-ts/write-once-github/actions/workflows/check-and-release.yml)
[![License](https://img.shields.io/github/license/opinionated-ts/write-once-github)](https://github.com/opinionated-ts/write-once-github/blob/main/LICENSE)

A [Write Once](https://github.com/opinionated-ts/write-once) plugin for resolving files from GitHub repositories through local Git checkouts.

## Install

```sh
bun add -d write-once write-once-github
# npm install --save-dev write-once write-once-github
# pnpm add -D write-once write-once-github
```

Register the plugin in `write-once.config.ts`:

```ts
import { defineConfig } from "write-once";
import { githubPlugin } from "write-once-github";

export default defineConfig({ plugins: [githubPlugin] });
```

## References

```text
repo:owner/repository/path/to/file.ts
repo:owner/repository@develop/path/to/file.ts
repo:owner/repository@feature/nested/path/to/file.ts
```

Without `@ref`, the repository's default branch is used. Explicit references can be branches, tags, or commit SHAs. Branches take precedence over same-named tags.

## Example

These examples use `example-org/example-repo` as a placeholder repository, not a real project. The first fragment points to the `main` branch and follows its changes; the second points to release tag `v1.0.0` and remains pinned to that version.

Before generation, the fragments contain placeholder text:

<!-- write-once-ignore-start -->

<!-- prettier-ignore -->
````md
<!-- fragment source="repo:example-org/example-repo@main/src/version.ts" -->
Replace this placeholder with the file content from the main branch.
<!-- /fragment -->

<!-- fragment source="repo:example-org/example-repo@v1.0.0/src/version.ts" -->
Replace this placeholder with the file content from release v1.0.0.
<!-- /fragment -->
````

<!-- write-once-ignore-end -->

After `write-once generate`, each placeholder is replaced with the contents of its referenced file. For example, if those files export version constants, the result could look like this:

<!-- write-once-ignore-start -->

<!-- prettier-ignore -->
````md
<!-- fragment source="repo:example-org/example-repo@main/src/version.ts" -->
export const VERSION = "2.0.0";
<!-- /fragment -->

<!-- fragment source="repo:example-org/example-repo@v1.0.0/src/version.ts" -->
export const VERSION = "1.0.0";
<!-- /fragment -->
````

<!-- write-once-ignore-end -->

The version values are illustrative. The actual inserted content always comes from the selected repository, file path, and ref.

## Authentication

- Public repositories require no credentials.
- Private repositories use `GITHUB_TOKEN` from the process environment.
- The token should have access to the repository with `Contents: Read-only` and `Metadata: Read-only` permissions.
- `GITHUB_GIT_PROTOCOL=ssh` uses SSH instead of HTTPS when SSH credentials are already configured.

## Related

- [Write Once](https://github.com/opinionated-ts/write-once) — Reuse and synchronize content from a single source instead of maintaining duplicated copies.
- [write-once-markdown](https://github.com/opinionated-ts/write-once-markdown) — Format source-code fragments as fenced code blocks when generating Markdown.
