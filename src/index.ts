/**
 * Phase 3: adds the Telegram webhook boundary. OpenAI translation and
 * reply-posting are not wired in yet — see docs/implementation-plan.md.
 */

import { handleTelegramWebhook } from "./handlers/telegram-webhook";

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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "telegram-translation-ptbr-ja" }, 200);
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return await handleTelegramWebhook(request, env);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
