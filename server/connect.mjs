import { amoPost } from "./amo.mjs";
const env = process.env,
  cmd = process.argv[2],
  url = new URL(env.PUBLIC_ORIGIN);
if (url.protocol !== "https:")
  throw Error("PUBLIC_ORIGIN должен быть HTTPS-адресом сервера BeChat");
if (cmd === "telegram") {
  if (
    !env.TG_TOKEN ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(env.TG_WEBHOOK_SECRET || "")
  )
    throw Error("Заполните TG_TOKEN и TG_WEBHOOK_SECRET");
  const r = await fetch(
    "https://api.telegram.org/bot" + env.TG_TOKEN + "/setWebhook",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: new URL("/hooks/telegram", url).href,
        secret_token: env.TG_WEBHOOK_SECRET,
        allowed_updates: ["message", "channel_post"],
      }),
    },
  );
  if (!r.ok) throw Error("Telegram HTTP " + r.status);
  console.log("Telegram принял адрес вебхука.");
} else if (cmd === "amo") {
  if (!env.AMO_CHANNEL_ID || !env.AMO_CHANNEL_SECRET || !env.AMO_ACCOUNT_ID)
    throw Error(
      "Нужны AMO_CHANNEL_ID, AMO_CHANNEL_SECRET и AMO_ACCOUNT_ID (amojo_id)",
    );
  const result = JSON.parse(
    await amoPost(
      "/v2/origin/custom/" +
        encodeURIComponent(env.AMO_CHANNEL_ID) +
        "/connect",
      {
        account_id: env.AMO_ACCOUNT_ID,
        title: "BeChat",
        hook_api_version: "v2",
      },
    ),
  );
  if (!result.scope_id) throw Error("amoCRM не вернула scope_id");
  console.log(
    "Сохраните в окружении сервера:\nAMO_SCOPE_ID=" + result.scope_id,
  );
} else throw Error("Используйте telegram или amo");
