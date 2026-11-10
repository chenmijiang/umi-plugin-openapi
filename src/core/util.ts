import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

import type { GenerateServiceProps } from "./types";

interface SyncPrettier {
  resolveConfig: { sync(filePath: string): Record<string, unknown> | null };
  format(content: string, options: Record<string, unknown>): string;
}

const hasOxfmt = (filePath: string): boolean => {
  const packagePath = path.join(process.cwd(), "package.json");
  if (fs.existsSync(packagePath)) {
    const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (
      manifest.dependencies?.oxfmt ||
      manifest.devDependencies?.oxfmt ||
      manifest.optionalDependencies?.oxfmt
    ) {
      return true;
    }
  }
  try {
    require.resolve("oxfmt", { paths: [process.cwd()] });
    return true;
  } catch {
    // Only resolve from the consuming project, not this plugin's dependencies.
  }
  const configNames = [
    ".oxfmtrc.json",
    ".oxfmtrc.jsonc",
    "oxfmt.config.ts",
    "oxfmt.config.mts",
    "oxfmt.config.cts",
    "oxfmt.config.js",
    "oxfmt.config.mjs",
    "oxfmt.config.cjs",
  ];
  for (let dir = path.dirname(filePath); ; dir = path.dirname(dir)) {
    if (configNames.some((name) => fs.existsSync(path.join(dir, name)))) {
      return true;
    }
    if (dir === path.dirname(dir)) {
      return false;
    }
  }
};

export const formatFile = (
  content: string,
  filePath: string,
  formatter: NonNullable<GenerateServiceProps["formatter"]>,
): [string, boolean, string] => {
  if (formatter === "none") {
    return [content, false, "none"];
  }
  let selected = formatter;
  try {
    if (selected === "auto") {
      selected = hasOxfmt(filePath) ? "oxfmt" : "prettier";
    }
    const name =
      typeof selected === "string"
        ? selected
        : [selected.external.command, ...selected.external.arguments].join(" ");
    if (selected === "prettier") {
      const prettier: SyncPrettier = require("prettier");
      return [
        prettier.format(content, {
          parser: "typescript",
          ...prettier.resolveConfig.sync(filePath),
          filepath: filePath,
        }),
        false,
        name,
      ];
    }
    const command = selected === "oxfmt" ? "oxfmt" : selected.external.command;
    const args =
      selected === "oxfmt"
        ? ["--stdin-filepath", filePath]
        : selected.external.arguments.map((argument) =>
            argument.split("{buffer_path}").join(filePath),
          );
    const binPaths: string[] = [];
    for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
      binPaths.push(path.join(dir, "node_modules", ".bin"));
      if (dir === path.dirname(dir)) {
        break;
      }
    }
    const result = spawnSync(command, args, {
      input: content,
      encoding: "utf8",
      env: { ...process.env, PATH: [...binPaths, process.env.PATH || ""].join(path.delimiter) },
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        [
          `Command ${JSON.stringify(command)} failed (status ${result.status}, signal ${result.signal})`,
          result.error?.message,
          result.stderr?.trim(),
        ]
          .filter(Boolean)
          .join(": "),
      );
    }
    return [result.stdout, false, name];
  } catch (error) {
    const name =
      typeof selected === "string"
        ? selected
        : [selected.external.command, ...selected.external.arguments].join(" ");
    console.warn(
      `[openAPI]: Formatter ${name} failed for ${filePath}; preserving unformatted content:`,
      error,
    );
    return [content, true, name];
  }
};

export const stripDot = (str: string): string => {
  return str.replace(/[-_ .](\w)/g, (_all, letter) => letter.toUpperCase());
};
