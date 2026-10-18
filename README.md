# write-once-github

GitHub REST API provider for [Write Once](https://github.com/opinionated-ts/write-once). Resolves repository files without the GitHub CLI or a GitHub SDK.

## Install

```sh
bun add write-once write-once-github
```

Register it in `write-once.config.ts`:

```ts
import { defineConfig } from "write-once";
import { githubPlugin } from "write-once-github";

export default defineConfig({ plugins: [githubPlugin] });
```

## References

- `repo:owner/repository/path/to/file.ts` uses the repository's actual default branch.
- `repo:owner/repository@develop/path/to/file.ts` uses an explicit branch or tag. Branch names containing slashes are supported; branches take precedence over same-named tags.

The core remains responsible for whole-file, named-fragment, and range selection.

## Authentication

- Public repositories work anonymously.
- Private repositories require `GITHUB_TOKEN` in the process environment.
- Use a token with access to the repository and fine-grained `Contents: Read-only` and `Metadata: Read-only` permissions.
- The plugin does not read `.env` files.

## Behavior

- Uses Git Trees metadata and existing blob SHAs; caches trees by repository and commit, and text by repository and blob SHA.
- Rejects unsafe paths, binary files, invalid UTF-8, and truncated tree responses.
- Reports actionable errors for missing resources, authentication/permission failures, and rate limits, including `Retry-After` guidance.
- Leaves temporary-resource cleanup to Write Once.

## Development

```sh
bun install
bun test
bun check
bun run build
```
