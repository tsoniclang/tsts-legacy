import type { Node } from "../internal/ast/ast.js";
import { getExtensionFactKeyIdentity, type ExtensionFactKey } from "./fact-key.js";
import { encodeIdentityTuple } from "./identity-tuple.js";
import { snapshotProviderBoundaryData, formatProviderBoundarySnapshotFailure } from "./provider-boundary-data.js";
import { SourceElaborationAnchors, type SourceElaborationAnchor } from "./source-elaboration-anchors.js";
import { SourceElaborationBudget } from "./source-elaboration-budget.js";
import {
  defaultSourceElaborationLimits,
  snapshotSourceElaborationLimits,
  type SourceElaborationLimits,
  type SourceElaborationNodeReference,
  type SourceElaborationRequest,
} from "./source-elaboration-model.js";
import type { SourceProgramQueries } from "./source-program.js";

interface StoredRequest {
  readonly anchor: SourceElaborationAnchor;
  readonly key: ExtensionFactKey<unknown>;
}

interface StoredAnswer {
  readonly request: StoredRequest;
  readonly value: unknown;
  readonly rows: number;
  readonly codeUnits: number;
}

interface ReplayData {
  readonly requests: ReadonlyMap<string, StoredRequest>;
  readonly answers: ReadonlyMap<string, StoredAnswer>;
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly references: ReadonlyMap<number, SourceElaborationAnchor>;
}

const suspensionRounds = new WeakMap<object, SourceElaborationRound>();
let nextSession = 0;

export class SourceElaborationCoordinator {
  readonly #limits: SourceElaborationLimits;
  readonly #session: number;
  #revision = 0;
  #data: ReplayData = emptyReplayData();
  #inputs: ReadonlyMap<string, string> | undefined;
  #active: SourceElaborationRound | undefined;
  #rounds = 0;
  #sealed = false;
  #failed = false;

  constructor(limits: SourceElaborationLimits = defaultSourceElaborationLimits) {
    this.#limits = snapshotSourceElaborationLimits(limits);
    if (nextSession === Number.MAX_SAFE_INTEGER) throw new Error("Source elaboration session identity capacity is exhausted.");
    this.#session = ++nextSession;
  }

