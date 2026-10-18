export interface GitHubSourceReference {
  owner: string;
  repository: string;
  path: string;
  ref?: string;
}

export function isGitHubReference(source: string): boolean {
  return source.startsWith("repo:");
}

export function parseGitHubReference(source: string): GitHubSourceReference {
  if (!isGitHubReference(source))
    throw new Error(`Unsupported GitHub source reference: ${JSON.stringify(source)}.`);
  const segments = source.slice("repo:".length).split("/");
  const owner = segments[0];
  const repositoryAndRef = segments[1];
  if (!owner || !repositoryAndRef || owner === "." || owner === "..") {
    throw new Error(`Invalid GitHub source reference: ${JSON.stringify(source)}.`);
  }
  const at = repositoryAndRef.indexOf("@");
  const repository = at < 0 ? repositoryAndRef : repositoryAndRef.slice(0, at);
  const ref = at < 0 ? undefined : repositoryAndRef.slice(at + 1);
  const path = segments.slice(2).join("/");
  if (
    !repository ||
    repository === "." ||
    repository === ".." ||
    !path ||
    path.includes("\\") ||
    segments.slice(2).some((segment) => !segment || segment === "." || segment === "..") ||
    ref === ""
  ) {
    throw new Error(`Invalid GitHub source reference: ${JSON.stringify(source)}.`);
  }
  return { owner, repository, path, ...(ref === undefined ? {} : { ref }) };
}
