import assert from "node:assert/strict";
import { test } from "node:test";

import { NewWorkGroup } from "../../dist/src/internal/core/workgroup.js";

test("single-threaded work groups drain large queues without stack growth", () => {
  const group = NewWorkGroup(true);
  const taskCount = 20_000;
  let completed = 0;

  for (let index = 0; index < taskCount; index += 1) {
    group.Queue(() => {
      completed += 1;
    });
  }

  group.RunAndWait();

  assert.equal(completed, taskCount);
  assert.throws(
    () => group.Queue(() => {}),
    /Queue called after RunAndWait returned/u,
  );
});

test("single-threaded work groups preserve Go stack order and drain nested work", () => {
  const group = NewWorkGroup(true);
  const completed = [];

  group.Queue(() => completed.push("first"));
  group.Queue(() => {
    completed.push("second");
    group.Queue(() => completed.push("nested"));
  });

  group.RunAndWait();

  assert.deepEqual(completed, ["second", "nested", "first"]);
});
