import type { SourceElaborationLimits } from "./source-elaboration-model.js";

export class SourceElaborationBudget {
  readonly #limits: SourceElaborationLimits;
  #rows = 0;
  #codeUnits = 0;
  #failed = false;

  constructor(limits: SourceElaborationLimits) {
    this.#limits = limits;
  }

  reserve(rows: number, codeUnits: number): void {
    if (this.#failed || !Number.isSafeInteger(rows) || rows < 0 || !Number.isSafeInteger(codeUnits) || codeUnits < 0 ||
        rows > this.#limits.maximumDataRows - this.#rows ||
        codeUnits > this.#limits.maximumDataCodeUnits - this.#codeUnits) {
      this.#failed = true;
      throw new Error("Source elaboration exceeds its aggregate evidence budget.");
    }
    this.#rows += rows;
    this.#codeUnits += codeUnits;
  }
}
