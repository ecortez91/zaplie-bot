// Express 5 (path-to-regexp v8) rejects a bare "*" route path at startup, so
// the SPA catch-all must be a RegExp for server.js to load on either major.
// This test is red on a "*" path and green on a RegExp path. Inspecting the
// router stack keeps it fixture-free; swap for a supertest request once the
// backend has a fixture build to serve.
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const app = require('./server');

// Express 4 exposes the router as app._router, Express 5 as app.router.
// _router is checked first because the Express 4 app.router getter throws.
const routes = () => {
  const router = app._router || app.router;
  return router.stack.filter(layer => layer.route).map(layer => layer.route);
};

const isCatchAll = route =>
  route.path instanceof RegExp
    ? route.path.test('/feed/x/y')
    : route.path === '*';

test('SPA fallback is a GET-only RegExp route that Express 5 can load', () => {
  const route = routes().find(isCatchAll);
  assert.ok(route, 'no SPA catch-all route registered');
  assert.ok(
    route.path instanceof RegExp,
    `expected a RegExp path, got ${JSON.stringify(route.path)}`,
  );
  assert.deepEqual(Object.keys(route.methods), ['get']);
  for (const pathname of ['/', '/feed', '/feed/x/y']) {
    assert.ok(
      route.path.test(pathname),
      `${pathname} should reach the SPA fallback`,
    );
  }
});

test('no GET route is registered after the SPA fallback (it would be unreachable)', () => {
  const all = routes();
  const after = all
    .slice(all.indexOf(all.find(isCatchAll)) + 1)
    .filter(route => route.methods.get);
  assert.deepEqual(
    after.map(route => String(route.path)),
    [],
  );
});
