// Unit test for the redactor.
//
// This exists because the redaction had no coverage at all: keyguard.mjs tests
// only the startup control-character refusal, so replacing redact() with a
// passthrough left the entire suite green. That mutation is now caught here.
import assert from "node:assert/strict"
import { makeRedactor } from "../dist/redact.js"

const KEY = "sk_live_SENTINEL_0123456789"
const redact = makeRedactor(KEY)

// The leak vector: a key quoted back inside an upstream error message.
const leaked = `SharpAPI request failed: Invalid header value "${KEY}" for X-API-Key`
const safe = redact(leaked)
assert.ok(!safe.includes(KEY), "key survived redaction in an error message")
assert.ok(safe.includes("[redacted SHARPAPI_KEY]"), "no redaction marker in output")

// Every occurrence, not just the first.
const twice = redact(`${KEY} and again ${KEY}`)
assert.ok(!twice.includes(KEY), "a repeated key was only partly redacted")
assert.equal(twice, "[redacted SHARPAPI_KEY] and again [redacted SHARPAPI_KEY]")

// Text with no key is untouched.
assert.equal(redact("nothing sensitive here"), "nothing sensitive here")

// No key configured: passthrough, and must not throw.
assert.equal(makeRedactor(undefined)("anything"), "anything")
assert.equal(makeRedactor("")("anything"), "anything")

console.log("PASS: redactor removes every occurrence of the key and is inert without one")
