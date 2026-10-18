import type { GitHubSourceReference } from "./reference.js";

const API_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
interface GitReference {
  object: { sha: string; type: string };
}
interface TreeResponse {
  truncated: boolean;
  tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
}
interface RefResponse {
  name: string;
}
interface BlobResponse {
  encoding: string;
  content: string;
}
export interface GitHubFile {
  path: string;
  sha: string;
  size?: number;
}
export interface ResolvedGitHubReference {
  owner: string;
  repository: string;
  ref: string;
  commit: string;
  path: string;
  blob: GitHubFile;
}
const treeCache = new Map<string, Promise<readonly GitHubFile[]>>();
const contentCache = new Map<string, Promise<string>>();
const repoKey = (reference: Pick<GitHubSourceReference, "owner" | "repository">) =>
  `${reference.owner}/${reference.repository}`;

async function request<T>(path: string, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" || retryAfter !== null));
    const reason =
      response.status === 401
        ? "Authentication failed. Check GITHUB_TOKEN."
        : response.status === 404
          ? "Repository, ref, or file was not found, or the token cannot access it."
          : limited
            ? `GitHub rate limit reached.${retryAfter ? ` Retry after ${retryAfter} seconds.` : " Wait for the rate limit to reset."}`
            : response.status === 403
              ? "GitHub denied access. Check token repository access and Contents: Read-only / Metadata: Read-only permissions."
              : `GitHub API request failed with HTTP ${response.status}.`;
    throw new Error(`${reason} (${response.status} ${response.statusText}; ${path}).`);
  }
  // The response shape is endpoint-specific and defined at each call site.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as T;
}

async function getCommit(
  reference: GitHubSourceReference,
  ref: string,
  token?: string,
): Promise<string> {
  const encoded = ref.split("/").map(encodeURIComponent).join("/");
  const result = await request<GitReference>(
    `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}/git/ref/heads/${encoded}`,
    token,
  ).catch(async (error: unknown) =>
    request<GitReference>(
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}/git/ref/tags/${encoded}`,
      token,
    ).catch(() => {
      throw error;
    }),
  );
  if (result.object.type === "commit") return result.object.sha;
  if (result.object.type === "tag") {
    const tag = await request<{ object: { sha: string; type: string } }>(
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}/git/tags/${result.object.sha}`,
      token,
    );
    if (tag.object.type === "commit") return tag.object.sha;
  }
  throw new Error(`GitHub ref ${JSON.stringify(ref)} does not resolve to a commit.`);
}

async function getRefNames(
  reference: GitHubSourceReference,
  kind: "heads" | "tags",
  token?: string,
): Promise<readonly string[]> {
  const refs = await request<RefResponse[]>(
    `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}/git/matching-refs/${kind}/`,
    token,
  );
  const prefix = `refs/${kind}/`;
  return refs
    .map(({ name }) => (name.startsWith(prefix) ? name.slice(prefix.length) : name))
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length || a.localeCompare(b));
}

async function resolveRef(
  reference: GitHubSourceReference,
  token?: string,
): Promise<{ ref: string; path: string; commit: string }> {
  if (reference.ref === undefined) {
    const repository = await request<{ default_branch: string }>(
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}`,
      token,
    );
    const ref = repository.default_branch;
    return { ref, path: reference.path, commit: await getCommit(reference, ref, token) };
  }
  const [branches, tags] = await Promise.all([
    getRefNames(reference, "heads", token),
    getRefNames(reference, "tags", token),
  ]);
  const branchSet = new Set(branches);
  const tagSet = new Set(tags);
  const candidates = [...reference.ref.split("/"), ...reference.path.split("/")];
  let length = 0;
  for (let index = candidates.length; index > 0; index--) {
    const candidate = candidates.slice(0, index).join("/");
    if (branchSet.has(candidate) || tagSet.has(candidate)) {
      length = index;
      break;
    }
  }
  if (!length)
    throw new Error(
      `GitHub ref ${JSON.stringify(reference.ref)} was not found in ${repoKey(reference)}. Check the branch or tag name.`,
    );
  const ref = candidates.slice(0, length).join("/");
  const path = candidates.slice(length).join("/");
  return { ref, path, commit: await getCommit(reference, ref, token) };
}

async function getTree(
  reference: GitHubSourceReference,
  commit: string,
  token?: string,
): Promise<readonly GitHubFile[]> {
  const key = `${repoKey(reference)}@${commit}`;
  let pending = treeCache.get(key);
  if (!pending) {
    pending = request<TreeResponse>(
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}/git/trees/${commit}?recursive=1`,
      token,
    )
      .then((result) => {
        if (result.truncated)
          throw new Error(
            `GitHub returned a truncated file tree for ${repoKey(reference)}@${commit}; the requested file cannot be verified safely.`,
          );
        return result.tree
          .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
          .map(({ path, sha, size }) => {
            const file: GitHubFile = { path, sha };
            if (size !== undefined) file.size = size;
            return file;
          });
      })
      .catch((error: unknown) => {
        treeCache.delete(key);
        throw error;
      });
    treeCache.set(key, pending);
  }
  return await pending;
}

async function getText(
  reference: GitHubSourceReference,
  blob: GitHubFile,
  token?: string,
): Promise<string> {
  const key = `${repoKey(reference)}@${blob.sha}`;
  let pending = contentCache.get(key);
  if (!pending) {
    pending = request<BlobResponse>(
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}/git/blobs/${blob.sha}`,
      token,
    )
      .then((result) => {
        if (result.encoding !== "base64")
          throw new Error(
            `GitHub returned unsupported blob encoding ${JSON.stringify(result.encoding)} for ${blob.path}.`,
          );
        const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, "")), (character) =>
          character.charCodeAt(0),
        );
        if (bytes.includes(0))
          throw new Error(
            `GitHub file ${JSON.stringify(blob.path)} is binary and cannot be used as text.`,
          );
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error(`GitHub file ${JSON.stringify(blob.path)} is not valid UTF-8 text.`);
        }
      })
      .catch((error: unknown) => {
        contentCache.delete(key);
        throw error;
      });
    contentCache.set(key, pending);
  }
  return await pending;
}

export async function prepareGitHubFile(
  reference: GitHubSourceReference,
  token?: string,
): Promise<{ resolved: ResolvedGitHubReference; text: string }> {
  const selected = await resolveRef(reference, token);
  if (
    !selected.path ||
    selected.path.startsWith("/") ||
    selected.path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe GitHub file path ${JSON.stringify(selected.path)}.`);
  }
  const tree = await getTree(reference, selected.commit, token);
  const blob = tree.find((file) => file.path === selected.path);
  if (!blob)
    throw new Error(
      `File ${JSON.stringify(selected.path)} was not found in ${repoKey(reference)}@${selected.ref}. Check the path and ref.`,
    );
  return {
    resolved: {
      owner: reference.owner,
      repository: reference.repository,
      ref: selected.ref,
      commit: selected.commit,
      path: selected.path,
      blob,
    },
    text: await getText(reference, blob, token),
  };
}

export function clearGitHubCaches(): void {
  treeCache.clear();
  contentCache.clear();
}
