// Keeps the docs honest: every route in the Express router stack must be in openapi.yaml,
// api_reference.md and the implementation checklist (marked DONE), and nothing documented may be missing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectApiOperations } from '../helpers/routes.js';

const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/api');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Reads a file from docs/api.
function readDoc(name) {
  return fs.readFileSync(path.join(DOCS_DIR, name), 'utf8');
}

// Lists "METHOD /path" for every operation in the OpenAPI document.
function openApiOperations(spec) {
  return Object.entries(spec.paths).flatMap(([route, item]) =>
    HTTP_METHODS.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${route}`),
  );
}

// Finds every `$ref` value anywhere in the document.
function collectRefs(node, refs = []) {
  if (Array.isArray(node)) node.forEach((child) => collectRefs(child, refs));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

// Lists the operations written as `METHOD /path` in a Markdown document.
function markdownOperations(markdown) {
  const matches = markdown.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/[^`?\s]*)/g);
  return new Set([...matches].map(([, method, route]) => `${method} ${route}`));
}

// Reads the checklist rows: | # | METHOD | `path` | ... | Status | Tested |.
function checklistRows(markdown) {
  return markdown
    .split('\n')
    .filter((line) => /^\| (\d+|—) \| (GET|POST|PUT|PATCH|DELETE) \| `/.test(line))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      const route = cells[3].match(/`([^`]+)`/)[1];
      return { operation: `${cells[2]} ${route}`, line };
    });
}

let implemented;
let spec;

beforeAll(async () => {
  implemented = await collectApiOperations();
  spec = parse(readDoc('openapi.yaml'));
});

describe('API contract', () => {
  it('finds the routes in the Express router stack', () => {
    expect(implemented).toContain('GET /health');
    expect(implemented).toContain('POST /media/upload');
    expect(implemented).toContain('PATCH /admin/settings');
    expect(implemented).toContain('POST /auth/logout-all');
    expect(implemented).toHaveLength(80);
  });

  it('openapi.yaml documents exactly the implemented operations', () => {
    const documented = openApiOperations(spec).sort();
    expect(documented.filter((operation) => !implemented.includes(operation))).toEqual([]);
    expect(implemented.filter((operation) => !documented.includes(operation))).toEqual([]);
  });

  it('openapi.yaml has unique operation ids and no broken $ref', () => {
    const operationIds = Object.values(spec.paths).flatMap((item) => HTTP_METHODS.filter((m) => item[m]).map((m) => item[m].operationId));
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds.every(Boolean)).toBe(true);

    const broken = collectRefs(spec).filter((ref) => {
      const [, section, name] = ref.match(/^#\/components\/(\w+)\/(\w+)$/) ?? [];
      return !section || !spec.components?.[section]?.[name];
    });
    expect(broken).toEqual([]);
  });

  it('openapi.yaml does not document the removed S3 upload flow', () => {
    expect(spec.paths['/media/upload-url']).toBeUndefined();
    expect(spec.paths['/media/complete']).toBeUndefined();
  });

  it('api_reference.md mentions every implemented operation', () => {
    const mentioned = markdownOperations(readDoc('api_reference.md'));
    expect(implemented.filter((operation) => !mentioned.has(operation))).toEqual([]);
  });

  it('the checklist lists every implemented operation as DONE and the S3 routes as replaced', () => {
    const rows = checklistRows(readDoc('API_IMPLEMENTATION_CHECKLIST.md'));
    const rowFor = (operation) => rows.find((row) => row.operation === operation);

    const missing = implemented.filter((operation) => !rowFor(operation));
    const notDone = implemented.filter((operation) => rowFor(operation) && !rowFor(operation).line.includes('| DONE'));
    expect(missing).toEqual([]);
    expect(notDone).toEqual([]);

    for (const removed of ['POST /media/upload-url', 'POST /media/complete']) {
      expect(rowFor(removed)?.line).toContain('REPLACED_BY_LOCAL_IMPLEMENTATION');
      expect(implemented).not.toContain(removed);
    }
    expect(rows.filter((row) => row.line.includes('| TODO'))).toEqual([]);
  });
});
