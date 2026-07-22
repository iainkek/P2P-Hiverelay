import test from 'brittle'
import path from 'path'
import { fileURLToPath } from 'url'
import { expandPluginConfigs, PluginLoader } from '../../packages/core/core/plugin-loader.js'

test('plugin loader expands poker bundle and de-duplicates builtin dependencies', (t) => {
  t.alike(expandPluginConfigs(['poker', 'vrf', 'ai', 'poker']), [
    'poker',
    'vrf',
    'arbitration',
    'zk',
    'ai'
  ])
})

test('plugin loader resolves poker as a builtin service provider', async (t) => {
  const loader = new PluginLoader()
  const providers = await loader.load(['poker'])
  t.alike(providers.map(provider => provider.manifest().name), [
    'poker',
    'vrf',
    'arbitration',
    'zk'
  ])
  await loader.stopAll()
})

test('plugin loader resolves outboxlog as a builtin service provider', async (t) => {
  const loader = new PluginLoader()
  const providers = await loader.load(['outboxlog'])
  t.alike(providers.map(provider => provider.manifest().name), [
    'outboxlog'
  ])
  await loader.stopAll()
})

test('plugin loader resolves notify as a builtin service provider', async (t) => {
  const loader = new PluginLoader()
  const providers = await loader.load(['notify'])
  t.alike(providers.map(provider => provider.manifest().name), [
    'notify'
  ])
  await loader.stopAll()
})

test('plugin loader resolves opaque core availability from an explicit builtin directory', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const loader = new PluginLoader({ builtinDir: path.join(root, 'packages/services/builtin') })
  const provider = await loader.loadBuiltin('opaque-core-availability')
  t.alike(provider.manifest().capabilities, ['register', 'status', 'prove'])
})
