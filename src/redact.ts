/**
 * Strip a configured key out of anything about to be returned to the model.
 *
 * Defence in depth behind the startup control-character check: that check stops
 * the one reproduced leak, this stops any future error path that quotes the key
 * back for a reason nobody has thought of yet.
 *
 * Lives in its own module so it can be tested directly. It previously closed
 * over module state in index.ts, which meant no test could reach it: neutering
 * it to a passthrough left the whole suite green.
 */
export function makeRedactor(apiKey: string | undefined): (text: string) => string {
  if (!apiKey) return (text) => text
  return (text) => text.split(apiKey).join("[redacted SHARPAPI_KEY]")
}
