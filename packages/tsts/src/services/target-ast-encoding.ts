import type { GoPtr } from "../go/compat.js";
import type { FileReference, SourceFile } from "../internal/ast/ast.js";
import { AsSourceFile } from "../internal/ast/ast.js";
import type { Node, NodeList } from "../internal/ast/spine.js";
import {
  NewNodeFactory,
  Node_End,
  NodeList_End,
  NodeList_Pos,
  Node_Pos,
} from "../internal/ast/spine.js";
import {
  TargetAstNodeDataChildren,
  TargetAstNodeDataExtended,
  TargetAstNodeDataString,
  targetAstNodeEncoding,
} from "../internal/ast/generated/encoder.js";
import type {
  TargetAstEncodedChild,
  TargetAstNodeEncoding,
} from "../internal/ast/generated/encoder.js";
import {
  NewIdentifier,
  NewKeywordTypeNode,
} from "../internal/ast/generated/factory.js";
import {
  KindPropertyAssignment,
  KindPropertySignature,
  KindUnknownKeyword,
} from "../internal/ast/generated/kinds.js";
import {
  HEADER_OFFSET_EXTENDED_DATA,
  HEADER_OFFSET_METADATA,
  HEADER_OFFSET_NODES,
  HEADER_OFFSET_STRING_TABLE,
  HEADER_OFFSET_STRING_TABLE_OFFSETS,
  HEADER_OFFSET_STRUCTURED_DATA,
  HEADER_SIZE,
  KIND_NODE_LIST,
  NODE_DATA_TYPE_CHILDREN,
  NODE_DATA_TYPE_EXTENDED,
  NODE_DATA_TYPE_STRING,
  NODE_EXTENDED_DATA_MASK,
  NODE_LEN,
  NODE_STRING_INDEX_MASK,
  PROTOCOL_VERSION,
} from "../internal/ast/generated/protocol.js";

const noStructuredData = 0xffff_ffff;

export class TargetAstEncodingError extends Error {
  readonly kind: number | undefined;
  readonly field: string | undefined;

  constructor(message: string, kind?: number, field?: string) {
    super(message);
    this.name = "TargetAstEncodingError";
    this.kind = kind;
    this.field = field;
  }
}

export function encodeTargetSourceFileForPrinting(sourceFile: SourceFile): Uint8Array {
  return new TargetAstEncoder().encode(sourceFile);
}

class TargetAstEncoder {
  readonly #strings = new StringTable();
  readonly #extended: number[] = [];
  readonly #structured: number[] = [];
  readonly #nodeValues = new Array<number>(NODE_LEN / 4).fill(0);
  readonly #active = new Set<Node>();
  readonly #unknownType: Node;
  readonly #undefinedExpression: Node;
  #nodeCount = 0;
  #parentIndex = 0;
  #previousIndex = 0;

