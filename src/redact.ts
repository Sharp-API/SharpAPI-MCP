/**
 * Strip a configured key out of anything about to be returned to the model.
 *
 * Defence in depth behind the startup control-character check: that check stops
 * the one known way a key can be quoted back, this stops any other error path
 * that does the same.
 *
 * Lives in its own module so the tests can call it directly: tests/redact.mjs.
 */
export function makeRedactor(apiKey: string | undefined): (text: string) => string {
  if (!apiKey) return (text) => text
  return (text) => text.split(apiKey).join("[redacted SHARPAPI_KEY]")
}