  beginRound(source: SourceProgramQueries): SourceElaborationRound {
    if (this.#sealed || this.#failed || this.#active !== undefined) {
      throw new Error("Source elaboration cannot start a round in its current state.");
    }
    if (++this.#rounds > this.#limits.maximumRounds) {
      this.#failed = true;
      throw new Error("Source elaboration exceeds its bounded replay budget.");
    }
    const budget = new SourceElaborationBudget(this.#limits);
    for (const answer of this.#data.answers.values()) budget.reserve(answer.rows, answer.codeUnits);
    const anchors = new SourceElaborationAnchors(source, this.#limits.maximumAnchorDepth, budget,
      [...this.#data.requests.values()].map(request => request.anchor).concat([...this.#data.references.values()]));
    const inputs = anchors.sourceInputs();
    if (this.#inputs !== undefined && !sameSourceInputs(this.#inputs, inputs)) {
      this.#failed = true;
      throw new Error("Source elaboration cannot reuse evidence after its source inputs changed.");
    }
    this.#inputs = inputs;
    this.#active = new SourceElaborationRound(anchors, this.#limits, this.#data, this.#session, this.#revision, budget);
    return this.#active;
  }

  finishRound(round: SourceElaborationRound, providerRevisionChanged: boolean): void {
    this.#requireActive(round);
    try {
      const completed = round.finish();
      if (providerRevisionChanged) {
        this.#revision += 1;
        this.#inputs = undefined;
        this.#data = emptyReplayData();
      } else {
        if (completed.requests.size === this.#data.requests.size && completed.answers.size === this.#data.answers.size &&
            dependencyCount(completed) === dependencyCount(this.#data)) {
          throw new Error(`Source elaboration made no progress; cyclic or unresolved demands: ${round.pendingDescriptions().join(", ")}.`);
        }
        this.#data = completed;
      }
      this.#active = undefined;
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  seal(round: SourceElaborationRound): void {
    this.#requireActive(round);
    round.seal();
    this.#active = undefined;
    this.#sealed = true;
  }

  #requireActive(round: SourceElaborationRound): void {
    if (this.#active !== round || this.#failed || this.#sealed) {
      throw new Error("Source elaboration rounds must complete in creation order.");
    }
  }
}

export class SourceElaborationRound {
  readonly #anchors: SourceElaborationAnchors;
  readonly #limits: SourceElaborationLimits;
  readonly #requests: Map<string, StoredRequest>;
  readonly #answers: ReadonlyMap<string, StoredAnswer>;
  readonly #dependencies: Map<string, Set<string>>;
  readonly #published = new Map<string, StoredAnswer>();
  readonly #session: number;
  readonly #revision: number;
  readonly #references: Map<number, SourceElaborationAnchor>;
  readonly #referenceIds: Map<string, number>;
  readonly #budget: SourceElaborationBudget;
  #resolving: string | undefined;
  #suspension: Error | undefined;
  #dependencyCount = 0;
  #state: "active" | "finished" | "sealed" | "failed" = "active";

  constructor(anchors: SourceElaborationAnchors, limits: SourceElaborationLimits, data: ReplayData, session: number, revision: number,
    budget: SourceElaborationBudget) {
    this.#anchors = anchors;
    this.#limits = limits;
    this.#budget = budget;
    this.#requests = new Map(data.requests);
    this.#answers = data.answers;
    this.#session = session;
    this.#revision = revision;
    this.#references = new Map(data.references);
    this.#referenceIds = new Map([...data.references].map(([id, anchor]) => [anchor.id, id]));
    this.#dependencies = new Map([...data.dependencies].map(([id, dependencies]) => [id, new Set(dependencies)]));
    for (const dependencies of this.#dependencies.values()) this.#dependencyCount += dependencies.size;
  }

  request<T>(node: Node, key: ExtensionFactKey<T>): void {
    this.#assertActive();
    getExtensionFactKeyIdentity(key);
    const anchor = this.#anchors.reference(node);
    const id = requestId(anchor, key);
    if (this.#requests.has(id)) return;
    if (this.#requests.size >= this.#limits.maximumRequests) {
      this.#fail("Source elaboration exceeds its request budget.");
    }
    this.#requests.set(id, Object.freeze({ anchor, key: key as ExtensionFactKey<unknown> }));
  }

  reference(node: Node): SourceElaborationNodeReference {
    this.#assertActive();
    const anchor = this.#anchors.reference(node);
    let id = this.#referenceIds.get(anchor.id);
    if (id === undefined) {
      if (this.#references.size >= this.#limits.maximumReferences) this.#fail("Source elaboration exceeds its reference budget.");
      id = this.#references.size;
      this.#references.set(id, anchor);
      this.#referenceIds.set(anchor.id, id);
    }
    return Object.freeze({ session: this.#session, revision: this.#revision, id });
  }

  resolveReference(reference: SourceElaborationNodeReference): Node {
    this.#assertActive();
    if (reference === null || typeof reference !== "object" || Reflect.ownKeys(reference).length !== 3 ||
        Object.getPrototypeOf(reference) !== Object.prototype && Object.getPrototypeOf(reference) !== null) {
      return this.#fail("Source elaboration reference must be an exact issued data record.");
    }
    const fields = ["session", "revision", "id"] as const;
    const values = fields.map(field => {
      const descriptor = Object.getOwnPropertyDescriptor(reference, field);
      const value: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        return this.#fail("Source elaboration reference has an invalid identity field.");
      }
      return value;
    });
    if (values[0] !== this.#session || values[1] !== this.#revision) {
      return this.#fail("Source elaboration reference belongs to a different session or input revision.");
    }
    const anchor = this.#references.get(values[2]!);
    if (anchor === undefined) return this.#fail("Source elaboration reference was not issued by this session.");
    return this.#anchors.resolve(anchor);
  }

  require<T>(node: Node, key: ExtensionFactKey<T>): T {
    getExtensionFactKeyIdentity(key);
    const id = requestId(this.#anchors.reference(node), key);
    if (this.#state === "sealed") {
      const answer = this.#answers.get(id);
      if (answer === undefined) throw new Error("Sealed source elaboration cannot accept a new demand.");
      return answer.value as T;
    }
    this.request(node, key);
    if (this.#resolving !== undefined) this.#recordDependency(this.#resolving, id);
    const answer = this.#answers.get(id);
    if (answer !== undefined) return answer.value as T;
    const suspension = new Error("Source semantic query requires elaboration in a fresh compiler epoch.");
    this.#suspension = suspension;
    suspensionRounds.set(suspension, this);
    throw suspension;
  }

  resolve(request: SourceElaborationRequest, resolver: () => unknown): void {
    this.#assertActive();
    const id = requestId(this.#anchors.reference(request.node), request.key);
    if (!this.#requests.has(id) || this.#answers.has(id) || this.#published.has(id) || this.#resolving !== undefined) {
      this.#fail("Source elaboration must resolve one pending registered demand at a time.");
    }
    this.#resolving = id;
    try {
      const value = resolver();
      this.#assertActive();
      const snapshot = snapshotProviderBoundaryData(request.key.snapshot(value), "sourceElaboration.value");
      if (snapshot.kind === "invalid") this.#fail(formatProviderBoundarySnapshotFailure(snapshot));
      const rows = snapshot.physicalNodeAndCollectionEntryCount;
      const codeUnits = snapshot.scalarCodeUnits;
      this.#budget.reserve(rows, codeUnits);
      this.#published.set(id, Object.freeze({ request: this.#requests.get(id)!, value: snapshot.value, rows, codeUnits }));
    } catch (error) {
      if (!isSourceElaborationSuspension(error, this)) this.#state = "failed";
      throw error;
    } finally {
      this.#resolving = undefined;
    }
  }

  ready(): readonly SourceElaborationRequest[] {
    this.#assertActive();
    return Object.freeze([...this.#requests].filter(([id]) =>
      !this.#answers.has(id) && !this.#published.has(id) &&
      [...(this.#dependencies.get(id) ?? [])].every(dependency => this.#answers.has(dependency)))
      .map(([, request]) => Object.freeze({ node: this.#anchors.resolve(request.anchor), key: request.key })));
  }

  accepted(): readonly { readonly node: Node; readonly key: ExtensionFactKey<unknown>; readonly value: unknown }[] {
    this.#assertActive();
    return Object.freeze([...this.#answers.values()].map(answer => Object.freeze({
      node: this.#anchors.resolve(answer.request.anchor), key: answer.request.key, value: answer.value,
    })));
  }

  needsReplay(): boolean {
    return this.#published.size !== 0 || [...this.#requests.keys()].some(id => !this.#answers.has(id));
  }

  assertNotSuspended(): void {
    if (this.#suspension !== undefined) throw this.#suspension;
  }

  pendingDescriptions(): readonly string[] {
    return [...this.#requests].filter(([id]) => !this.#answers.has(id)).slice(0, 16)
      .map(([, request]) => `${request.key.id} at ${request.anchor.fileName}:${request.anchor.pos}`);
  }

  finish(): ReplayData {
    if (this.#state !== "active" || this.#resolving !== undefined) {
      throw new Error("Source elaboration can only finish an active, unwound epoch.");
    }
    this.#state = "finished";
    return Object.freeze({
      requests: this.#requests,
      answers: new Map([...this.#answers, ...this.#published]),
      dependencies: this.#dependencies,
      references: this.#references,
    });
  }

  seal(): void {
    this.#assertActive();
    if (this.needsReplay()) this.#fail("Source elaboration cannot seal before every answer is checked in a fresh epoch.");
    this.#state = "sealed";
  }

  #recordDependency(from: string, to: string): void {
    const dependencies = this.#dependencies.get(from) ?? new Set<string>();
    if (dependencies.has(to)) return;
    if (this.#dependencyCount >= this.#limits.maximumDependencies) this.#fail("Source elaboration exceeds its dependency budget.");
    this.#dependencyCount += 1;
    dependencies.add(to);
    this.#dependencies.set(from, dependencies);
  }

  #assertActive(): void {
    if (this.#state !== "active") throw new Error(`Source elaboration round is ${this.#state}.`);
    if (this.#suspension !== undefined) throw this.#suspension;
  }

  #fail(message: string): never {
    this.#state = "failed";
    throw new Error(message);
  }
}

export function isSourceElaborationSuspension(error: unknown, round: SourceElaborationRound): boolean {
  return typeof error === "object" && error !== null && suspensionRounds.get(error) === round;
}

function requestId(anchor: SourceElaborationAnchor, key: { readonly id: string }): string {
  return encodeIdentityTuple([anchor.id, key.id]);
}

function emptyReplayData(): ReplayData {
  return { requests: new Map(), answers: new Map(), dependencies: new Map(), references: new Map() };
}

function dependencyCount(data: ReplayData): number {
  let count = 0;
  for (const dependencies of data.dependencies.values()) count += dependencies.size;
  return count;
}

function sameSourceInputs(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([fileName, text]) => right.get(fileName) === text);
}