  constructor() {
    const factory = NewNodeFactory({});
    this.#unknownType = requiredProtocolNode(
      NewKeywordTypeNode(factory, KindUnknownKeyword),
      "property-assignment type completion",
    );
    this.#undefinedExpression = requiredProtocolNode(
      NewIdentifier(factory, "undefined"),
      "property-signature initializer completion",
    );
  }

  encode(sourceFile: SourceFile): Uint8Array {
    const root = sourceFile.data.AsNode();
    if (root === undefined) {
      throw new TargetAstEncodingError("target source file has no root node");
    }
    const encoding = this.#encoding(root);
    this.#nodeCount = 1;
    this.#appendNodeRow(root, 0, this.#nodeData(root, encoding));
    this.#parentIndex = 1;
    this.#previousIndex = 0;
    this.#visitChildren(root, encoding);
    return this.#finish();
  }

  #visitNode(node: GoPtr<Node>): void {
    if (node === undefined) {
      throw new TargetAstEncodingError("present target AST child is absent");
    }
    if (this.#active.has(node)) {
      throw new TargetAstEncodingError("cycle in target AST", node.Kind);
    }
    this.#active.add(node);
    try {
      const encoding = this.#encoding(node);
      this.#nodeCount += 1;
      const current = this.#nodeCount;
      this.#linkPrevious(current);
      this.#appendNodeRow(
        node,
        this.#parentIndex,
        this.#nodeData(node, encoding),
      );
      const savedParent = this.#parentIndex;
      this.#parentIndex = current;
      this.#previousIndex = 0;
      this.#visitChildren(node, encoding);
      this.#previousIndex = current;
      this.#parentIndex = savedParent;
    } finally {
      this.#active.delete(node);
    }
  }

  #visitNodeList(nodes: readonly GoPtr<Node>[], list: GoPtr<NodeList>): void {
    this.#nodeCount += 1;
    const current = this.#nodeCount;
    this.#linkPrevious(current);
    this.#nodeValues.push(
      KIND_NODE_LIST,
      encodedPosition(NodeList_Pos(list)),
      encodedPosition(NodeList_End(list)),
      0,
      this.#parentIndex,
      nodes.length,
      0,
    );
    const savedParent = this.#parentIndex;
    this.#parentIndex = current;
    this.#previousIndex = 0;
    for (const node of nodes) this.#visitNode(node);
    this.#previousIndex = current;
    this.#parentIndex = savedParent;
  }

  #visitChildren(node: Node, encoding: TargetAstNodeEncoding): void {
    for (const child of encoding.children) {
      if (!child.present) {
        if (child.required) {
          throw new TargetAstEncodingError(
            "required target AST child is absent",
            node.Kind,
            child.name,
          );
        }
        continue;
      }
      if (child.raw) {
        for (const rawChild of child.nodes ?? []) this.#visitNode(rawChild);
      } else if (child.nodes !== undefined || child.node === undefined) {
        if (child.list === undefined) {
          throw new TargetAstEncodingError(
            "present target AST node list is absent",
            node.Kind,
            child.name,
          );
        }
        this.#visitNodeList(child.nodes ?? [], child.list);
      } else {
        this.#visitNode(child.node);
      }
    }
  }

  #nodeData(node: Node, encoding: TargetAstNodeEncoding): number {
    switch (encoding.dataType) {
      case TargetAstNodeDataChildren:
        return (NODE_DATA_TYPE_CHILDREN |
          encoding.commonData |
          childMask(encoding.children)) >>> 0;
      case TargetAstNodeDataString: {
        const index = this.#strings.add(requiredText(node, encoding.text));
        if (index > NODE_STRING_INDEX_MASK) {
          throw new TargetAstEncodingError("string index exceeds protocol width", node.Kind);
        }
        return (NODE_DATA_TYPE_STRING | encoding.commonData | index) >>> 0;
      }
      case TargetAstNodeDataExtended: {
        const offset = this.#extended.length * 4;
        if (offset > NODE_EXTENDED_DATA_MASK) {
          throw new TargetAstEncodingError("extended-data offset exceeds protocol width", node.Kind);
        }
        this.#appendExtended(node, encoding);
        return (NODE_DATA_TYPE_EXTENDED | encoding.commonData | offset) >>> 0;
      }
    }
  }

  #encoding(node: Node): TargetAstNodeEncoding {
    const encoding = targetAstNodeEncoding(node);
    switch (node.Kind) {
      case KindPropertyAssignment:
        return withRequiredProtocolChild(
          encoding,
          "Type",
          this.#unknownType,
        );
      case KindPropertySignature:
        return withRequiredProtocolChild(
          encoding,
          "Initializer",
          this.#undefinedExpression,
        );
      default:
        return encoding;
    }
  }

  #appendExtended(
    node: Node,
    encoding: ReturnType<typeof targetAstNodeEncoding>,
  ): void {
    switch (encoding.extended) {
      case "literal":
        this.#extended.push(
          this.#strings.add(requiredText(node, encoding.text)),
          encoding.tokenFlags ?? 0,
        );
        return;
      case "template":
        this.#extended.push(
          this.#strings.add(requiredText(node, encoding.text)),
          this.#strings.add(requiredText(node, encoding.rawText)),
          encoding.tokenFlags ?? 0,
        );
        return;
      case "source-file":
        this.#appendSourceFile(requiredSourceFile(node));
        return;
      case "none":
        throw new TargetAstEncodingError(
          "extended target AST node has no extended-data owner",
          node.Kind,
        );
    }
  }

  #appendSourceFile(source: SourceFile): void {
    const fileName = source.FileName();
    const path = source.Path();
    if (fileName.length === 0) {
      throw new TargetAstEncodingError("source file name is absent", source.Kind, "FileName");
    }
    if (path.length === 0) {
      throw new TargetAstEncodingError("source path is absent", source.Kind, "Path");
    }
    const references = appendFileReferences(this.#structured, source.ReferencedFiles);
    const typeReferences = appendFileReferences(
      this.#structured,
      source.TypeReferenceDirectives,
    );
    const libReferences = appendFileReferences(
      this.#structured,
      source.LibReferenceDirectives,
    );
    this.#extended.push(
      this.#strings.add(source.Text()),
      this.#strings.add(fileName),
      this.#strings.add(path),
      source.LanguageVariant,
      source.ScriptKind,
      references,
      typeReferences,
      libReferences,
      noStructuredData,
      noStructuredData,
      noStructuredData,
      0,
    );
  }

  #appendNodeRow(node: Node, parent: number, data: number): void {
    this.#nodeValues.push(
      node.Kind,
      encodedPosition(Node_Pos(node)),
      encodedPosition(Node_End(node)),
      0,
      parent,
      data,
      node.Flags,
    );
  }

  #linkPrevious(current: number): void {
    if (this.#previousIndex !== 0) {
      this.#nodeValues[this.#previousIndex * (NODE_LEN / 4) + 3] = current;
    }
  }

  #finish(): Uint8Array {
    const stringOffsets = uint32Bytes(this.#strings.offsets);
    const stringData = this.#strings.bytes();
    const extended = uint32Bytes(this.#extended);
    const structured = Uint8Array.from(this.#structured);
    const nodes = uint32Bytes(this.#nodeValues);
    const offsetStringOffsets = HEADER_SIZE;
    const offsetStringData = offsetStringOffsets + stringOffsets.length;
    const offsetExtended = offsetStringData + stringData.length;
    const offsetStructured = offsetExtended + extended.length;
    const offsetNodes = offsetStructured + structured.length;
    const result = new Uint8Array(offsetNodes + nodes.length);
    const view = new DataView(result.buffer);
    view.setUint32(HEADER_OFFSET_METADATA, PROTOCOL_VERSION << 24, true);
    view.setUint32(HEADER_OFFSET_STRING_TABLE_OFFSETS, offsetStringOffsets, true);
    view.setUint32(HEADER_OFFSET_STRING_TABLE, offsetStringData, true);
    view.setUint32(HEADER_OFFSET_EXTENDED_DATA, offsetExtended, true);
    view.setUint32(HEADER_OFFSET_STRUCTURED_DATA, offsetStructured, true);
    view.setUint32(HEADER_OFFSET_NODES, offsetNodes, true);
    result.set(stringOffsets, offsetStringOffsets);
    result.set(stringData, offsetStringData);
    result.set(extended, offsetExtended);
    result.set(structured, offsetStructured);
    result.set(nodes, offsetNodes);
    return result;
  }
}

class StringTable {
  readonly offsets: number[] = [];
  readonly #parts: Uint8Array[] = [];
  #length = 0;

  add(value: string): number {
    const bytes = new TextEncoder().encode(value);
    const index = this.offsets.length;
    const start = this.#length;
    this.#parts.push(bytes);
    this.#length += bytes.length;
    this.offsets.push(start, this.#length);
    return index;
  }

  bytes(): Uint8Array {
    const result = new Uint8Array(this.#length);
    let offset = 0;
    for (const part of this.#parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
}

function appendFileReferences(
  destination: number[],
  references: readonly GoPtr<FileReference>[],
): number {
  if (references.length === 0) return noStructuredData;
  const offset = destination.length;
  appendArrayHeader(destination, references.length);
  for (const reference of references) {
    if (reference === undefined) {
      throw new TargetAstEncodingError("source file reference is absent");
    }
    appendArrayHeader(destination, 5);
    appendMessagePackUint(destination, reference.pos);
    appendMessagePackUint(destination, reference.end);
    appendMessagePackString(destination, reference.FileName);
    appendMessagePackUint(destination, reference.ResolutionMode);
    destination.push(reference.Preserve ? 0xc3 : 0xc2);
  }
  return offset;
}

function appendArrayHeader(destination: number[], length: number): void {
  if (length <= 0x0f) destination.push(0x90 | length);
  else if (length <= 0xffff) destination.push(0xdc, length >>> 8, length);
  else destination.push(0xdd, length >>> 24, length >>> 16, length >>> 8, length);
}

function appendMessagePackUint(destination: number[], value: number): void {
  if (value <= 0x7f) destination.push(value);
  else if (value <= 0xff) destination.push(0xcc, value);
  else if (value <= 0xffff) destination.push(0xcd, value >>> 8, value);
  else destination.push(0xce, value >>> 24, value >>> 16, value >>> 8, value);
}

function appendMessagePackString(destination: number[], value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= 0x1f) destination.push(0xa0 | bytes.length);
  else if (bytes.length <= 0xff) destination.push(0xd9, bytes.length);
  else if (bytes.length <= 0xffff) {
    destination.push(0xda, bytes.length >>> 8, bytes.length);
  } else {
    destination.push(
      0xdb,
      bytes.length >>> 24,
      bytes.length >>> 16,
      bytes.length >>> 8,
      bytes.length,
    );
  }
  destination.push(...bytes);
}

function withRequiredProtocolChild(
  encoding: TargetAstNodeEncoding,
  name: string,
  node: Node,
): TargetAstNodeEncoding {
  let matches = 0;
  const children = encoding.children.map((child): TargetAstEncodedChild => {
    if (child.name !== name) {
      return child;
    }
    matches += 1;
    if (!child.required || child.raw || child.nodes !== undefined) {
      throw new TargetAstEncodingError(
        "target AST protocol completion does not own one required node",
        undefined,
        name,
      );
    }
    return child.present ? child : {
      ...child,
      present: true,
      node,
    };
  });
  if (matches !== 1) {
    throw new TargetAstEncodingError(
      `target AST protocol completion found ${matches} '${name}' fields`,
      undefined,
      name,
    );
  }
  return { ...encoding, children };
}

function requiredProtocolNode(
  node: GoPtr<Node>,
  subject: string,
): Node {
  if (node === undefined) {
    throw new TargetAstEncodingError(`${subject} was not created`);
  }
  return node;
}

function childMask(
  children: ReturnType<typeof targetAstNodeEncoding>["children"],
): number {
  let mask = 0;
  children.forEach((child, index) => {
    if (child.present) mask |= 1 << index;
  });
  return mask >>> 0;
}

function encodedPosition(value: number): number {
  return value < 0 ? 0 : value;
}

function uint32Bytes(values: readonly number[]): Uint8Array {
  const result = new Uint8Array(values.length * 4);
  const view = new DataView(result.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return result;
}

function requiredText(node: Node, value: string | undefined): string {
  if (value === undefined) {
    throw new TargetAstEncodingError("target AST text is absent", node.Kind);
  }
  return value;
}

function requiredSourceFile(node: Node): SourceFile {
  const sourceFile = AsSourceFile(node);
  if (sourceFile === undefined) {
    throw new TargetAstEncodingError("source-file node has no source-file data", node.Kind);
  }
  return sourceFile;
}
