import assert from "node:assert/strict";
import { test } from "node:test";
import { HEADER_SIZE, NODE_LEN } from "../internal/ast/generated/protocol.js";

import {
  defaultTargetAstEncodingLimits,
  TargetAstResourceBudget,
  type TargetAstEncodingLimits,
} from "./target-ast-resource-budget.js";

const limits: TargetAstEncodingLimits = Object.freeze({
  maximumNodeRows: 2,
  maximumDepth: 2,
  maximumStringCount: 2,
  maximumStringBytes: 4,
  maximumSingleStringBytes: 3,
  maximumExtendedWords: 2,
  maximumStructuredBytes: 2,
  maximumEncodedBytes: 130,
});

test("target AST resource budgets accept every exact finite boundary", () => {
  const budget = new TargetAstResourceBudget(limits);
  budget.reserveNodeRows(2);
  budget.requireDepth(2);
  budget.reserveString(2);
  budget.reserveString(2);
  budget.reserveExtendedWords(2);
  budget.reserveStructuredBytes(2);
  budget.requireEncodedBytes(130);
});

test("default target AST node-row budget is finite at its exact boundary", () => {
  const budget = new TargetAstResourceBudget(defaultTargetAstEncodingLimits);
  budget.reserveNodeRows(defaultTargetAstEncodingLimits.maximumNodeRows);
  assert.throws(
    () => budget.reserveNodeRows(1),
    /node rows .* exceeds limit 2097152/u,
  );
});

test("target AST resource budgets reject each independent dimension", () => {
  const cases: readonly [string, (budget: TargetAstResourceBudget) => void][] = [
    ["node rows", (budget) => budget.reserveNodeRows(3)],
    ["depth", (budget) => budget.requireDepth(3)],
    ["strings", (budget) => {
      budget.reserveString(1);
      budget.reserveString(1);
      budget.reserveString(1);
    }],
    ["string bytes", (budget) => {
      budget.reserveString(2);
      budget.reserveString(3);
    }],
    ["per-string", (budget) => budget.reserveString(4)],
    ["extended-data", (budget) => budget.reserveExtendedWords(3)],
    ["structured-data", (budget) => budget.reserveStructuredBytes(3)],
    ["encoded size", (budget) => budget.requireEncodedBytes(131)],
  ];
  for (const [subject, reserve] of cases) {
    assert.throws(
      () => reserve(new TargetAstResourceBudget(limits)),
      new RegExp(subject, "u"),
    );
  }
});

test("target AST resource budgets reject unsafe arithmetic and wire limits", () => {
  assert.throws(
    () => new TargetAstResourceBudget({
      ...limits,
      maximumEncodedBytes: 0x1_0000_0000,
    }),
    /uint32 wire-offset range/u,
  );
  const budget = new TargetAstResourceBudget(limits);
  assert.throws(
    () => budget.reserveNodeRows(Number.MAX_SAFE_INTEGER),
    /node rows/u,
  );
  assert.throws(
    () => budget.reserveStructuredBytes(-1),
    /non-negative safe integer/u,
  );
});

test("target AST accounting charges each wire component before retaining it", () => {
  const operations: readonly [(budget: TargetAstResourceBudget) => void, number][] = [
    [(budget) => budget.reserveNodeRows(1), NODE_LEN],
    [(budget) => budget.reserveString(3), 8 + 3],
    [(budget) => budget.reserveExtendedWords(2), 2 * 4],
    [(budget) => budget.reserveStructuredBytes(3), 3],
  ];
  for (const [operation, size] of operations) {
    const exact = new TargetAstResourceBudget({ ...defaultTargetAstEncodingLimits, maximumEncodedBytes: HEADER_SIZE + size });
    operation(exact);
    assert.throws(() => exact.reserveStructuredBytes(1), /encoded size/u);
    const insufficient = new TargetAstResourceBudget({ ...defaultTargetAstEncodingLimits, maximumEncodedBytes: HEADER_SIZE + size - 1 });
    assert.throws(() => operation(insufficient), /encoded size/u);
  }
  assert.throws(() => new TargetAstResourceBudget({ ...defaultTargetAstEncodingLimits, maximumEncodedBytes: HEADER_SIZE - 1 }), /encoded size/u);
});

test("budget selection snapshots mutable callers and rejects failed reservations atomically", () => {
  const selected = { ...limits };
  const budget = new TargetAstResourceBudget(selected);
  selected.maximumNodeRows = 100;
  selected.maximumStringBytes = 100;
  selected.maximumEncodedBytes = 1000;
  assert.throws(() => budget.reserveNodeRows(3), /node rows/u);
  budget.reserveNodeRows(2);
  budget.reserveString(2);
  assert.throws(() => budget.reserveString(3), /string bytes/u);
  budget.reserveString(2);
  budget.reserveExtendedWords(2);
  budget.reserveStructuredBytes(2);
  assert.throws(() => budget.reserveStructuredBytes(1), /structured-data bytes/u);
});
