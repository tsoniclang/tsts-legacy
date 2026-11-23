import type { Context } from "../../go/context.js";
import { WithValue } from "../../go/context.js";
import type { Checker } from "./checker/state.js";

export type NativeCheckerCost = "work" | "retained";
export type NativeCheckerAdmission<Stop extends object> = (cost: NativeCheckerCost, units: number) => Stop | null;

export type NativeCheckerResult<Value, Stop extends object> =
  | { readonly kind: "complete"; readonly value: Value }
  | { readonly kind: "refused"; readonly stop: Stop }
  | { readonly kind: "unavailable" };

const admissionKey = Symbol("native checker acquisition");

class AcquisitionAdmission {
  provisional = false;

  constructor(readonly admit: (cost: NativeCheckerCost, units: number) => void) {}
}

export function admitNativeChecker(checker: Checker | undefined, cost: NativeCheckerCost, units = 1): void {
  const admission = checker?.ctx?.Value(admissionKey);
  if (admission instanceof AcquisitionAdmission && units !== 0) admission.admit(cost, units);
}

export function markNativeCheckerProvisional(checker: Checker | undefined): void {
  const admission = checker?.ctx?.Value(admissionKey);
  if (admission instanceof AcquisitionAdmission) admission.provisional = true;
}

export function runNativeCheckerAcquisition<Value, Stop extends object>(
  checker: Checker, context: Context, admit: NativeCheckerAdmission<Stop>, terminate: () => void,
  read: () => Value,
): NativeCheckerResult<Value, Stop> {
  const prior = checker.ctx;
  if (prior?.Value(admissionKey) instanceof AcquisitionAdmission) {
    throw new Error("A checked acquisition cannot nest its owning admission scope.");
  }
  const abandoned = {};
  let refusal: Stop | null = null;
  const admission = new AcquisitionAdmission((cost, units) => {
    refusal ??= admit(cost, units);
    if (refusal !== null) throw abandoned;
  });
  checker.ctx = WithValue(context, admissionKey, admission);
  try {
    return { kind: "complete", value: read() };
  } catch (error: unknown) {
    if (error !== abandoned || refusal === null) throw error;
    if (admission.provisional) terminate();
    return { kind: "refused", stop: refusal };
  } finally {
    checker.ctx = prior;
  }
}
