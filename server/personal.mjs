import { spawn } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const kinds = ["Telegram", "WhatsApp", "MAX", "ВКонтакте"];
const worker = fileURLToPath(new URL("../personal/worker.py", import.meta.url));
function fail(status, message) {
  throw Object.assign(new Error(message), { http: status, definite: true });
}
const knownStates = {
  starting: "Подключение",
  qr: "Отсканируйте QR на своём телефоне",
  password: "Введите пароль двухэтапной проверки",
  code: "Введите код подтверждения от MAX",
  confirming: "Телефон подтвердил вход. Подключаем профиль MAX…",
  oauth: "Разрешите BeChat доступ в VK ID",
  online: "Подключён",
  offline: "Восстанавливаем связь",
  failed: "Подключение прервано",
};
export function createPersonal(db, onMessage, options = {}) {
  const env = options.env || process.env;
  const launch = options.launch || spawn;
  const directory = join(
    dirname(resolve(env.BECHAT_DB || "data/bechat.sqlite")),
    "personal",
  );
  const issues = new Map();
  const running = new Map(),
    retries = new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS direct_accounts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,channel TEXT NOT NULL,external TEXT,label TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,history INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS direct_active_owner ON direct_accounts(owner,channel) WHERE status!='removed';
    CREATE UNIQUE INDEX IF NOT EXISTS direct_active_identity ON direct_accounts(channel,external) WHERE external IS NOT NULL AND status!='removed';`);
  if (!db.prepare("PRAGMA table_info(direct_accounts)").all().some(c => c.name === "auth_method"))
    db.exec("ALTER TABLE direct_accounts ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'qr'");
  if (!db.prepare("PRAGMA table_info(direct_accounts)").all().some(c => c.name === "history_version"))
    db.exec("ALTER TABLE direct_accounts ADD COLUMN history_version INTEGER NOT NULL DEFAULT 0; UPDATE direct_accounts SET history=1 WHERE status!='removed'");
  db.exec("CREATE TABLE IF NOT EXISTS personal_code_limits (key TEXT PRIMARY KEY, until INTEGER NOT NULL)");
  const row = (id) =>
    db
      .prepare("SELECT * FROM direct_accounts WHERE id=? AND status!='removed'")
      .get(id);
  const owned = (owner, channel) =>
    db
      .prepare(
        "SELECT * FROM direct_accounts WHERE owner=? AND channel=? AND status!='removed'",
      )
      .get(owner, channel);
  const set = (id, state) =>
    db
      .prepare(
        "UPDATE direct_accounts SET status=? WHERE id=? AND status!='removed'",
      )
      .run(state, id);
  const requirements = (channel) =>
    channel === "Telegram" && !(env.TG_API_ID && env.TG_API_HASH)
      ? "На сервере нужны API ID и API hash приложения Telegram."
      : channel === "ВКонтакте" && !env.VK_APP_ID
        ? "Нужно приложение VK ID с разрешением на личные сообщения."
        : "";
  function list(owner) {
    return kinds.map((channel) => {
      const a = owned(owner, channel),
        live = a && running.get(a.id);
      return {
        channel,
        id: a?.id,
        label: a?.label || "",
        method: a?.auth_method || "qr",
        ready: a?.status === "online",
        status: a?.status || "new",
        description:
          live?.error || live?.historyError ||
          issues.get(a?.id) ||
          knownStates[a?.status] ||
          "Личный аккаунт",
        requirement: requirements(channel),
        ...(live?.prompt || {}),
      };
    });
  }
  function request(client, op, data = {}, timeout = 30000) {
    if (!client?.child.stdin.writable)
      return Promise.reject(Error("Клиент не подключён"));
    const key = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.waiting.delete(key);
        reject(Error("Ответ мессенджера не получен"));
      }, timeout);
      client.waiting.set(key, { resolve, reject, timer, op });
      client.child.stdin.write(
        JSON.stringify({ op, request: key, ...data }) + "\n",
        (e) => {
          if (e && client.waiting.delete(key)) {
            clearTimeout(timer);
            reject(e);
          }
        },
      );
    });
  }
  function start(a, phone = "") {
    if (running.has(a.id)) return;
    clearTimeout(retries.get(a.id));
    retries.delete(a.id);
    const master = Buffer.from(env.BECHAT_ACCOUNT_KEY || "", "base64");
    if (master.length !== 32) fail(503, "Настройте ключ хранения BeChat");
    const dataPath = join(directory, a.id);
    mkdirSync(dataPath, { recursive: true, mode: 0o700 });
    const child = launch(
      env.BECHAT_PYTHON || "python3",
      ["-u", worker, a.channel, dataPath, a.history ? "1" : "0"],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: {
          PATH: env.PATH || "",
          SystemRoot: env.SystemRoot || "",
          HOME: env.HOME || "",
          TG_API_ID: env.TG_API_ID || "",
          TG_API_HASH: env.TG_API_HASH || "",
          VK_APP_ID: env.VK_APP_ID || "",
          BECHAT_MAX_METHOD: a.auth_method || "qr",
          BECHAT_MAX_PHONE: phone,
          PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
          BECHAT_SESSION_CIPHER: createHmac("sha256", master)
            .update(a.id)
            .digest("base64"),
          PYTHONIOENCODING: "utf-8",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    const live = {
      child,
      waiting: new Map(),
      prompt: null,
      error: null,
      closing: false,
    };
    running.set(a.id, live);
    issues.delete(a.id);
    live.finished = new Promise((done) => {
      child.once("close", done);
      child.once("error", done);
    });
    set(a.id, "starting");
    const expire = setTimeout(
      () => {
        if (!live.online) {
          live.error = "Время входа истекло. Начните подключение заново.";
          child.kill();
        }
      },
      5 * 60 * 1000,
    ).unref();
    const reader = createInterface({ input: child.stdout });
    child.stdin.on("error", () => {});
    function onLine(line) {
      if (line.length > 13 * 1024 * 1024 || running.get(a.id) !== live) return;
      const event = JSON.parse(line);
      if (event.type === "result") {
        const p = live.waiting.get(event.request);
        if (!p) return;
        clearTimeout(p.timer);
        live.waiting.delete(event.request);
        if (event.error && p.op==="media") console.warn("MAX media lookup:",/^[a-zA-Z]{1,60}$/.test(event.error)?event.error:"Error");
        if (event.error)
          p.reject(
            Object.assign(Error(p.op === "resolve" ? "Контакт не найден по этому номеру или поиск ограничен настройками профиля." : "Мессенджер отклонил операцию"), { http: 422 }),
          );
        else p.resolve(event.value);
        return;
      }
      if (live.closing) return;
      if (event.type === "prompt") {
        live.online = false;
        live.prompt = event.mode==="code" ? {digits:Number.isInteger(event.digits) && event.digits>=4 && event.digits<=10 ? event.digits : null, codeRejected:event.reason==="CodeRejected"} : null;
        if (
          event.mode === "qr" &&
          typeof event.image === "string" &&
          event.image.length < 32000 &&
          /^[A-Za-z0-9+/=]+$/.test(event.image)
        )
          live.prompt = { qr: "data:image/png;base64," + event.image };
        else if (
          event.mode === "oauth" &&
          new URL(event.url).origin === "https://id.vk.com" &&
          /^[\w-]{42,128}$/.test(event.state)
        ) {
          live.vkState = event.state;
          live.prompt = { authorize: event.url };
        } else if (!["password", "code", "confirming"].includes(event.mode)) return;
        set(a.id, event.mode);
      } else if (event.type === "ready") {
        const current = row(a.id),
          external = String(event.identity || "").slice(0, 150);
        if (!current || !external) return;
        const other = db
          .prepare(
            "SELECT id FROM direct_accounts WHERE channel=? AND external=? AND id!=? AND status!='removed'",
          )
          .get(a.channel, external, a.id);
        if (other || (current.external && current.external !== external)) {
          live.error =
            "Этот аккаунт уже привязан или выбран другой профиль. Отключите попытку и проверьте аккаунт.";
          live.closing = true;
          set(a.id, "failed");
          request(live, "logout", {}, 6500)
            .catch(() => {})
            .finally(() => child.kill());
          return;
        }
        clearTimeout(expire);
        live.online = true;
        live.prompt = null;
        live.vkState = null;
        db.prepare(
          "UPDATE direct_accounts SET external=?,label=?,status='online' WHERE id=? AND status!='removed'",
        ).run(external, String(event.label || external).slice(0, 160), a.id);
      } else if (event.type === "history_complete" && live.online) {
        live.historyError = "";
        db.prepare("UPDATE direct_accounts SET history=0,history_version=1 WHERE id=?").run(a.id);
      } else if (event.type === "history_error" && live.online) {
        live.historyError = "Подключён. Повторяем загрузку истории.";
        console.warn("BeChat history retry:", a.channel, /^[A-Za-z]{1,60}$/.test(event.reason) ? event.reason : "Error");
      } else if (event.type === "receipt" && live.online) {
        const peer = String(event.peer || "");
        if (peer && peer.length <= 150) onMessage({receipt:true,channel:a.channel,accountId:a.id,owner:a.owner,
          peer:a.id+":"+peer,basis:event.basis,position:event.position,remoteId:String(event.remote||"").slice(0,220),status:event.status});
      } else if (event.type === "profile" && live.online) {
        const peer = String(event.peer || "");
        if (!peer || peer.length > 150) return;
        const photo = typeof event.photo === "string" && event.photo.length < 36000 && event.photo.startsWith("/9j/") ? event.photo : null;
        onMessage({profile:true, channel:a.channel, accountId:a.id, owner:a.owner, remotePeer:peer, peer:a.id+":"+peer,
          name: String(event.name || "").slice(0,200), phone:String(event.phone || "").slice(0,32),
          ...(a.channel==="Telegram" && typeof event.username==="string"?{username:event.username.slice(0,40)}:{}), photo});
      } else if (event.type === "message" && live.online) {
        const peer = String(event.peer || ""),
          remote = String(event.remote || "");
        if (!peer || !remote || peer.length > 150 || remote.length > 220)
          return;
        const file =
          typeof event.file?.bytes === "string" &&
          event.file.bytes.length <= 11200000
            ? {
                name: String(event.file.name || "Файл").slice(0, 180),
                bytes: Buffer.from(event.file.bytes, "base64"),
              }
            : null;
        onMessage({
          channel: a.channel,
          remoteId: remote,
          accountId: a.id,
          owner: a.owner,
          remotePeer: peer,
          peer: a.id + ":" + peer,
          name: String(event.name || peer).slice(0, 200),
          text: String(event.text || "").slice(0, 16000),
          outgoing: !!event.outgoing,
          history: !!event.history,
          at: Number.isFinite(Date.parse(event.at))
            ? new Date(event.at).toISOString()
            : new Date().toISOString(),
          mediaItems: a.channel==="MAX" && Array.isArray(event.media) ? event.media.slice(0,100) : [],
          directFile: file && file.bytes.length <= 8388608 ? file : null,
        });
      } else if (event.type === "revoked") {
        live.closing = true;
        live.online = false;
        set(a.id, "failed");
        child.kill();
      } else if (event.type === "error") {
        const reasons = {
          TimeoutError: "Время подтверждения истекло. Начните вход ещё раз.",
          CodeRejected: "MAX отклонил введённые коды. Начните новую попытку по номеру.",
          CodeExpired: "Срок действия SMS-кода истёк. Запросите новый код по номеру.",
          NoProfile: "MAX не нашёл зарегистрированный профиль для этого номера. Проверьте номер.",
          ConfirmationIncomplete: "MAX не завершил подтверждение профиля.",
          ConfirmationDenied: "MAX отклонил подтверждение входа по номеру. Проверьте уведомления в приложении MAX.",
          ApiError: "MAX отклонил запрос подключения. Выбранный способ входа сохранён.",
          RateLimit: "MAX временно ограничил попытки входа. Повторите позже.",
          PasswordAttemptsExceededError: "Мессенджер отклонил пароль двухэтапной проверки.",
          PermissionError: "Платформа отказала в доступе. Проверьте разрешения приложения.",
          ValidationError: "Формат ответа мессенджера изменился. Обратитесь к администратору BeChat.",
        };
        live.error = reasons[event.reason] || "Связь с мессенджером прервалась. Повторите подключение.";
        console.warn("BeChat pairing:", a.channel, row(a.id)?.status, /^[a-zA-Z]{1,50}$/.test(event.reason) ? event.reason : "Error");
      }
    }
    reader.on("line", (line) => {
      try {
        onLine(line);
      } catch {
        live.error = "Ошибка обработки ответа мессенджера.";
      }
    });
    const stopped = () => {
      if (running.get(a.id) !== live) return;
      clearTimeout(expire);
      running.delete(a.id);
      reader.close();
      for (const p of live.waiting.values()) {
        clearTimeout(p.timer);
        p.reject(Error("Связь с мессенджером прервана"));
      }
      const current = row(a.id);
      if (current && live.error) issues.set(a.id, live.error);
      if (!current || live.closing) return;
      set(a.id, current.external ? "offline" : "failed");
      if (current.external)
        retries.set(
          a.id,
          setTimeout(() => {
            const next = row(a.id);
            if (next && next.status === "offline") start(next);
          }, 60000).unref(),
        );
    };
    child.once("error", stopped);
    child.once("close", stopped);
  }
  async function connect(user, v) {
    if (!kinds.includes(v.channel) || v.token)
      fail(400, "Выберите вход в личный аккаунт");
    if (requirements(v.channel)) fail(503, requirements(v.channel));
    let a = owned(user.login, v.channel);
    const method = v.method || "qr";
    if (method !== "qr" && !(v.channel === "MAX" && method === "phone")) fail(400, "Выберите способ входа");
    if (a && running.has(a.id)) return list(user.login);
    const phone = String(v.phone || "").replace(/[\s()-]/g, "");
    if (method === "phone") {
      if (!/^\+[1-9]\d{6,14}$/.test(phone)) fail(400, "Введите номер с кодом страны, например +7…");
      const now = Date.now();
      const key = createHmac("sha256", env.BECHAT_ACCOUNT_KEY).update(phone).digest("hex");
      db.prepare("DELETE FROM personal_code_limits WHERE until<=?").run(now);
      const keys = [key, "owner:" + user.login];
      if (keys.some(k => db.prepare("SELECT 1 FROM personal_code_limits WHERE key=?").get(k)))
        fail(429, "Подождите минуту перед повторным запросом кода");
      for (const k of keys) db.prepare("INSERT INTO personal_code_limits VALUES(?,?)").run(k, now + 60000);
    }
    if (!a) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO direct_accounts(id,owner,channel,status,history) VALUES(?,?,?,'starting',?)",
      ).run(id, user.login, v.channel, 1);
      a = row(id);
    }
    if (!a.external) {
      db.prepare("UPDATE direct_accounts SET auth_method=?,history=? WHERE id=?").run(method, 1, a.id);
      a = row(a.id);
    }
    start(a, phone);
    return list(user.login);
  }
  async function answer(owner, channel, value) {
    const a = owned(owner, channel);
    if (
      !["password", "code"].includes(a?.status) ||
      typeof value !== "string" ||
      !value ||
      value.length > 500
    )
      fail(409, "Попытка входа завершена");
    if (a.status === "code" && !/^\d{4,10}$/.test(value)) fail(400, "Введите цифры из кода подтверждения");
    const live = running.get(a.id);
    if (a.status === "code" && live?.prompt?.digits && value.length!==live.prompt.digits)
      fail(400,"Введите все цифры из SMS");
    set(a.id, "confirming");
    await request(live, "answer", { answer: value });
    return list(owner);
  }
  async function vkCallback(params) {
    const state = params.get("state") || "";
    const match = [...running.values()].find(
      (v) =>
        v.vkState &&
        state.length === v.vkState.length &&
        /^[\w-]+$/.test(state) &&
        timingSafeEqual(Buffer.from(state), Buffer.from(v.vkState)),
    );
    if (!match || !params.get("code") || !params.get("device_id"))
      fail(400, "Подтверждение VK ID недействительно");
    match.vkState = null;
    match.prompt = null;
    await request(match, "answer", {
      answer: {
        state,
        code: params.get("code"),
        device_id: params.get("device_id"),
      },
    });
  }
  async function remove(owner, id) {
    const a = row(id);
    if (!a || a.owner !== owner) fail(404, "Аккаунт не найден");
    db.prepare("UPDATE direct_accounts SET status='removed' WHERE id=?").run(
      id,
    );
    clearTimeout(retries.get(id));
    retries.delete(id);
    const live = running.get(id);
    if (live) {
      live.closing = true;
      live.online = false;
      live.prompt = null;
      try {
        await request(live, "logout", {}, 7000);
      } catch {}
      live.child.kill();
      await live.finished;
    }
    issues.delete(id);
    if (/^[\da-f-]{36}$/.test(id))
      rmSync(join(directory, id), { recursive: true, force: true });
    return list(owner);
  }
  function pick(owner, channel) {
    const a = owned(owner, channel);
    return a?.status === "online" ? a.id : null;
  }
  async function resolvePeer(id, peer) {
    if (!row(id) || !running.get(id)?.online || !/^[-+@\w.]{1,110}$/.test(peer))
      fail(400, "Проверьте адрес получателя и статус аккаунта");
    const target = String(await request(running.get(id), "resolve", { peer }));
    if (!target || target.length > 150) fail(400, "Диалог недоступен");
    return target;
  }
  async function send(chat, m, file) {
    const meta = JSON.parse(chat.meta),
      a = row(meta.accountId),
      live = a && running.get(a.id);
    if (!a || !live?.online || a.owner !== chat.owner)
      fail(409, "Подключите ваш личный аккаунт");
    if (m.template)
      fail(400, "Для личного аккаунта выберите обычное сообщение");
    return String(
      await request(
        live,
        "send",
        {
          peer: meta.remotePeer,
          text: m.text,
          file: file
            ? {
                name: file.name, kind:m.file?.kind, duration:m.file?.duration,
                bytes: Buffer.from(file.bytes).toString("base64"),
              }
            : null,
        },
        90000,
      ),
    );
  }
  const restored = db
    .prepare(
      "SELECT * FROM direct_accounts WHERE external IS NOT NULL AND status NOT IN ('removed','failed')",
    )
    .all();
  db.exec(
    "UPDATE direct_accounts SET status='failed' WHERE external IS NULL AND status!='removed'",
  );
  for (const a of restored) {
    set(a.id, "offline");
    if (!requirements(a.channel)) start(a);
  }
  return {
    list,
    connect,
    answer,
    vkCallback,
    remove,
    pick,
    resolvePeer,
    async media(chat, ref) {
      const meta=JSON.parse(chat.meta), a=row(meta.accountId);
      if(!a || a.owner!==chat.owner || a.channel!=="MAX" || !running.get(a.id)?.online)
        fail(409,"Для открытия вложения подключите аккаунт MAX");
      return request(running.get(a.id),"media",{peer:meta.remotePeer,messageId:ref.message,slot:ref.slot});
    },
    send,
    available: (owner) =>
      list(owner)
        .filter((a) => a.ready)
        .map((a) => a.channel),
  };
}
