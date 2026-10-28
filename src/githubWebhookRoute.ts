import express, { NextFunction, Request, Response, Router } from 'express';
import {
  githubPullRequestReward,
  verifyGithubSignature,
} from './services/githubWebhook';
import { processReward, ProcessRewardDeps } from './services/processReward';
import { sendRewardResult } from './rewardsRoute';

export const GITHUB_WEBHOOK_PATH = '/api/v1/github/webhook';
const MAX_BODY = '1mb';

export interface GithubWebhookRouteDeps extends ProcessRewardDeps {
  // Read per request so rotating the App Service setting needs no code path;
  // tests pass their own.
  webhookSecret?: () => string | undefined;
  now?: () => number;
}

/**
 * Router for `POST /api/v1/github/webhook`: GitHub calls it directly, signed
 * with `X-Hub-Signature-256` (HMAC-SHA256 of the raw body under
 * `GITHUB_WEBHOOK_SECRET`). A merged pull request becomes a `githubPrMerged`
 * reward through the same `processReward` pipeline as `POST /api/v1/rewards`,
 * keyed by the signed pull request id (see `githubPullRequestReward`), so a
 * redelivery, or a captured request resent under a new `X-GitHub-Delivery`,
 * replays instead of paying again.
 *
 * Mount it before `express.json()`: the signature covers the exact bytes
 * GitHub sent, so this route reads the raw body itself.
 *
 * Fails closed: no secret is a 503, a missing or wrong signature a 401, and
 * neither reaches the ledger.
 */
export const createGithubWebhookRouter = (
  deps: GithubWebhookRouteDeps,
): Router => {
  const {
    webhookSecret = () => process.env.GITHUB_WEBHOOK_SECRET,
    now = Date.now,
  } = deps;
  const router = Router();
  const rawJson = express.raw({ type: 'application/json', limit: MAX_BODY });

  router.post(
    GITHUB_WEBHOOK_PATH,
    (req: Request, res: Response, next: NextFunction) => {
      // Checked before reading the body: an unconfigured bot refuses
      // everything without buffering a megabyte of someone else's JSON.
      if (!webhookSecret()) {
        res
          .status(503)
          .json({ error: 'GitHub webhook disabled: no secret configured' });
        return;
      }
      rawJson(req, res, (error?: unknown) => {
        if (error) {
          const status =
            typeof (error as { status?: unknown }).status === 'number'
              ? (error as { status: number }).status
              : 400;
          res.status(status).json({
            error:
              status === 413 ? 'payload too large' : 'invalid request body',
          });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      const secret = webhookSecret() ?? '';
      if (!Buffer.isBuffer(req.body)) {
        // Wrong content type: express.raw left the body unread.
        res
          .status(415)
          .json({ error: 'content type must be application/json' });
        return;
      }
      if (
        !verifyGithubSignature(
          req.body,
          req.header('x-hub-signature-256'),
          secret,
        )
      ) {
        res.status(401).json({ error: 'invalid signature' });
        return;
      }

      const event = req.header('x-github-event');
      if (event !== 'pull_request') {
        // `ping` and every event we do not reward: acknowledged, nothing done.
        res.status(204).end();
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'body is not valid JSON' });
        return;
      }

      const reward = githubPullRequestReward(payload, now());
      switch (reward.kind) {
        case 'ignored':
          // Opened, edited, closed without merge: not a reward.
          res.status(204).end();
          return;
        case 'invalid':
          res.status(400).json({ error: reward.error });
          return;
        case 'too-old':
          res.status(422).json({ error: 'merge is too old to reward' });
          return;
        case 'not-rewarded':
          // A 2xx: the delivery was understood, and redelivering it changes
          // nothing. The reason shows in GitHub's Recent deliveries.
          res
            .status(200)
            .json({ status: 'not-rewarded', reason: reward.reason });
          return;
        case 'reward':
          sendRewardResult(
            res,
            await processReward(deps, {
              idempotencyKey: reward.idempotencyKey,
              body: reward.body,
            }),
          );
      }
    },
  );

  return router;
};
