import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createInspectService } from "../mcp-server/inspect.mjs";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "rive-inspect-integration-"));
const projectDirectory = path.join(temporaryDirectory, "project");
let resolvedProjectDirectory;

before(async () => {
  await mkdir(projectDirectory, { recursive: true });
  resolvedProjectDirectory = await realpath(projectDirectory);
});

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function createLocalService() {
  return createInspectService(resolvedProjectDirectory);
}

test("resolveRiveFile rejects empty paths and non-riv extensions", async () => {
  await writeFile(path.join(projectDirectory, "notes.txt"), "not a riv");
  const { inspectRiveFile } = createLocalService();

  await assert.rejects(() => inspectRiveFile(""), /non-empty path/);
  await assert.rejects(() => inspectRiveFile("   "), /non-empty path/);
  await assert.rejects(() => inspectRiveFile("notes.txt"), /\.riv extension/);
});

test("resolveRiveFile rejects missing files and directories", async () => {
  const { inspectRiveFile } = createLocalService();

  await assert.rejects(() => inspectRiveFile("missing.riv"), /ENOENT|no such file/i);

  await mkdir(path.join(projectDirectory, "folder.riv"), { recursive: true });
  await assert.rejects(() => inspectRiveFile("folder.riv"), /not a file/);
});

test("resolveRiveFile rejects paths outside the configured root", async () => {
  const outsideDirectory = path.join(temporaryDirectory, "outside");
  const outsideFile = path.join(outsideDirectory, "leak.riv");
  await mkdir(outsideDirectory, { recursive: true });
  await writeFile(outsideFile, "outside");

  const { inspectRiveFile } = createLocalService();
  await assert.rejects(() => inspectRiveFile("../outside/leak.riv"), /inside the configured Rive project root/);

  const linkPath = path.join(projectDirectory, "linked.riv");
  try {
    await symlink(outsideFile, linkPath);
    await assert.rejects(() => inspectRiveFile("linked.riv"), /inside the configured Rive project root/);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "ENOTSUP") {
      throw error;
    }
  }
});

test("failed inspections do not populate the in-memory cache", async () => {
  const rivPath = path.join(projectDirectory, "invalid-cache.riv");
  await writeFile(rivPath, "invalid");
  const service = createLocalService();

  await assert.rejects(() => service.inspectRiveFile("invalid-cache.riv"));
  await assert.rejects(() => service.inspectRiveFile("invalid-cache.riv"));
  assert.equal(service.fullInspectCache.size, 0);
});

test("projectInspection works after a failed load leaves the cache empty", async () => {
  const rivPath = path.join(projectDirectory, "fail-once.riv");
  await writeFile(rivPath, "invalid");
  const service = createLocalService();

  await assert.rejects(() => service.inspectRiveFile("fail-once.riv"));
  assert.equal(service.fullInspectCache.size, 0);

  const projected = service.projectInspection(
    {
      fileName: "fail-once.riv",
      sizeBytes: 7,
      artboards: [],
    },
    service.normalizeInspectOptions({ summary: true })
  );
  assert.deepEqual(projected.artboards, []);
});