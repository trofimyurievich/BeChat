// A messenger may report a read position before the corresponding history or send acknowledgement arrives.
export function createReadReceipts(db, advance, notify) {
  db.exec(`CREATE TABLE IF NOT EXISTS read_positions (
    channel TEXT, peer TEXT, basis TEXT, position INTEGER NOT NULL,
    PRIMARY KEY(channel,peer,basis));
    CREATE TABLE IF NOT EXISTS direct_receipts (
    channel TEXT, peer TEXT, remote TEXT, status TEXT NOT NULL,
    PRIMARY KEY(channel,peer,remote));`);
  const q = sql => db.prepare(sql);
  const basisFor = {MAX:"time", Telegram:"id", "ВКонтакте":"id"};
  function forMessage(channel, peer, remote, at) {
    if (!remote) return;
    const exact = q("SELECT status FROM direct_receipts WHERE channel=? AND peer=? AND remote=?").get(channel,peer,String(remote));
    if (exact?.status === "read") return "read";
    const basis = basisFor[channel];
    const point = basis === "time" ? Date.parse(at) : Number(remote);
    if (basis && Number.isSafeInteger(point) && point > 0 &&
        q("SELECT 1 FROM read_positions WHERE channel=? AND peer=? AND basis=? AND position>=?").get(channel,peer,basis,point)) return "read";
    return exact?.status;
  }
  function receive({channel,peer,remoteId,status,basis,position}) {
    const chat = q("SELECT id FROM chats WHERE channel=? AND peer=?").get(channel,peer);
    let rows = [];
    if (basis) {
      if (basis !== basisFor[channel] || !Number.isSafeInteger(position) || position <= 0 || (basis === "time" && position > Date.now()+60000)) return;
      const changed = q(`INSERT INTO read_positions VALUES(?,?,?,?) ON CONFLICT(channel,peer,basis)
        DO UPDATE SET position=excluded.position WHERE excluded.position>read_positions.position`).run(channel,peer,basis,position);
      if (!changed.changes || !chat) return;
      const expr = basis === "time" ? "json_extract(body,'$.at') <= ?" : "remote NOT GLOB '*[^0-9]*' AND CAST(remote AS INTEGER) <= ?";
      rows = q(`SELECT body FROM messages WHERE chat=? AND remote IS NOT NULL AND json_extract(body,'$.side')='out'
        AND json_extract(body,'$.status') IN ('sent','delivered') AND ${expr}`).all(chat.id,basis === "time" ? new Date(position).toISOString() : position);
      status = "read";
    } else {
      if (!remoteId || !["delivered","read"].includes(status)) return;
      const written=q(`INSERT INTO direct_receipts VALUES(?,?,?,?) ON CONFLICT(channel,peer,remote)
        DO UPDATE SET status=excluded.status WHERE direct_receipts.status='delivered' AND excluded.status='read'`).run(channel,peer,remoteId,status);
      if (!written.changes) return;
      if (chat) rows = q("SELECT body FROM messages WHERE chat=? AND remote=? AND json_extract(body,'$.side')='out'").all(chat.id,remoteId);
    }
    let changed = false;
    for (const {body} of rows) {
      const m = JSON.parse(body);
      if (m.status === status || m.status === "read" || m.status === "failed") continue;
      advance(m,status);
      changed = true;
    }
    if (changed) notify(chat.id);
  }
  return {receive, forMessage};
}
