import type { PluginContribution, ResourceContext, SourceReferenceContext } from "write-once";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { prepareGitHubFile } from "./github-api.js";
import { isGitHubReference, parseGitHubReference } from "./reference.js";

interface PreparedFile {
  path: string;
  owner: string;
  repository: string;
  ref: string;
  commit: string;
  sourcePath: string;
  blobSha: string;
}
const PLUGIN_ID = "write-once-github";
function isPreparedFile(value: unknown): value is PreparedFile {
  if (typeof value !== "object" || value === null) return false;
  return ["path", "owner", "repository", "ref", "commit", "sourcePath", "blobSha"].every(
    (key) => typeof Reflect.get(value, key) === "string",
  );
}
function getPreparedFile(source: string, context: ResourceContext): PreparedFile {
  const files = context.preparation?.result.metadata?.["files"];
  if (typeof files !== "object" || files === null)
    throw new Error(
      `GitHub source ${JSON.stringify(source)} was not included in the assigned preparation batch.`,
    );
  const file: unknown = Reflect.get(files, source);
  if (!isPreparedFile(file))
    throw new Error(
      `GitHub source ${JSON.stringify(source)} was not included in the assigned preparation batch.`,
    );
  return file;
}

/**
 * Creates the GitHub repository provider for Write Once.
 *
 * References use `repo:owner/repository/path` or `repo:owner/repository@ref/path`.
 * Public repositories work anonymously; private repositories use `GITHUB_TOKEN`.
 */
export function githubPlugin(): PluginContribution {
  return {
    name: PLUGIN_ID,
    preparers: [
      {
        id: PLUGIN_ID,
        canPrepare: (reference: SourceReferenceContext) => isGitHubReference(reference.source),
        async prepare(references, context) {
          const token = process.env["GITHUB_TOKEN"];
          const root = context.workingDirectory;
          await mkdir(root, { recursive: true });
          const prepared = await Promise.all(
            references.map(async (reference, index) => {
              const { resolved, text } = await prepareGitHubFile(
                parseGitHubReference(reference.source),
                token,
              );
              const path = `files/${index}.txt`;
              const destination = join(root, path);
              await mkdir(dirname(destination), { recursive: true });
              await writeFile(destination, text, "utf8");
              return {
                source: reference.source,
                metadata: {
                  path,
                  owner: resolved.owner,
                  repository: resolved.repository,
                  ref: resolved.ref,
                  commit: resolved.commit,
                  sourcePath: resolved.path,
                  blobSha: resolved.blob.sha,
                } satisfies PreparedFile,
              };
            }),
          );
          const files: Record<string, PreparedFile> = {};
          for (const file of prepared) files[file.source] = file.metadata;
          return { resources: [{ root, metadata: { provider: "github" } }], metadata: { files } };
        },
      },
    ],
    resolvers: [
      {
        id: PLUGIN_ID,
        canResolve(source, context) {
          return isGitHubReference(source) && context.preparation?.preparerId === PLUGIN_ID;
        },
        resolve(source, context) {
          const preparation = context.preparation;
          if (!preparation)
            throw new Error(`No GitHub preparation was assigned to ${JSON.stringify(source)}.`);
          const file = getPreparedFile(source, context);
          return {
            root: preparation.result.resources[0]!.root,
            path: file.path,
            metadata: {
              provider: "github",
              repository: `${file.owner}/${file.repository}`,
              ref: file.ref,
              commit: file.commit,
              sourcePath: file.sourcePath,
              blobSha: file.blobSha,
            },
          };
        },
      },
    ],
  };
}

export { clearGitHubCaches, prepareGitHubFile } from "./github-api.js";
export { isGitHubReference, parseGitHubReference } from "./reference.js";
export type { GitHubSourceReference } from "./reference.js";
