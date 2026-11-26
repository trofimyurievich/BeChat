import { createServer } from "node:http";
const required = [
  "AMO_TENANT_ID",
  "AMO_CLIENT_ID",
  "AMO_CLIENT_SECRET",
  "BECHAT_FOUNDER_ID",
];
const missing = required.filter((key) => !process.env[key]);
if (!missing.length) {
  await import("./main.mjs");
} else {
  console.log(
    "BeChat ожидает конфигурацию amoCRM (" + missing.join(", ") + ").",
  );
  createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (path === "/" && ["HEAD", "GET"].includes(req.method)) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://lcns.amocrm.ru",
      });
      return res.end(
        req.method === "HEAD"
          ? undefined
          : `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BeChat · Подключение amoCRM</title><style>*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;color:#e4e9ff;background:#070b25;font:16px/1.55 system-ui,sans-serif}main{max-width:35rem;padding:2rem}strong{font-size:1.35rem}small{margin-left:.5rem;color:#aab9ee}h1{margin:2rem 0 1rem;font-size:clamp(1.7rem,5vw,2.5rem);line-height:1.15}p{color:#b6bfde}</style><main><strong>BeChat</strong><small>by BeQuick</small><h1>Подключение amoCRM</h1><p>Сервер работает. Вход для сотрудников откроется после подключения рабочего аккаунта lcns.amocrm.ru.</p></main></html>`,
      );
    }
    const live = path === "/livez";
    res.writeHead(live ? 200 : 503, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(
      JSON.stringify({
        service: "BeChat",
        version: "1.1.0",
        status: live ? "live" : "setup_required",
      }),
    );
  }).listen(Number(process.env.PORT || 3010), process.env.HOST || "127.0.0.1");
}
