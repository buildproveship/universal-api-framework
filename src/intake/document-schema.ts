import SwaggerParser from '@apidevtools/swagger-parser';
import { isMap, isNode, isScalar, isSeq, type Document } from 'yaml';
import { reject, type SchemaValidationResult } from './preflight.js';

// Only used after the shared preflight has rejected external references and
// unsupported syntax. Do not use this internal module as an intake boundary.
export async function validateParsedDocument(doc: Document.Parsed): Promise<SchemaValidationResult> {
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
    await SwaggerParser.validate(doc.toJS(), {
      parse: { json: false, yaml: false, text: false, binary: false },
      resolve: { external: false, file: false, http: false },
      dereference: { circular: false },
      validate: { schema: true, spec: false },
    });
    return {
      status: 'document-schema-passed', documentSchemaValidated: true,
      specificationConformanceValidated: false, importApproved: false, executionAuthorized: false,
    };
  } catch (error) {
    // Recognize only the pinned validator's fixed circular-reference diagnostic.
    // A recursive schema may be valid OpenAPI but is unsupported by this stage.
    if (error instanceof ReferenceError && error.message === 'The API contains circular references') {
      return reject('circular-reference-unsupported');
    }
    // No raw library error text, document values or JSON Pointer names escape.
    // Dereferencing can change paths; omit locations that cannot be matched to
    // an actual original AST node rather than inventing an offending location.
    return reject('document-schema-invalid', sourceOffset(doc, error));
  }
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
