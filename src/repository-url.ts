import type { GitHubSourceReference } from "./reference.js";

/** Builds the Git remote URL without placing credentials in the URL itself. */
export function getRepositoryUrl(reference: GitHubSourceReference): string {
  const repository = `${reference.owner}/${reference.repository}.git`;
  const baseUrl = process.env["GITHUB_GIT_BASE_URL"];
  if (baseUrl) return `${baseUrl.replace(/\/$/, "")}/${repository}`;
  return process.env["GITHUB_GIT_PROTOCOL"] === "ssh"
    ? `git@github.com:${repository}`
    : `https://github.com/${repository}`;
}
