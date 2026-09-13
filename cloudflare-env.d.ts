/**
 * Augments the CloudflareEnv that @opennextjs/cloudflare declares, with the
 * bindings this app adds in wrangler.toml.
 *
 * Deliberately hand-written rather than generated with `wrangler types`: that
 * command emits the full Workers global type surface, which conflicts with the
 * DOM and Next.js types this app already uses (it retypes Response.json() as
 * unknown and breaks a dozen existing call sites). We only need the binding.
 */
declare global {
  interface CloudflareEnv {
    /** GSE board cached by .github/workflows/gse-quotes.yml. */
    FCS_QUOTES?: KVNamespace;
  }
}

export {};
