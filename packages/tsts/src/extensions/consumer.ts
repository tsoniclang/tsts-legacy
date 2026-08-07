import {
  argumentPassingFactKey,
  associatedTypeFactKey,
  attributeFactKey,
  canonicalIdentityFactKey,
  constGenericFactKey,
  defaultValueFactKey,
  fieldFactKey,
  flowStateFactKey,
  functionPointerFactKey,
  pointerFactKey,
  pointerOperationFactKey,
  providerTypeFamilyFactKey,
  providerVirtualDeclarationFactKey,
  sourcePrimitiveFactKey,
  structFactKey,
} from "./facts.js";
import type {
  ArgumentPassingFact,
  AssociatedTypeFact,
  AttributeFact,
  ConstGenericFact,
  DefaultValueFact,
  ExtensionCanonicalIdentity,
  FieldFact,
  FlowStateFact,
  FunctionPointerFact,
  PointerFact,
  PointerOperationFact,
  ProviderTypeFamilyFact,
  ProviderVirtualDeclarationFact,
  SourcePrimitiveFact,
  StructFact,
} from "./facts.js";
import type {
  ExtensionFactEntry,
  ExtensionFactKey,
  ExtensionFactSubject,
  ExtensionHost,
  ProviderVirtualDeclarationDocument,
} from "./host.js";

export interface ReadonlySourceFactResolver {
  getFact<T>(subject: ExtensionFactSubject | undefined, key: ExtensionFactKey<T>): T | undefined;
  getFacts(subject: ExtensionFactSubject | undefined): readonly ExtensionFactEntry<unknown>[];
  getVirtualDeclarationDocument(uriOrFileName: string): ProviderVirtualDeclarationDocument | undefined;
}

export class SourceFactQueries implements ReadonlySourceFactResolver {
  readonly #host: ExtensionHost;

  constructor(host: ExtensionHost) {
    if (!host.finalized) {
      throw new Error("Source fact queries require finalized source-extension semantics.");
    }
    this.#host = host;
  }

  getFact<T>(subject: ExtensionFactSubject | undefined, key: ExtensionFactKey<T>): T | undefined {
    return this.#host.facts.get(subject, key);
  }

  getFacts(subject: ExtensionFactSubject | undefined): readonly ExtensionFactEntry<unknown>[] {
    return this.#host.facts.entries(subject);
  }

  getVirtualDeclarationDocument(uriOrFileName: string): ProviderVirtualDeclarationDocument | undefined {
    return this.#host.providers.getVirtualDeclarationDocument(uriOrFileName);
  }

  getCanonicalIdentity(subject: ExtensionFactSubject | undefined): ExtensionCanonicalIdentity | undefined {
    return this.getFact(subject, canonicalIdentityFactKey);
  }

  getSourcePrimitive(subject: ExtensionFactSubject | undefined): SourcePrimitiveFact | undefined {
    return this.getFact(subject, sourcePrimitiveFactKey);
  }

  getArgumentPassing(subject: ExtensionFactSubject | undefined): ArgumentPassingFact | undefined {
    return this.getFact(subject, argumentPassingFactKey);
  }

  getFunctionPointer(subject: ExtensionFactSubject | undefined): FunctionPointerFact | undefined {
    return this.getFact(subject, functionPointerFactKey);
  }

  getPointer(subject: ExtensionFactSubject | undefined): PointerFact | undefined {
    return this.getFact(subject, pointerFactKey);
  }

  getPointerOperation(subject: ExtensionFactSubject | undefined): PointerOperationFact | undefined {
    return this.getFact(subject, pointerOperationFactKey);
  }

  getStruct(subject: ExtensionFactSubject | undefined): StructFact | undefined {
    return this.getFact(subject, structFactKey);
  }

  getField(subject: ExtensionFactSubject | undefined): FieldFact | undefined {
    return this.getFact(subject, fieldFactKey);
  }

  getFlowState(subject: ExtensionFactSubject | undefined): FlowStateFact | undefined {
    return this.getFact(subject, flowStateFactKey);
  }

  getAttribute(subject: ExtensionFactSubject | undefined): AttributeFact | undefined {
    return this.getFact(subject, attributeFactKey);
  }

  getDefaultValue(subject: ExtensionFactSubject | undefined): DefaultValueFact | undefined {
    return this.getFact(subject, defaultValueFactKey);
  }

  getAssociatedType(subject: ExtensionFactSubject | undefined): AssociatedTypeFact | undefined {
    return this.getFact(subject, associatedTypeFactKey);
  }

  getConstGeneric(subject: ExtensionFactSubject | undefined): ConstGenericFact | undefined {
    return this.getFact(subject, constGenericFactKey);
  }

  getProviderDeclaration(subject: ExtensionFactSubject | undefined): ProviderVirtualDeclarationFact | undefined {
    return this.getFact(subject, providerVirtualDeclarationFactKey);
  }

  getProviderTypeFamily(subject: ExtensionFactSubject | undefined): ProviderTypeFamilyFact | undefined {
    return this.getFact(subject, providerTypeFamilyFactKey);
  }
}

export function createSourceFactQueries(host: ExtensionHost): SourceFactQueries {
  const queries = new SourceFactQueries(host);
  Object.freeze(queries);
  return queries;
}
