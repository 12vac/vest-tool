// Local in-memory log (never on disk, never on the network) and record of the SHAPES seen (field names, not values).
const { describe, redact } = require('../domain/shapes');

const MAX = 300;
const entries = [];
const shapes = {}; // key -> shape (first seen and last, if different)
const listeners = new Set();

function log(level, msg, extra) {
  const e = { t: Date.now(), level, msg: redact(msg) };
  if (extra !== undefined) e.extra = redact(JSON.stringify(extra)).slice(0, 500);
  entries.push(e);
  if (entries.length > MAX) entries.shift();
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      /* a broken listener does not stop the log */
    }
  }
}

/** Records the shape of a response or message. Types only: safe to share. */
function noteShape(key, value) {
  const s = describe(value);
  const prev = shapes[key];
  if (!prev) shapes[key] = { first: s, at: Date.now() };
  else if (JSON.stringify(prev.first) !== JSON.stringify(s)) prev.latest = s;
}

const onLog = (fn) => (listeners.add(fn), () => listeners.delete(fn));

module.exports = {
  info: (m, x) => log('info', m, x),
  warn: (m, x) => log('warn', m, x),
  error: (m, x) => log('error', m, x),
  noteShape,
  onLog,
  entries: () => entries.slice(),
  shapes: () => JSON.parse(JSON.stringify(shapes)),
};
