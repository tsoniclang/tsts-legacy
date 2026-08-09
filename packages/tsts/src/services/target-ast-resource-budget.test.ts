import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
  maximumEncodedBytes: 8,
});

test("target AST resource budgets accept every exact finite boundary", () => {
  const budget = new TargetAstResourceBudget(limits);
  budget.reserveNodeRows(2);
  budget.requireDepth(2);
  budget.reserveString(2);
  budget.reserveString(2);
  budget.reserveExtendedWords(2);
  budget.reserveStructuredBytes(2);
  budget.requireEncodedBytes(8);
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
    ["encoded size", (budget) => budget.requireEncodedBytes(9)],
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
