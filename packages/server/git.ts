/**
 * Git utilities for code review
 *
 * Centralized git operations for diff collection and branch detection.
 * Used by both Claude Code hook and OpenCode plugin.
 */

import { $ } from "bun";
import { readFile } from "fs/promises";
import { join } from "path";

export type DiffType =
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "branch";

export interface DiffOption {
  id: DiffType | "separator";
  label: string;
}

export interface GitContext {
  currentBranch: string;
  defaultBranch: string;
  diffOptions: DiffOption[];
}

export interface DiffResult {
  patch: string;
  label: string;
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(): Promise<string> {
  try {
    const result = await $`git rev-parse --abbrev-ref HEAD`.quiet();
    return result.text().trim();
  } catch {
    return "HEAD"; // Detached HEAD state
  }
}

/**
 * Detect the default branch (main, master, etc.)
 *
 * Strategy:
 * 1. Check origin's HEAD reference
 * 2. Fallback to checking if 'main' exists
 * 3. Final fallback to 'master'
 */
export async function getDefaultBranch(): Promise<string> {
  // Try origin's HEAD first (most reliable for repos with remotes)
  try {
    const result =
      await $`git symbolic-ref refs/remotes/origin/HEAD`.quiet();
    const ref = result.text().trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // No remote or no HEAD set - check local branches
  }

  // Fallback: check if main exists locally
  try {
    await $`git show-ref --verify refs/heads/main`.quiet();
    return "main";
  } catch {
    // main doesn't exist
  }

  // Final fallback
  return "master";
}

/**
 * Get git context including branch info and available diff options
 */
export async function getGitContext(): Promise<GitContext> {
  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranch(),
    getDefaultBranch(),
  ]);

  const diffOptions: DiffOption[] = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "last-commit", label: "Last commit" },
  ];

  // Only show branch diff if not on default branch
  if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "branch", label: `vs ${defaultBranch}` });
  }

  return { currentBranch, defaultBranch, diffOptions };
}

/**
 * Get untracked files (new files not yet added to git)
 */
async function getUntrackedFiles(): Promise<string[]> {
  try {
    const result =
      await $`git ls-files --others --exclude-standard`.quiet();
    const files = result.text().trim();
    return files ? files.split("\n") : [];
  } catch {
    return [];
  }
}

/**
 * Generate a diff-style patch for an untracked (new) file
 */
async function generateNewFilePatch(filePath: string): Promise<string> {
  try {
    const cwd = process.cwd();
    const fullPath = join(cwd, filePath);
    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n");

    // Build a git diff style patch for a new file
    const header = [
      `diff --git a/${filePath} b/${filePath}`,
      `new file mode 100644`,
      `--- /dev/null`,
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
    ].join("\n");

    const body = lines.map((line) => `+${line}`).join("\n");

    return header + "\n" + body;
  } catch (error) {
    console.error(`Error reading untracked file ${filePath}:`, error);
    return "";
  }
}

/**
 * Get patches for all untracked files
 */
async function getUntrackedFilePatches(): Promise<string> {
  const untrackedFiles = await getUntrackedFiles();
  if (untrackedFiles.length === 0) return "";

  const patches = await Promise.all(
    untrackedFiles.map((file) => generateNewFilePatch(file))
  );

  return patches.filter(Boolean).join("\n");
}

/**
 * Run git diff with the specified type
 */
export async function runGitDiff(
  diffType: DiffType,
  defaultBranch: string = "main"
): Promise<DiffResult> {
  let patch: string;
  let label: string;

  try {
    switch (diffType) {
      case "uncommitted": {
        const trackedDiff = (await $`git diff HEAD`.quiet()).text();
        const untrackedPatches = await getUntrackedFilePatches();
        patch = trackedDiff + (untrackedPatches ? "\n" + untrackedPatches : "");
        label = "Uncommitted changes";
        break;
      }

      case "staged":
        patch = (await $`git diff --staged`.quiet()).text();
        label = "Staged changes";
        break;

      case "unstaged": {
        const unstagedDiff = (await $`git diff`.quiet()).text();
        const untrackedPatches = await getUntrackedFilePatches();
        patch = unstagedDiff + (untrackedPatches ? "\n" + untrackedPatches : "");
        label = "Unstaged changes";
        break;
      }

      case "last-commit":
        patch = (await $`git diff HEAD~1..HEAD`.quiet()).text();
        label = "Last commit";
        break;

      case "branch": {
        const branchDiff = (await $`git diff ${defaultBranch}..HEAD`.quiet()).text();
        const untrackedPatches = await getUntrackedFilePatches();
        patch = branchDiff + (untrackedPatches ? "\n" + untrackedPatches : "");
        label = `Changes vs ${defaultBranch}`;
        break;
      }

      default:
        patch = "";
        label = "Unknown diff type";
    }
  } catch (error) {
    // Handle errors gracefully (e.g., no commits yet, invalid ref)
    console.error(`Git diff error for ${diffType}:`, error);
    patch = "";
    label = `Error: ${diffType}`;
  }

  return { patch, label };
}
