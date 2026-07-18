/**
 * lib/logger.js — minimal structured logger for the AOP ingestion service.
 *
 * Role in the AOP data flow:
 *   Cross-cutting concern used by every runtime module (db pool, routes,
 *   loss sweep, boot/shutdown). The platform's prime directive — a telemetry
 *   or analytics failure must NEVER break the merchant's live traffic — means
 *   this service swallows and logs a lot of errors instead of throwing them;
 *   those log lines are the only forensic trail left behind, so they are
 *   emitted as single-line JSON for machine ingestion (Datadog/CloudWatch/
 *   whatever the deployment pipes stdout into).
 *
 * Deliberately dependency-free (HARD RULE: only express + pg are allowed as
 * runtime deps) and deliberately tiny: levels, a static context prefix, and
 * safe serialization. Nothing here can throw — a logger that crashes the
 * process it is narrating would violate the prime directive.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Serialize a log record defensively. Error objects are flattened to
 * name/message/stack (JSON.stringify would yield "{}" for them), and circular
 * structures fall back to a best-effort line instead of throwing.
 */
function serialize(record) {
  try {
    return JSON.stringify(record, (key, value) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      return value;
    });
  } catch {
    // Circular / hostile fields: drop them, keep the message.
    try {
      return JSON.stringify({ level: record.level, msg: record.msg, ts: record.ts, serialization: 'failed' });
    } catch {
      return '{"level":"error","msg":"logger serialization failed"}';
    }
  }
}

/**
 * Create a logger.
 * @param {string} component  static label stamped on every line (e.g. "webhooks")
 * @param {{minLevel?: 'debug'|'info'|'warn'|'error', sink?: (line:string)=>void}} [options]
 *   sink is injectable for tests; defaults to process.stdout-backed console.
 * @returns {{debug:Function, info:Function, warn:Function, error:Function, child:(sub:string)=>object}}
 */
export function createLogger(component, options = {}) {
  const minLevel = LEVELS[options.minLevel] ?? LEVELS.info;
  // console.log is used (not process.stdout.write) so the logger also behaves
  // in environments that hook console (test runners, some PaaS log shippers).
  const sink = typeof options.sink === 'function' ? options.sink : (line) => console.log(line);

  function emit(level, msg, fields) {
    try {
      if (LEVELS[level] < minLevel) return;
      const record = {
        ts: new Date().toISOString(),
        level,
        component,
        msg: typeof msg === 'string' ? msg : String(msg),
        ...(fields && typeof fields === 'object' ? fields : {}),
      };
      sink(serialize(record));
    } catch {
      // Never let logging failures propagate into request handling / sweeps.
    }
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    /** Namespaced sub-logger, e.g. logger.child('loss-sweep'). */
    child: (sub) => createLogger(`${component}.${sub}`, options),
  };
}
