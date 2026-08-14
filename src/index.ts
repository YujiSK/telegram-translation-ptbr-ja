/**
 * Phase 0 scaffold only.
 *
 * This Worker does not talk to Telegram, OpenAI, or D1 yet. It exists so
 * that CI, deployment tooling, and local dev have something real to run
 * against. See docs/implementation-plan.md for what comes next.
 */

interface ErrorBody {
  error: {
    message: string;
    code: string;
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function notFound(): Response {
  const body: ErrorBody = {
    error: { message: "Not Found", code: "NOT_FOUND" },
  };
  return jsonResponse(body, 404);
}

export default {
  fetch(request: Request, _env: Env, _ctx: ExecutionContext): Response {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "telegram-translation-ptbr-ja" }, 200);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
