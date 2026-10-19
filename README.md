# write-once-github

[![npm version](https://img.shields.io/npm/v/write-once-github)](https://www.npmjs.com/package/write-once-github)
[![npm downloads](https://img.shields.io/npm/dm/write-once-github)](https://www.npmjs.com/package/write-once-github)
[![CI](https://img.shields.io/github/actions/workflow/status/opinionated-ts/write-once-github/check-and-release.yml?label=CI)](https://github.com/opinionated-ts/write-once-github/actions/workflows/check-and-release.yml)
[![License](https://img.shields.io/github/license/opinionated-ts/write-once-github)](https://github.com/opinionated-ts/write-once-github/blob/main/LICENSE)

A [Write Once](https://github.com/opinionated-ts/write-once) plugin for resolving files from GitHub repositories through local Git checkouts.

## Install

```sh
bun add -d write-once write-once-github
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

The GitHub plugin only resolves the repository file. Whole-file, named-fragment, and range selection are handled by Write Once.

## Authentication

- Public repositories require no credentials.
- Private repositories use `GITHUB_TOKEN` from the process environment.
- The token should have access to the repository with `Contents: Read-only` and `Metadata: Read-only` permissions.
- `GITHUB_GIT_PROTOCOL=ssh` uses SSH instead of HTTPS when SSH credentials are already configured.
