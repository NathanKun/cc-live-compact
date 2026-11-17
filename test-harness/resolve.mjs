// The module resolution the host does and plain Node does not:
//
//   1. `claude-code/testing`, which the suites import and no package provides —
//      pointed at the stand-in beside this file. The bare `claude-code` import in
//      register.test.ts is type-only and erased, so nothing is needed for it;
//   2. extensionless relative imports, so `./plan` finds `plan.ts`.
const HERE = new URL('.', import.meta.url)

const MAPPED = new Map([['claude-code/testing', 'stand-in/testing.js']])

export async function resolve(specifier, context, next) {
  const mapped = MAPPED.get(specifier)
  if (mapped) {
    return { url: new URL(mapped, HERE).href, format: 'module', shortCircuit: true }
  }
  try {
    return await next(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.')) {
      for (const ext of ['.ts', '/index.ts']) {
        try {
          return await next(specifier + ext, context)
        } catch {}
      }
    }
    throw error
  }
}
