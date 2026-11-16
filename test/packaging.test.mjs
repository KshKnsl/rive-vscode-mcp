import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listVsixRivPaths() {
  const output = execFileSync("npx", ["-y", "@vscode/vsce", "ls"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".riv"));
}

function listNpmPackRivPaths() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: path.join(repositoryRoot, "mcp-server"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packed = JSON.parse(output)[0]?.files ?? [];
  return packed
    .map((entry) => entry.path)
    .filter((filePath) => filePath.endsWith(".riv"));
}

test("VSIX package excludes all .riv files", () => {
  const rivFiles = listVsixRivPaths();
  assert.deepEqual(
    rivFiles,
    [],
    `expected no .riv files in VSIX listing, found:\n${rivFiles.join("\n")}`
  );
});

test("npm package for rive-vscode-mcp-server excludes all .riv files", () => {
  const rivFiles = listNpmPackRivPaths();
  assert.deepEqual(
    rivFiles,
    [],
    `expected no .riv files in npm pack, found:\n${rivFiles.join("\n")}`
  );
});