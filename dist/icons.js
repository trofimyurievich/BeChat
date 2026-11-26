"use strict";
const paths = {
  edit: '<path d="m4 16 12-12a2 2 0 0 1 3 3L7 19l-4 1zM14 6l3 3"/>',
  copy: '<rect x="8" y="5" width="12" height="16" rx="2"/><path d="M5 17H4a1 1 0 0 1-1-1V4a2 2 0 0 1 2-2h10"/>',
  forward: '<path d="m15 4 7 7-7 7v-5c-6 0-10 2-12 6 0-9 4-12 12-11z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14"/>',
  select: '<circle cx="12" cy="12" r="9"/><path d="m7.5 12 3 3 6-6"/>',
  chat: '<path d="M20 11a8.5 8.5 0 0 1-9 8 12 12 0 0 1-3-.4L3 21l1.3-5.2A7.5 7.5 0 0 1 3 11a8.5 8.5 0 0 1 17 0Z"/><path d="M7.5 9h8M7.5 12.5h5"/>',
  folder: '<path d="M3 7V5h6l2 2h10v12H3Z"/>',
  archive:
    '<rect x="3" y="3.5" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/>',
  templates:
    '<rect x="6" y="5" width="14" height="16" rx="2"/><path d="M3 16V4a2 2 0 0 1 2-2h10M10 10h6m-6 4h4"/>',
  network:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="m8 6 7 .9m1.6 3.2-5.8 5.9M6 9l2 6"/>',
  settings:
    '<path d="m10 3 4 .1.8 2.4 2 .9 2.3-.8 2 3.4-1.7 1.9v2.2l1.6 1.9-2 3.5-2.4-.6-1.8 1-.9 2.3H10l-.8-2.4-2-1-2.4.7-2-3.4 1.7-2v-2.2L3 9 5 5.6l2.4.8 1.9-1Z"/><circle cx="12" cy="12" r="3"/>',
  compose: '<path d="M11 5H5v14h14v-7m-8.5 1.5L11 10l8-8 3 3-8 8Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  telegram: '<path d="m3 10 18-7-4.4 17-5.2-4.8-2.8 2.3.3-5 8-6-10 5.4Z"/>',
  whatsapp:
    '<path d="M20 11a8 8 0 0 1-11 8l-5 1 1.1-4.6A8 8 0 1 1 20 11Z"/><path d="M8.3 7c.6-.8 2 1.6 1.6 2.3l-.6.8c.4 1.5 1.7 2.8 3.4 3.4l.8-.8c.8-.3 2.7 1.1 2.4 1.9-.8 2-3.5 1.6-5.8-.5C7.8 12 7 8.7 8.3 7Z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  panel:
    '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  check: '<path d="m4 12 4 4L20 5"/>',
  checks: '<path d="m2 12 4 4L17 5m-5 9 2 2L24 6"/>',
  pin: '<path d="m13 3 8 8-3 1-3 4-2 .3-3-3-6 6 6-6-2-2 .2-2 4-3Z"/>',
  attach:
    '<path d="m8 13 6-6a2.3 2.3 0 0 1 3.2 3.2l-8 8a4 4 0 0 1-5.7-5.7l9-9a5.4 5.4 0 0 1 7.6 7.6l-8.6 8.6"/>',
  smile:
    '<circle cx="12" cy="12" r="9"/><path d="M8 14a4.5 4.5 0 0 0 8 0M8.5 9h.1m6.8 0h.1"/>',
  send: '<path d="m3 10 18-7-6.5 18-3.8-7.7Z"/><path d="m10.7 13.3 6.9-6.9"/>',
  note: '<path d="M14 20H5V4h14v11Zm0 0v-5h5M8 8h8m-8 4h5"/>',
  file: '<path d="M5 3h9l5 5v13H5Zm9 0v6h5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  brief:
    '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3M3 12q9 5 18 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  reply: '<path d="m9 4-7 7 7 7v-5c6 0 10 2 12 6 0-9-4-12-12-11Z"/>',
  star: '<path d="m12 3 2.6 5.7 6.4.8-4.8 4.5 1.2 6.3L12 17l-5.4 3.3 1.1-6.3L3 9.5l6.4-.8Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  link: '<path d="M10 14l5-5m-8 2-2 2a4 4 0 0 0 6 6l3-3m-4-7 3-3a4 4 0 0 1 6 6l-2 2"/>',
  phone: '<path d="m7 3 3 5-2 2q2 4 6 6l2-2 5 3-2 4C10 21 3 13 3 5Z"/>',
  external: '<path d="M13 4h7v7m0-7L9 15m0-10H4v15h15v-5"/>',
  tag: '<path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/>',
};
document.getElementById("symbols").innerHTML = Object.entries(paths)
  .map(
    ([name, draw]) =>
      '<symbol id="i-' + name + '" viewBox="0 0 24 24">' + draw + "</symbol>",
  )
  .join("");
function icon(name) {
  return '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
}
