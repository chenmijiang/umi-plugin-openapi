import fs from "fs";
import path from "path";

import type { GenerateServiceProps } from "./types";
import { formatFile } from "./util";

export interface GeneratedFile {
  relativePath: string;
  content: string;
}

export function validateGeneratedFiles(files: GeneratedFile[]): void {
  const names = new Map<string, string>();
  for (const file of files) {
    const name = file.relativePath;
    if (
      !name ||
      name.includes("\0") ||
      name.includes("\\") ||
      path.isAbsolute(name) ||
      path.win32.isAbsolute(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`[openAPI]: Invalid generated file path: ${JSON.stringify(name)}`);
    }
    const key = name.normalize("NFC").toLowerCase();
    if (names.has(key)) {
      throw new Error(`[openAPI]: Duplicate generated file paths: ${names.get(key)} and ${name}`);
    }
    names.set(key, name);
  }
  for (const [key, name] of names) {
    let parent = path.dirname(key);
    while (parent !== ".") {
      if (names.has(parent)) {
        throw new Error(
          `[openAPI]: Conflicting generated file paths: ${names.get(parent)} and ${name}`,
        );
      }
      parent = path.dirname(parent);
    }
  }
}

function stat(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireDirectory(directory: string): void {
  const entry = stat(directory);
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error(`[openAPI]: Output directory is not a regular directory: ${directory}`);
  }
}

function prepareParents(directory: string, relativePath: string): void {
  let parent = directory;
  for (const part of relativePath.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    requireDirectory(parent);
    fs.mkdirSync(parent, { recursive: true });
  }
}

function stageFiles(
  directory: string,
  stage: string,
  files: GeneratedFile[],
  formatter: GenerateServiceProps["formatter"],
): boolean {
  let hasFormattingError = false;
  const reportedFormatters = new Set<string>();
  for (const file of files) {
    const [content, hasError, formatterName] = formatFile(
      file.content,
      path.resolve(directory, file.relativePath),
      formatter || "auto",
    );
    if (!reportedFormatters.has(formatterName)) {
      console.log(`[openAPI]: Formatter: ${formatterName}`);
      reportedFormatters.add(formatterName);
    }
    hasFormattingError = hasError || hasFormattingError;
    prepareParents(stage, file.relativePath);
    const destination = path.join(stage, file.relativePath);
    const existing = stat(destination);
    if (existing?.isSymbolicLink()) {
      fs.unlinkSync(destination);
    }
    fs.writeFileSync(destination, content, "utf8");
  }
  return hasFormattingError;
}

function publicationDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) {
    throw new Error("[openAPI]: The filesystem root cannot be a generated output directory");
  }
  requireDirectory(resolved);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function reportPublication(kind: "Service" | "Mock", hasFormattingError: boolean): void {
  if (hasFormattingError) {
    console.warn(
      `[openAPI]: ${kind} files generated with formatting errors; unformatted content preserved`,
    );
  } else {
    console.log(`[openAPI]: ${kind} files generated`);
  }
}

export function publishServiceFiles(
  directory: string,
  files: GeneratedFile[],
  formatter?: GenerateServiceProps["formatter"],
): void {
  directory = publicationDirectory(directory);
  const stage = fs.mkdtempSync(
    path.join(path.dirname(directory), `.${path.basename(directory)}-stage-`),
  );
  const backup = `${stage}-backup`;
  let backedUp = false;
  try {
    if (stat(directory)) {
      for (const name of fs.readdirSync(directory)) {
        if (name.startsWith(".") || name.includes("_deperated")) {
          fs.cpSync(path.join(directory, name), path.join(stage, name), { recursive: true });
        }
      }
    }
    const hasFormattingError = stageFiles(directory, stage, files, formatter);
    if (stat(directory)) {
      fs.renameSync(directory, backup);
      backedUp = true;
    }
    try {
      fs.renameSync(stage, directory);
    } catch (error) {
      if (backedUp) {
        try {
          fs.renameSync(backup, directory);
          backedUp = false;
        } catch (restoreError) {
          throw new Error(
            `[openAPI]: Service publication failed: ${String(error)}; restore failed: ${String(restoreError)}; backup retained at ${backup}`,
          );
        }
      }
      throw error;
    }
    if (backedUp) {
      try {
        fs.rmSync(backup, { recursive: true });
      } catch (error) {
        console.warn(
          `[openAPI]: Service files published, but backup cleanup failed at ${backup}:`,
          error,
        );
      }
    }
    reportPublication("Service", hasFormattingError);
  } finally {
    // A backup left by a failed restore is deliberately retained for recovery.
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[openAPI]: Service staging cleanup failed at ${stage}:`, error);
    }
  }
}

export function publishMockFiles(
  directory: string,
  files: GeneratedFile[],
  formatter?: GenerateServiceProps["formatter"],
): void {
  directory = publicationDirectory(directory);
  const workspace = fs.mkdtempSync(
    path.join(path.dirname(directory), `.${path.basename(directory)}-stage-`),
  );
  const stage = path.join(workspace, "files");
  const backup = path.join(workspace, "backup");
  const changed: { relativePath: string; hadPrevious: boolean; installed: boolean }[] = [];
  let rollbackFailed = false;
  try {
    fs.mkdirSync(stage);
    const hasFormattingError = stageFiles(directory, stage, files, formatter);
    fs.mkdirSync(directory, { recursive: true });
    try {
      for (const file of files) {
        prepareParents(directory, file.relativePath);
        const destination = path.join(directory, file.relativePath);
        const existing = stat(destination);
        if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
          throw new Error(`[openAPI]: Mock output is not a file: ${destination}`);
        }
        const change = { relativePath: file.relativePath, hadPrevious: false, installed: false };
        changed.push(change);
        if (existing) {
          prepareParents(backup, file.relativePath);
          fs.mkdirSync(backup, { recursive: true });
          fs.renameSync(destination, path.join(backup, file.relativePath));
          change.hadPrevious = true;
        }
        fs.renameSync(path.join(stage, file.relativePath), destination);
        change.installed = true;
      }
    } catch (error) {
      const failures: string[] = [];
      for (const change of changed.reverse()) {
        try {
          const destination = path.join(directory, change.relativePath);
          if (change.installed) fs.unlinkSync(destination);
          if (change.hadPrevious)
            fs.renameSync(path.join(backup, change.relativePath), destination);
        } catch (restoreError) {
          failures.push(String(restoreError));
        }
      }
      if (failures.length) {
        rollbackFailed = true;
        throw new Error(
          `[openAPI]: Mock publication failed: ${String(error)}; rollback failed: ${failures.join("; ")}; backup retained at ${backup}`,
        );
      }
      throw error;
    }
    reportPublication("Mock", hasFormattingError);
  } finally {
    if (!rollbackFailed) {
      try {
        fs.rmSync(workspace, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[openAPI]: Mock staging cleanup failed at ${workspace}:`, error);
      }
    }
  }
}
