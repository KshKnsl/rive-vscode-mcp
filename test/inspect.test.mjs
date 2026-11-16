import assert from "node:assert/strict";
import { test } from "node:test";
import { createInspectService } from "../mcp-server/inspect.mjs";

const { normalizeInspectOptions, projectInspection, fullInspectCache, cacheKey, formatToolTextSummary } =
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

test("normalizeInspectOptions keeps defaults and ignores blank artboard names", () => {
  assert.deepEqual(normalizeInspectOptions({}), {
    artboardName: undefined,
    includeAnimations: true,
    includeStateMachines: true,
    summary: false,
  });
  assert.equal(normalizeInspectOptions({ artboardName: "  " }).artboardName, undefined);
  assert.equal(normalizeInspectOptions({ includeAnimations: false }).includeAnimations, false);
  assert.equal(normalizeInspectOptions({ includeStateMachines: false }).includeStateMachines, false);
  assert.equal(normalizeInspectOptions({ summary: true }).summary, true);
});

test("projectInspection filters artboards and supports summary mode", () => {
  const one = projectInspection(sampleFull, normalizeInspectOptions({ artboardName: "Main" }));
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
  assert.deepEqual(summary.artboards[1], {
    name: "Alt",
    size: sampleFull.artboards[1].size,
    bounds: sampleFull.artboards[1].bounds,
    animationCount: 0,
    stateMachineCount: 0,
  });

  assert.throws(
    () => projectInspection(sampleFull, normalizeInspectOptions({ artboardName: "Missing" })),
    /No artboard named/
  );
});

test("projectInspection can omit animations or state machines from the payload", () => {
  const withoutAnimations = projectInspection(
    sampleFull,
    normalizeInspectOptions({ includeAnimations: false })
  );
  assert.deepEqual(withoutAnimations.artboards[0].animations, []);
  assert.equal(withoutAnimations.artboards[0].stateMachines.length, 1);

  const withoutMachines = projectInspection(
    sampleFull,
    normalizeInspectOptions({ includeStateMachines: false })
  );
  assert.equal(withoutMachines.artboards[0].animations.length, 1);
  assert.deepEqual(withoutMachines.artboards[0].stateMachines, []);
});

test("formatToolTextSummary describes file size, artboard count, and names", () => {
  const text = formatToolTextSummary(sampleFull);
  assert.match(text, /^hero\.riv \(4096 bytes\): 2 artboards — Main, Alt\./);
  assert.match(text, /structuredContent/);

  const single = formatToolTextSummary({
    fileName: "solo.riv",
    sizeBytes: 10,
    artboards: [{ name: "Only" }],
  });
  assert.match(single, /1 artboard — Only\./);
});

test("cacheKey changes when modification time or size changes", () => {
  const filePath = "/tmp/project/hero.riv";
  assert.notEqual(
    cacheKey(filePath, { mtimeMs: 1, size: 10 }),
    cacheKey(filePath, { mtimeMs: 2, size: 10 })
  );
  assert.notEqual(
    cacheKey(filePath, { mtimeMs: 1, size: 10 }),
    cacheKey(filePath, { mtimeMs: 1, size: 11 })
  );
  assert.equal(
    cacheKey(filePath, { mtimeMs: 1, size: 10 }),
    cacheKey(filePath, { mtimeMs: 1, size: 10 })
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