import AjvDraft4 from 'ajv-draft-04';
import { openapiV3 } from '@apidevtools/openapi-schemas';
import SwaggerParser from '@apidevtools/swagger-parser';
import { isMap, isNode, isScalar, isSeq, type Document } from 'yaml';
import { reject, type SchemaValidationResult } from './preflight.js';

// Only used after the shared preflight has rejected external references and
// unsupported syntax. Do not use this internal module as an intake boundary.
export async function validateParsedDocument(doc: Document.Parsed): Promise<SchemaValidationResult> {
  const parser = new SwaggerParser();
  try {
    // OAS 3.0 Components Object requires these map keys to match this pattern.
    // The maintained schema uses patternProperties without forbidding unmatched
    // keys, so invalid names could otherwise skip Schema Object validation.
    const components = isMap(doc.contents) ? doc.contents.get('components', true) : undefined;
    if (isMap(components)) {
      for (const field of ['schemas', 'responses', 'parameters', 'examples', 'requestBodies', 'headers', 'securitySchemes', 'links', 'callbacks']) {
        const entries = components.get(field, true);
        if (!isMap(entries)) continue;
        for (const pair of entries.items) {
          if (isScalar(pair.key) && typeof pair.key.value === 'string' && !/^[a-zA-Z0-9._-]+$/.test(pair.key.value)) {
            return reject('document-schema-invalid', pair.key.range?.[0]);
          }
        }
      }
    }
    const original: unknown = doc.toJS();
    const referenceFailure = strictReferences(original);
    if (referenceFailure) return reject(referenceFailure);
    // Validate reference placement before the resolver can replace objects.
    // Use the same maintained OAS schema/options as the pinned validator.
    const validate = new AjvDraft4.default({ allErrors: true, strict: false, validateFormats: false }).compile(openapiV3);
    if (!validate(original)) return reject('document-schema-invalid', sourceOffset(doc, { details: validate.errors }));
    const resolved = await parser.dereference(original as Parameters<typeof parser.dereference>[0], {
      parse: { json: false, yaml: false, text: false, binary: false },
      resolve: { external: false, file: false, http: false },
      dereference: { circular: false },
    });
    // Recheck transformed component maps: unmatched names in the upstream
    // patternProperties must never let a Schema Object skip validation.
    if (!componentNamesValid(resolved)) return reject('document-schema-invalid');
    if (!validate(resolved)) return reject('document-schema-invalid', sourceOffset(doc, { details: validate.errors }));
    return {
      status: 'document-schema-passed', documentSchemaValidated: true,
      specificationConformanceValidated: false, importApproved: false, executionAuthorized: false,
    };
  } catch (error) {
    // Use resolver state, never source-bearing exception text.
    // A recursive schema may be valid OpenAPI but is unsupported by this stage.
    if (error instanceof ReferenceError && parser.$refs.circular) {
      return reject('circular-reference-unsupported');
    }
    // No raw library error text, document values or JSON Pointer names escape.
    // Dereferencing can change paths; omit locations that cannot be matched to
    // an actual original AST node rather than inventing an offending location.
    return reject('document-schema-invalid', sourceOffset(doc, error));
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function componentNamesValid(root: unknown): boolean {
  if (!record(root) || !record(root.components)) return true;
  return ['schemas', 'responses', 'parameters', 'examples', 'requestBodies', 'headers', 'securitySchemes', 'links', 'callbacks']
    .every(field => !record(root.components) || !record(root.components[field]) ||
      Object.keys(root.components[field]).every(key => /^[a-zA-Z0-9._-]+$/.test(key)));
}

// RFC 6901 traversal is against the original document, without inherited
// properties, token joining, or implicit dereferencing of intermediate nodes.
function strictReferences(root: unknown): 'document-schema-invalid' | 'reference-unsupported' | undefined {
  const pending: unknown[] = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!record(node)) continue;
    if (Object.hasOwn(node, '$ref')) {
      if (typeof node.$ref !== 'string') return 'document-schema-invalid';
      // The pinned resolver may repeatedly URI-decode and select another
      // target. Until target equivalence is guaranteed, percent-encoded refs
      // are outside this stage's capability, even when otherwise valid.
      if (node.$ref.includes('%')) return 'reference-unsupported';
      const fragment = node.$ref.slice(1);
      if (fragment !== '' && !fragment.startsWith('/')) return 'document-schema-invalid';
      let target: unknown = root;
      for (const encoded of fragment === '' ? [] : fragment.slice(1).split('/')) {
        if (/~(?![01])/.test(encoded)) return 'document-schema-invalid';
        const token = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
        if (!record(target) || !Object.hasOwn(target, token)) return 'document-schema-invalid';
        if (Array.isArray(target) && !/^(0|[1-9][0-9]*)$/.test(token)) return 'document-schema-invalid';
        target = target[token];
      }
    }
    pending.push(...Object.values(node));
  }
  return undefined;
}

function sourceOffset(doc: Document.Parsed, error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('details' in error) || !Array.isArray(error.details)) return undefined;
  for (const detail of error.details) {
    if (!detail || typeof detail !== 'object' || typeof detail.instancePath !== 'string') continue;
    const pointer: string = detail.instancePath;
    if (pointer !== '' && (!pointer.startsWith('/') || /~(?![01])/.test(pointer))) continue;
    const parts = pointer === '' ? [] : pointer.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
    let node: unknown = doc.contents;
    for (const part of parts) {
      if (isMap(node)) {
        // The validator may have replaced this entire mapping through $ref.
        // Its derived children must not be attributed to original siblings.
        if (node.has('$ref')) { node = undefined; break; }
        node = node.items.find(pair => isScalar(pair.key) && pair.key.value === part)?.value;
      } else if (isSeq(node) && /^(0|[1-9][0-9]*)$/.test(part)) {
        node = node.items[Number(part)];
      } else {
        node = undefined;
        break;
      }
    }
    if (isNode(node) && node.range && !(isMap(node) && node.has('$ref'))) return node.range[0];
  }
  return undefined;
}
