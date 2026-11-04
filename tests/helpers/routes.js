// Lists every REST operation the Express app serves, as "METHOD /path" with OpenAPI-style {params}.
// Express 5 routers do not keep their mount paths, so they are recorded while the app is built.

import express from 'express';

const API_PREFIX = '/api/v1';

// Joins two path segments into one normalised path ("/" for the root).
function joinPath(prefix, path) {
  const joined = `${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return joined || '/';
}

// Walks a router stack, adding each route's methods with its full path.
function collectFromStack(stack, prefix, mountPaths, operations) {
  for (const layer of stack) {
    if (layer.route) {
      const fullPath = joinPath(prefix, layer.route.path).replace(/:(\w+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods)) {
        if (method !== '_all') operations.add(`${method.toUpperCase()} ${fullPath}`);
      }
    } else if (mountPaths.has(layer.handle)) {
      collectFromStack(layer.handle.stack, joinPath(prefix, mountPaths.get(layer.handle)), mountPaths, operations);
    }
  }
}

// Builds a fresh app and returns the sorted list of operations under /api/v1 (prefix removed).
// Must run before anything else in the test file imports the app, so the route modules load here.
export async function collectApiOperations() {
  const mountPaths = new WeakMap();
  const routerPrototype = express.Router.prototype;
  const originalUse = routerPrototype.use;

  routerPrototype.use = function recordMountPath(...args) {
    const path = typeof args[0] === 'string' ? args[0] : '/';
    for (const handler of args.flat()) {
      if (typeof handler === 'function' && Array.isArray(handler.stack)) mountPaths.set(handler, path);
    }
    return originalUse.apply(this, args);
  };

  try {
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    const operations = new Set();
    collectFromStack(app.router.stack, '/', mountPaths, operations);
    return [...operations]
      .filter((operation) => operation.split(' ')[1].startsWith(API_PREFIX))
      .map((operation) => operation.replace(` ${API_PREFIX}`, ' '))
      .map((operation) => operation.replace(/ \/$/, ' /'))
      .sort();
  } finally {
    routerPrototype.use = originalUse;
  }
}
