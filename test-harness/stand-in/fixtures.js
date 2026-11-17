// Stands in for the plugin host's own test harness, which hands every test a
// fresh engine (`$`) and the registrar (`on`) its module registers against.
//
// Two registries, as the host has: the hooks the module under test registers
// (`turn.complete`, `session.compact`) and the calls the engine beneath it
// answers (`session.messages`, `fs.read`, `command.run`, …). A call on `$` is
// offered to the hooks first, then to the engine.
import { pathToFileURL } from 'node:url'
import path from 'node:path'

function eventArg(event, args) {
  if (event === 'env.get' || event === 'env.has') return { name: args[0] }
  if (event === 'fs.read' || event === 'fs.write' || event === 'fs.exists') {
    return { path: args[0], text: args[1] }
  }
  if (event === 'session.messages' || event === 'session.usage') return args[0] ?? {}
  return args[0]
}

function unwrap(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && 'value' in result) {
    const keys = Object.keys(result)
    if (keys.length === 1) return result.value
  }
  return result
}

export async function fixture() {
  const hooks = new Map()
  const engine = new Map()

  const $ = new Proxy(
    {},
    {
      get(_, first) {
        if (typeof first !== 'string') return undefined
        const direct = (event) => {
          const handler = hooks.get(event) ?? engine.get(event)
          if (!handler) return undefined
          // `next` hands the event on to whoever sits beneath the mod: the
          // engine's own handler for that event, when the test installed one.
          const next = async (e) => {
            const below = engine.get(event)
            if (!below) return e
            return unwrap(await below($, e, async (x) => x))
          }
          return async (...args) => {
            return unwrap(await handler($, eventArg(event, args), next))
          }
        }
        const found = direct(first)
        if (found) return found
        return new Proxy(
          {},
          {
            get(__, leaf) {
              if (typeof leaf !== 'string') return undefined
              return direct(`${first}.${leaf}`)
            },
          },
        )
      },
    },
  )

  const hookOn = (event, optionsOrHandler, maybeHandler) => {
    hooks.set(event, typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler)
  }
  const engineOn = (event, optionsOrHandler, maybeHandler) => {
    engine.set(event, typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler)
  }

  const modulePath = pathToFileURL(path.resolve(process.cwd(), 'register.ts')).href
  const mod = await import(modulePath)
  mod.register(hookOn, {})

  return { $, on: engineOn, hooks, engine }
}
