// Worker entry point: the OpenNext-generated handler, wrapped so plain-HTTP
// page requests go to HTTPS before Next sees them. The zone has no "Always
// Use HTTPS" rule and the domain is not on the HSTS preload list, so
// http://frontiercapitalsignals.com/ served a full 200 copy of every page.
// If that zone setting is turned on, this branch simply never runs.
// Static files under public/ are served by Workers Static Assets before any
// Worker code runs, so they are not covered here; the zone setting covers them.
// Pattern: https://opennext.js.org/cloudflare/howtos/custom-worker
import { default as handler } from "./.open-next/worker.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Production host only, so `opennextjs-cloudflare preview` on localhost works.
    if (url.protocol === "http:" && url.hostname.endsWith("frontiercapitalsignals.com")) {
      url.protocol = "https:";
      // One hop for http://www too: Next would otherwise add a second redirect to the apex.
      if (url.hostname === "www.frontiercapitalsignals.com") url.hostname = "frontiercapitalsignals.com";
      return Response.redirect(url.toString(), 301);
    }
    return handler.fetch(request, env, ctx);
  },
};

// The generated worker exports these Durable Object classes; the real entry
// point must keep exporting them.
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
