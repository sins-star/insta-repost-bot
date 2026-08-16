import crypto from 'node:crypto';
import { log } from './logger.js';

/**
 * Serverless job dispatch — the trick that makes Cloud Run work.
 *
 * On Cloud Run's request-based (free) billing, CPU is only allocated while a
 * request is in flight. The bot deliberately answers Telegram's webhook BEFORE
 * downloading — answering late makes Telegram redeliver the update, which
 * double-posts — so on Cloud Run the download would start and immediately
 * freeze when the webhook response goes out.
 *
 * The fix: the webhook handler POSTs the job to this same service at /work.
 * The /work handler streams one byte back straight away (proof the request is
 * registered), then runs the whole job INSIDE that request, holding it open.
 * An open request means allocated CPU. The webhook handler waits only for that
 * first byte — milliseconds — then answers Telegram.
 *
 * The connection is self-sustaining: the /work request keeps the instance's
 * CPU on, which keeps the in-process reader of its own response alive, which
 * keeps the connection open. Set the service's request timeout to cover the
 * longest job (30 minutes is generous).
 *
 * Security: /work runs arbitrary-ish jobs, so it must not be publicly
 * invokable. The token is random per process and the dispatching side lives in
 * the same process, so it never needs to be shared, stored, or rotated. With
 * max-instances=1 the self-call always lands on the process that minted it.
 */

const WORK_PATH = '/work';
const MAX_BODY_BYTES = 64 * 1024;

export function createDispatcher({ baseUrl, runJob }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const workUrl = `${baseUrl.replace(/\/+$/, '')}${WORK_PATH}`;

  /** Handle POST /work. Returns true if this request was for us. */
  async function handle(req, res) {
    if (req.method !== 'POST' || req.url !== WORK_PATH) return false;

    if (req.headers['x-work-token'] !== token) {
      // Either a stranger probing, or a call minted by a previous instance
      // that died. Neither may run work.
      res.writeHead(403).end();
      return true;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        return true;
      }
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return true;
    }

    // First byte out immediately: this is what the dispatcher awaits, and from
    // here on the open response is what keeps the CPU allocated.
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('started\n');

    try {
      await runJob(payload);
      res.end('done\n');
    } catch (err) {
      // The job reports its own failures to the admin chat; this stream is
      // plumbing, not a user surface.
      log.error('work request failed —', err.message);
      res.end('failed\n');
    }
    return true;
  }

  /**
   * Hand a job to /work and return once it has provably started.
   *
   * Resolves after the first byte of the response — NOT after the job — so the
   * webhook handler can answer Telegram fast. The rest of the stream is drained
   * in the background and deliberately never cancelled: cancelling tells the
   * platform the client is gone, and Cloud Run ends abandoned requests, which
   * would freeze the job it exists to keep alive.
   */
  async function dispatch(payload) {
    const res = await fetch(workUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-work-token': token },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      throw new Error(`work dispatch was refused (${res.status})`);
    }

    const reader = res.body.getReader();
    await reader.read();

    void (async () => {
      try {
        while (!(await reader.read()).done) {
          /* drain until the job's request closes */
        }
      } catch (err) {
        log.warn('work stream ended early —', err.message);
      }
    })();
  }

  return { handle, dispatch, workPath: WORK_PATH };
}
