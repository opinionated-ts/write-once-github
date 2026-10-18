# @opinionated-ts/package-template

A TypeScript project template for distributable packages, CLI tools, SDKs, libraries, and other projects that need to be built and packaged for distribution.

It is built on top of [`@opinionated-ts/template`](https://github.com/opinionated-ts/template) and provides the same tooling foundation, with additional structure and defaults for package development and distribution.

## When to use this template?

Use this template when developing a TypeScript project that needs to be built and packaged for distribution.

It is intended for projects such as:

- npm packages and libraries
- CLI tools
- SDKs
- reusable TypeScript modules
- other distributable projects that require a build and packaging step

It provides:

- A package-focused starting point built on [`@opinionated-ts/template`](https://github.com/opinionated-ts/template)
- Opinionated defaults for performance, code quality, and developer experience
- A modern Bun-first development environment
- A foundation for building and distributing TypeScript packages
- Consistent tooling across Opinionated TS package projects

## Getting started

To get started, clone the repository directly:

```bash
git clone https://github.com/opinionated-ts/package-template.git my-project

cd my-project

rm -rf .git
git init
```

### Install dependencies

```bash
bun install
```

### Install git hooks

```bash
bun hooks:install
```

### Configure package metadata

Update `package.json` for your project and repository:

```json
{
  "name": "your-package-name",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/your-username/your-repo.git"
  }
}
```

At minimum, update:

- `name` — your package name
- `repository.url` — your repository URL

## What's included

### TypeScript tooling foundation

The package template inherits the tooling, conventions, and project foundation provided by [`@opinionated-ts/template`](https://github.com/opinionated-ts/template).

### Package development foundation

- `tsdown` builds `src/index.ts` as ESM and CommonJS.
- TypeScript declaration files are generated for both module formats.
- `package.json` defines conditional exports and publishes only `dist` files.
- `bun run build` creates a clean production build; `bun run build:watch` watches for changes.

Add the package's public API to `src/index.ts`. Update the package name and repository metadata before publishing.

## Related projects

- [`@opinionated-ts/template`](https://github.com/opinionated-ts/template) — base TypeScript project template
- [`@opinionated-ts/config`](https://github.com/opinionated-ts/config) — shared tooling configuration used across Opinionated TS projects
