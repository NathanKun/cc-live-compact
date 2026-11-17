// Local stand-in for the plugin host's `claude-code/testing` module, so the
// plugin's own test files can run under plain `node --test` on this machine.
// Only the matchers and the `(t, $, on)` fixtures the plugin's tests use are
// implemented: a test that takes `($, on)` gets a fresh engine and registrar.
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { fixture } from './fixtures.js'

export { describe, it, before, after, beforeEach, afterEach } from 'node:test'

export function test(name, fn) {
  // A test that names a fixture asks the host for it; one that does not runs
  // as it stands.
  if (typeof fn !== 'function' || fn.length < 1) return nodeTest(name, fn)
  return nodeTest(name, async () => {
    const { $, on } = await fixture()
    await fn($, on)
  })
}

function matchers(actual, negated) {
  return {
    toBe: (expected) => (negated ? assert.notStrictEqual(actual, expected) : assert.strictEqual(actual, expected)),
    toEqual: (expected) =>
      negated ? assert.notDeepStrictEqual(actual, expected) : assert.deepStrictEqual(actual, expected),
    toContain: (expected) =>
      negated
        ? assert.ok(!String(actual).includes(String(expected)), `expected not to contain ${expected}`)
        : assert.ok(String(actual).includes(String(expected)), `expected to contain ${expected}`),
    toBeNull: () => (negated ? assert.notStrictEqual(actual, null) : assert.strictEqual(actual, null)),
    toBeUndefined: () => (negated ? assert.notStrictEqual(actual, undefined) : assert.strictEqual(actual, undefined)),
    toBeGreaterThan: (expected) =>
      negated ? assert.ok(!(actual > expected)) : assert.ok(actual > expected, `${actual} > ${expected}`),
    toBeLessThan: (expected) =>
      negated ? assert.ok(!(actual < expected)) : assert.ok(actual < expected, `${actual} < ${expected}`),
    toBeTruthy: () => (negated ? assert.ok(!actual) : assert.ok(actual)),
    toBeFalsy: () => (negated ? assert.ok(actual) : assert.ok(!actual)),
  }
}

export function expect(actual) {
  const api = matchers(actual, false)
  api.not = matchers(actual, true)
  return api
}
