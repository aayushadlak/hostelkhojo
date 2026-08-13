export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Direct proxy for /api/* to Render backend
    if (url.pathname.startsWith("/api/")) {
      const targetUrl = "https://hostelkhojo.onrender.com" + url.pathname + url.search;
      const headers = new Headers(request.headers);
      headers.set("Host", "hostelkhojo.onrender.com");

      const init = {
        method: request.method,
        headers: headers,
        redirect: "follow"
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.clone().arrayBuffer();
      }

      return fetch(targetUrl, init);
    }

    // 2. Serve static assets
    let response = await env.ASSETS.fetch(request);

    // 3. SPA Fallback for client routes like /user
    if (response.status === 404) {
      const indexRequest = new Request(new URL("/index.html", request.url), request);
      response = await env.ASSETS.fetch(indexRequest);
    }

    return response;
  }
};
