import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { reject, type PreflightPolicy, type PreflightResult } from './preflight.js';

interface Input {
  source: string; format: 'json' | 'yaml'; policy: PreflightPolicy;
}

function inspect({ source, format, policy }: Input): PreflightResult {
  // JSON must actually be JSON, not YAML's more permissive syntax.
  if (format === 'json') {
    try { JSON.parse(source); } catch { return reject('syntax-invalid'); }
  }
  const doc = parseDocument(source, {
    version: '1.2', schema: 'core', strict: true, uniqueKeys: true,
    // parseDocument does not log diagnostics. 'silent' would suppress its
    // MULTIPLE_DOCS error, so retain errors and expose only codes/offsets.
    prettyErrors: false, logLevel: 'error', customTags: [],
  });
  const error = doc.errors[0];
  if (error) return reject('syntax-invalid', error.pos[0]);
  if (doc.warnings.length || doc.directives.yaml.version !== '1.2') return reject('unsupported-yaml');
  if (!isMap(doc.contents)) return reject('root-invalid');

  // Inspect AST nodes without converting or expanding aliases. No reference resolver.
  const pending: { node: unknown; depth: number }[] = [{ node: doc.contents, depth: 1 }];
  let nodes = 0;
  let references = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (!isNode(node)) continue;
    const offset = node.range?.[0];
    if (++nodes > policy.maxNodes) return reject('nodes-exceeded', offset);
    if (depth > policy.maxDepth) return reject('depth-exceeded', offset);
    if (isAlias(node) || node.tag || ('anchor' in node && node.anchor)) return reject('unsupported-yaml', offset);
    if (isScalar(node) && typeof node.value === 'number' && !Number.isFinite(node.value)) return reject('unsupported-yaml', offset);
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') return reject('unsupported-yaml', offset);
        const key = pair.key.value;
        if (key === '<<') return reject('unsupported-yaml', pair.key.range?.[0]);
        // URI scope and dynamic/anchor resolution are outside this preflight.
        if (['$id', '$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveRef', '$recursiveAnchor'].includes(key)) {
          return reject('reference-unsupported', pair.key.range?.[0]);
        }
        if (key === '$ref') {
          if (++references > policy.maxReferences) return reject('references-exceeded', pair.key.range?.[0]);
          const value = isScalar(pair.value) ? pair.value.value : undefined;
          if (typeof value !== 'string' || !(value === '#' || value.startsWith('#/'))) {
            return reject('reference-unsupported', pair.key.range?.[0]);
          }
          // RFC 3986 fragment = *(pchar / '/' / '?'), with pct-encoded octets.
          // Check raw URI syntax first: URL() would normalize forbidden whitespace.
          if (!/^#(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*$/.test(value)) {
            return reject('reference-unsupported', pair.key.range?.[0]);
          }
          // Only syntactic local JSON Pointer references; resolution remains a later gate.
          let decoded: string;
          try { decoded = decodeURIComponent(value); } catch { return reject('reference-unsupported', pair.key.range?.[0]); }
          if (/~(?![01])/.test(decoded)) return reject('reference-unsupported', pair.key.range?.[0]);
        }
        pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const item of node.items) pending.push({ node: item, depth: depth + 1 });
    }
  }
  const version = doc.contents.get('openapi');
  if (typeof version !== 'string' || !policy.allowedOpenApiVersions.includes(version)) return reject('version-not-allowed');
  return { status: 'preflight-passed', schemaValidated: false, executionAuthorized: false };
}

process.once('message', (input: Input) => {
  let result: PreflightResult;
  try { result = inspect(input); }
  catch { result = reject('worker-failed'); }
  process.send?.(result);
});
