import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
function seal(key, data) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
}
function unseal(key, value) {
  const data = Buffer.from(value, "base64"),
    dec = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  dec.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([dec.update(data.subarray(28)), dec.final()]),
  );
}
export { seal, unseal };
// Old installations can still open files received before personal-device linking was introduced.
export function legacyMedia(db, id) {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_accounts'",
    )
    .get();
  const row =
    table &&
    db
      .prepare(
        "SELECT channel,vault FROM personal_accounts WHERE id=? AND vault IS NOT NULL",
      )
      .get(id);
  if (!row)
    throw Object.assign(Error("Исходный аккаунт вложения отключён"), {
      http: 410,
    });
  const c = unseal(
    Buffer.from(process.env.BECHAT_ACCOUNT_KEY || "", "base64"),
    row.vault,
  );
  return row.channel === "Telegram"
    ? { TG_TOKEN: c.token }
    : { WA_TOKEN: c.token, WA_PHONE_ID: c.phoneId, WA_VERSION: c.version };
}
