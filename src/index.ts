import type {
  PluginFactory,
  ResourceContext,
  ResourcePreparationContext,
  SourceReferenceContext,
} from "write-once";

import { prepareGitHubFile } from "./github-api.js";
import { isGitHubReference, parseGitHubReference } from "./reference.js";

interface PreparedFile {
  root: string;
  path: string;
  owner: string;
  repository: string;
  ref: string;
  commit: string;
  sourcePath: string;
}
const PLUGIN_ID = "write-once-github";
type GitHubPreparationContext = ResourcePreparationContext & {
  workspaceDirectory?: string;
  reportProgress?: (message: string) => void;
};
function isPreparedFile(value: unknown): value is PreparedFile {
  if (typeof value !== "object" || value === null) return false;
  return ["root", "path", "owner", "repository", "ref", "commit", "sourcePath"].every(
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
export const githubPlugin: PluginFactory = () => {
  return {
    name: "GitHub",
    preparers: [
      {
        id: PLUGIN_ID,
        canPrepare: (reference: SourceReferenceContext) => isGitHubReference(reference.source),
        async prepare(references, context) {
          const token = process.env["GITHUB_TOKEN"];
          const preparationContext = context as GitHubPreparationContext;
          const root = preparationContext.workspaceDirectory ?? context.workingDirectory;

          preparationContext.reportProgress?.(
            "Resolving repository references and preparing local checkouts.",
          );

          // A source can feed multiple destinations; materialize it only once per run.
          const uniqueReferences = new Map(
            references.map((reference) => [reference.source, reference]),
          );
          const preparedFiles = await Promise.all(
            [...uniqueReferences.values()].map(async (reference) => {
              const prepared = await prepareGitHubFile(
                parseGitHubReference(reference.source),
                root,
                token,
              );
              preparationContext.reportProgress?.(`Prepared ${reference.source}.`);
              return {
                source: reference.source,
                metadata: {
                  root: prepared.root,
                  path: prepared.path,
                  owner: prepared.resolved.owner,
                  repository: prepared.resolved.repository,
                  ref: prepared.resolved.ref,
                  commit: prepared.resolved.commit,
                  sourcePath: prepared.resolved.path,
                } satisfies PreparedFile,
              };
            }),
          );
          const files: Record<string, PreparedFile> = {};
          const resources = new Map<string, { root: string; metadata: { provider: string } }>();
          for (const file of preparedFiles) {
            files[file.source] = file.metadata;
            resources.set(file.metadata.root, {
              root: file.metadata.root,
              metadata: { provider: "github" },
            });
          }
          return { resources: [...resources.values()], metadata: { files } };
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
            root: file.root,
            path: file.path,
            metadata: {
              provider: "github",
              repository: `${file.owner}/${file.repository}`,
              ref: file.ref,
              commit: file.commit,
              sourcePath: file.sourcePath,
            },
          };
        },
      },
    ],
  };
};

export { prepareGitHubFile } from "./github-api.js";
export { isGitHubReference, parseGitHubReference } from "./reference.js";
export type { GitHubSourceReference } from "./reference.js";
