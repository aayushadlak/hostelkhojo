export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve static assets directly
    let response = await env.ASSETS.fetch(request);

    // If 404 and not an API call, fallback to /index.html for SPA routing (/user)
    if (response.status === 404 && !url.pathname.startsWith("/api/")) {
      const indexRequest = new Request(new URL("/index.html", request.url), request);
      response = await env.ASSETS.fetch(indexRequest);
    }

    return response;
  }
};
