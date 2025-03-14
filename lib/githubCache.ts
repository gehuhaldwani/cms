import { db } from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import { cachedEntriesTable } from "@/db/schema";
import { createOctokitInstance } from "@/lib/utils/octokit";
import path from "path";

type FileChange = {
  path: string;
  sha: string;
};

const updateCache = async (
  owner: string,
  repo: string,
  branch: string,
  removedFiles: Array<{ path: string }>,
  modifiedFiles: Array<FileChange>,
  addedFiles: Array<FileChange>,
  token: string
) => {
  // Get all unique parent paths for all operations
  const parentPaths = Array.from(new Set([
    ...removedFiles.map(f => path.dirname(f.path)),
    ...modifiedFiles.map(f => path.dirname(f.path)),
    ...addedFiles.map(f => path.dirname(f.path))
  ]));
  
  const entries = await db.query.cachedEntriesTable.findMany({
    where: and(
      eq(cachedEntriesTable.owner, owner),
      eq(cachedEntriesTable.repo, repo),
      eq(cachedEntriesTable.branch, branch),
      inArray(cachedEntriesTable.parentPath, parentPaths)
    )
  });

  const cachedParentPaths = parentPaths.length > 0 ? 
    Array.from(new Set(entries.map(e => e.parentPath))) : [];

  // Only process files in cached directories
  const filesToRemove = removedFiles.filter(file => 
    cachedParentPaths.includes(path.dirname(file.path))
  );

  const filesToFetch = [
    ...modifiedFiles.filter(file => cachedParentPaths.includes(path.dirname(file.path))),
    ...addedFiles.filter(file => cachedParentPaths.includes(path.dirname(file.path)))
  ];

  // Delete removed files (only if in cached directories)
  if (filesToRemove.length > 0) {
    await db.delete(cachedEntriesTable).where(
      and(
        eq(cachedEntriesTable.owner, owner),
        eq(cachedEntriesTable.repo, repo),
        eq(cachedEntriesTable.branch, branch),
        inArray(cachedEntriesTable.path, filesToRemove.map(f => f.path))
      )
    );
  }

  if (filesToFetch.length === 0) return;

  // Fetch content for all files in a single GraphQL query
  const octokit = createOctokitInstance(token);
  
  const query = `
    query($owner: String!, $repo: String!, ${filesToFetch.map((_, i) => `$exp${i}: String!`).join(', ')}) {
      repository(owner: $owner, name: $repo) {
        ${filesToFetch.map((_, i) => `
          file${i}: object(expression: $exp${i}) {
            ... on Blob {
              text
              oid
            }
          }
        `).join('\n')}
      }
    }
  `;

  const variables = {
    owner,
    repo,
    ...Object.fromEntries(
      filesToFetch.map((file, i) => [`exp${i}`, `${branch}:${file.path}`])
    )
  };

  const response: any = await octokit.graphql(query, variables);

  // Process the results
  const updates = filesToFetch.map((file, index) => {
    const fileData = response.repository[`file${index}`];
    return {
      path: file.path,
      parentPath: path.dirname(file.path),
      content: fileData.text,
      sha: fileData.oid,
      lastUpdated: Date.now()
    };
  });

  // Batch update the cache
  for (const update of updates) {
    const isModified = modifiedFiles.some(f => f.path === update.path);
    
    if (isModified) {
      // Update existing entry
      await db.update(cachedEntriesTable)
        .set({
          content: update.content,
          sha: update.sha,
          lastUpdated: update.lastUpdated
        })
        .where(
          and(
            eq(cachedEntriesTable.owner, owner),
            eq(cachedEntriesTable.repo, repo),
            eq(cachedEntriesTable.branch, branch),
            eq(cachedEntriesTable.path, update.path)
          )
        );
    } else {
      // Insert new entry
      await db.insert(cachedEntriesTable)
        .values({
          owner,
          repo,
          branch,
          path: update.path,
          parentPath: update.parentPath,
          name: path.basename(update.path),
          type: 'blob',
          content: update.content,
          sha: update.sha,
          lastUpdated: update.lastUpdated
        });
    }
  }
}

const getCachedCollection = async (
  owner: string,
  repo: string,
  branch: string,
  path: string,
  token: string
) => {
  let entries = await db.query.cachedEntriesTable.findMany({
    where: and(
      eq(cachedEntriesTable.owner, owner),
      eq(cachedEntriesTable.repo, repo),
      eq(cachedEntriesTable.branch, branch),
      eq(cachedEntriesTable.parentPath, path)
    )
  });

  if (entries.length === 0) {
    // No cache hit, fetch from GitHub
    const octokit = createOctokitInstance(token);
    const query = `
      query ($owner: String!, $repo: String!, $expression: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $expression) {
            ... on Tree {
              entries {
                name
                path
                type
                object {
                  ... on Blob {
                    text
                    oid
                  }
                }
              }
            }
          }
        }
      }
    `;
    const expression = `${branch}:${path}`;
    const response: any = await octokit.graphql(query, {
      owner: owner,
      repo: repo,
      expression
    });
    // TODO: handle 401 / Bad credentials error

    let githubEntries = response.repository?.object?.entries || [];

    if (githubEntries.length > 0) {
      entries = await db.insert(cachedEntriesTable)
        .values(githubEntries.map((entry: any) => ({
          owner: owner,
          repo: repo,
          branch: branch,
          parentPath: path,
          name: entry.name,
          path: entry.path,
          type: entry.type,
          content: entry.type === "blob" ? entry.object.text : null,
          sha: entry.type === "blob" ? entry.object.oid : null,
          lastUpdated: Date.now()
        })))
        .returning();
    }
  }

  return entries;
}

export { updateCache, getCachedCollection };