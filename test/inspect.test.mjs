import assert from "node:assert/strict";
import { test } from "node:test";
import { createInspectService } from "../mcp-server/inspect.mjs";

const { normalizeInspectOptions, projectInspection, fullInspectCache, cacheKey } =
  createInspectService("/tmp/project");

const sampleFull = {
  fileName: "hero.riv",
  sizeBytes: 4096,
  artboards: [
    {
      name: "Main",
      size: { width: 100, height: 200 },
      bounds: { x: 0, y: 0, width: 100, height: 200 },
      animations: [{ name: "idle" }],
      stateMachines: [{ name: "State Machine 1", inputs: [] }],
    },
    {
      name: "Alt",
      size: { width: 50, height: 50 },
      bounds: { x: 0, y: 0, width: 50, height: 50 },
      animations: [],
      stateMachines: [],
    },
  ],
};

test("projectInspection filters artboards and supports summary mode", () => {
  const one = projectInspection(sampleFull, {
    ...normalizeInspectOptions({ artboardName: "Main" }),
  });
  assert.equal(one.artboards.length, 1);
  assert.equal(one.artboards[0].name, "Main");
  assert.equal(one.artboards[0].animations.length, 1);

  const summary = projectInspection(sampleFull, normalizeInspectOptions({ summary: true }));
  assert.deepEqual(summary.artboards[0], {
    name: "Main",
    size: sampleFull.artboards[0].size,
    bounds: sampleFull.artboards[0].bounds,
    animationCount: 1,
    stateMachineCount: 1,
  });

  assert.throws(
    () =>
      projectInspection(sampleFull, normalizeInspectOptions({ artboardName: "Missing" })),
    /No artboard named/
  );
});

test("fullInspectCache reuses entries for the same resolved file identity", () => {
  fullInspectCache.clear();
  const key = cacheKey("/tmp/project/hero.riv", { mtimeMs: 100, size: 4096 });
  fullInspectCache.set(key, sampleFull);

  const projected = projectInspection(fullInspectCache.get(key), normalizeInspectOptions({}));
  assert.equal(projected.fileName, "hero.riv");
  assert.equal(fullInspectCache.size, 1);
});