import { execFile } from "node:child_process";
import { access, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { GitHubSourceReference } from "./reference.js";

import { getRepositoryUrl } from "./repository-url.js";

const execFileAsync = promisify(execFile);
const preparations = new Map<string, Promise<string>>();

interface RemoteRef {
  ref: string;
  commit: string;
  kind: "branch" | "tag" | "commit";
  path: string;
}

interface PreparedGitHubFile {
  root: string;
  path: string;
  resolved: {
    owner: string;
    repository: string;
    ref: string;
    commit: string;
    path: string;
  };
}

function gitEnvironment(token?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Git authentication uses an HTTP header so credentials are not embedded in the remote URL.
  if (token) {
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "http.extraheader";
    env["GIT_CONFIG_VALUE_0"] =
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return env;
}

async function git(
  args: string[],
  options: { cwd?: string; token?: string } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd,
      env: gitEnvironment(options.token),
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed: ${detail}`, { cause: error });
  }
}

function safeSegment(value: string): string {
  return encodeURIComponent(value);
}

async function getRemoteRef(reference: GitHubSourceReference, token?: string): Promise<RemoteRef> {
  const url = getRepositoryUrl(reference);
  const requested = reference.ref;
  if (!requested) {
    const output = await git(["ls-remote", "--symref", url, "HEAD"], { token });
    const lines = output.split("\n").filter(Boolean);
    const symbolicHead = lines.find((line) => line.startsWith("ref: ") && line.endsWith("\tHEAD"));
    const headRef = symbolicHead?.slice(5).split("\t", 1)[0];
    const headSha = lines
      .find((line) => line.endsWith("\tHEAD") && !line.startsWith("ref: "))
      ?.split("\t", 1)[0];
    if (!headRef || !headSha)
      throw new Error(
        `Could not determine the default branch for ${reference.owner}/${reference.repository}.`,
      );
    return {
      ref: headRef.slice("refs/heads/".length),
      commit: headSha,
      kind: "branch",
      path: reference.path,
    };
  }

  if (/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(requested))
    return { ref: requested, commit: requested, kind: "commit", path: reference.path };

  // A slash can belong to either a branch name or the file path, so match the longest remote ref prefix.
  const pathParts = reference.path.split("/");
  const candidates = [
    requested,
    ...pathParts
      .slice(0, -1)
      .map((_, index) => [requested, ...pathParts.slice(0, index + 1)].join("/")),
  ];
  const patterns = candidates.flatMap((candidate) => [
    `refs/heads/${candidate}`,
    `refs/tags/${candidate}`,
    `refs/tags/${candidate}^{}`,
  ]);
  const output = await git(["ls-remote", url, ...patterns], { token });
  const refs = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [sha, name] = line.split("\t");
    if (sha && name) refs.set(name, sha);
  }

  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index]!;
    const branch = refs.get(`refs/heads/${candidate}`);
    if (branch) {
      return {
        ref: candidate,
        commit: branch,
        kind: "branch",
        path: pathParts.slice(index).join("/"),
      };
    }
    const tag = refs.get(`refs/tags/${candidate}^{}`) ?? refs.get(`refs/tags/${candidate}`);
    if (tag) {
      return {
        ref: candidate,
        commit: tag,
        kind: "tag",
        path: pathParts.slice(index).join("/"),
      };
    }
  }
  throw new Error(
    `Git reference ${JSON.stringify(requested)} was not found in ${reference.owner}/${reference.repository}.`,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertSafeFile(root: string, filePath: string): Promise<void> {
  if (
    !filePath ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe GitHub file path ${JSON.stringify(filePath)}.`);
  }

  const parts = filePath.split("/");
  const entries = await Promise.all(
    parts.map(async (_, index) => {
      const path = join(root, ...parts.slice(0, index + 1));
      try {
        return await lstat(path);
      } catch {
        throw new Error(
          `File ${JSON.stringify(filePath)} was not found in the prepared GitHub repository.`,
        );
      }
    }),
  );
  for (const [index, info] of entries.entries()) {
    if (info.isSymbolicLink())
      throw new Error(`GitHub file path ${JSON.stringify(filePath)} traverses a symbolic link.`);
    if (index < entries.length - 1 && !info.isDirectory())
      throw new Error(
        `GitHub file path ${JSON.stringify(filePath)} contains a non-directory parent.`,
      );
    if (index === entries.length - 1 && !info.isFile())
      throw new Error(`GitHub path ${JSON.stringify(filePath)} is not a regular file.`);
  }
}

async function isReusable(path: string, commit: string, token?: string): Promise<boolean> {
  if (!(await pathExists(join(path, ".git")))) return false;
  try {
    const [head, status] = await Promise.all([
      git(["rev-parse", "HEAD"], { cwd: path, token }),
      git(["status", "--porcelain"], { cwd: path, token }),
    ]);
    return head === commit && status === "";
  } catch {
    return false;
  }
}

async function checkoutRepository(
  reference: GitHubSourceReference,
  root: string,
  remote: RemoteRef,
  token?: string,
): Promise<void> {
  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  const temporary = `${root}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await rm(temporary, { recursive: true, force: true });
  try {
    await git(
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--",
        getRepositoryUrl(reference),
        temporary,
      ],
      { token },
    );
    const fetchRef =
      remote.kind === "branch"
        ? `refs/heads/${remote.ref}`
        : remote.kind === "tag"
          ? `refs/tags/${remote.ref}`
          : remote.commit;
    await git(["fetch", "--depth=1", "origin", fetchRef], { cwd: temporary, token });
    await git(["checkout", "--detach", remote.commit], { cwd: temporary, token });
    await rm(root, { recursive: true, force: true });
    await rename(temporary, root);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** Prepares a local checkout and returns the requested file's path within it. */
export async function prepareGitHubFile(
  reference: GitHubSourceReference,
  workingDirectory: string,
  token?: string,
): Promise<PreparedGitHubFile> {
  if (
    !reference.path ||
    reference.path.startsWith("/") ||
    reference.path.includes("\\") ||
    reference.path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe GitHub file path ${JSON.stringify(reference.path)}.`);
  }
  const remote = await getRemoteRef(reference, token);
  const state =
    remote.kind === "commit"
      ? `commit-${remote.commit}`
      : `${remote.kind}-${safeSegment(remote.ref)}`;
  const root = join(workingDirectory, reference.owner, reference.repository, state);
  const key = `${root}\0${remote.commit}`;
  let pending = preparations.get(key);
  if (!pending) {
    pending = (async () => {
      if (!(await isReusable(root, remote.commit, token)))
        await checkoutRepository(reference, root, remote, token);
      return root;
    })().catch((error: unknown) => {
      if (preparations.get(key) === pending) preparations.delete(key);
      throw error;
    });
    preparations.set(key, pending);
  }
  try {
    await pending;
  } finally {
    if (preparations.get(key) === pending) preparations.delete(key);
  }
  await assertSafeFile(root, remote.path);
  return {
    root,
    path: remote.path,
    resolved: {
      owner: reference.owner,
      repository: reference.repository,
      ref: remote.ref,
      commit: remote.commit,
      path: remote.path,
    },
  };
}

export function clearGitHubCaches(): void {
  preparations.clear();
}
