// server.json is the entry the MCP Registry publishes. The registry accepts it
// only when its name equals package.json's mcpName and its package version is
// one that exists on npm, so the two files must not drift apart.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
const pkg = read('package.json')
const server = read('server.json')

assert.ok(pkg.mcpName, 'package.json has no mcpName')
assert.equal(server.name, pkg.mcpName, 'server.json name and package.json mcpName differ')
assert.equal(server.version, pkg.version, 'server.json version and package.json version differ')
assert.ok(server.description.length <= 100, 'the registry limits description to 100 characters')

assert.equal(server.packages.length, 1, 'server.json should list exactly one package')
const [npm] = server.packages
assert.equal(npm.registryType, 'npm')
assert.equal(npm.identifier, pkg.name, 'server.json package identifier and package.json name differ')
assert.equal(npm.version, pkg.version, 'server.json package version and package.json version differ')
assert.deepEqual(
  npm.environmentVariables.map((v) => v.name),
  ['SHARPAPI_KEY'],
  'the package reads its key from SHARPAPI_KEY and nothing else',
)

console.log('PASS: server.json agrees with package.json on name, package and version')
