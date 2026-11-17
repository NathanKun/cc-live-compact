// Registers the resolution in ./resolve.mjs for the run.
import { register } from 'node:module'

register(new URL('./resolve.mjs', import.meta.url))
