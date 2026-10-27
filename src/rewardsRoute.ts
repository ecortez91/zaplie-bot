import { Response, Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { getWebhookKeyHashes } from './services/fetchWebhookKeys';
import { RewardError } from './services/rewardsService';
import {
  IDEMPOTENCY_KEY_PATTERN,
  processReward,
  ProcessRewardDeps,
  ProcessRewardResult,
} from './services/processReward';

/**
 * True if the presented key matches `REWARDS_API_KEY` or the hash of any
 * active portal-managed key (created and revoked by admins in Automations).
 *
 * @throws RewardError 503 when no key is configured anywhere
 */
export const isAuthorizedRewardKey = async (
  providedKey: string,
): Promise<boolean> => {
  const envKey = process.env.REWARDS_API_KEY;
  if (envKey) {
    // Buffers, not strings: timingSafeEqual throws on byte-length mismatch.
    const provided = Buffer.from(providedKey);
    const expected = Buffer.from(envKey);
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      return true;
    }
  }
  const hashes = await getWebhookKeyHashes();
  if (!envKey && hashes.length === 0) {
    throw new RewardError(
      'rewards endpoint disabled: no API keys configured',
      503,
    );
  }
  const providedHash = createHash('sha256').update(providedKey).digest('hex');
  return hashes.includes(providedHash);
};

export interface RewardsRouteDeps extends ProcessRewardDeps {
  isAuthorizedRewardKey?: (providedKey: string) => Promise<boolean>;
}

/**
 * Sends a processReward result. A replay carries `Idempotency-Replayed: true`.
 */
export const sendRewardResult = (
  res: Response,
  result: ProcessRewardResult,
): void => {
  if (result.replayed) {
    res.set('Idempotency-Replayed', 'true');
  }
  res.status(result.status).json(result.body);
};

/**
 * Router for `POST /api/v1/rewards`, the deterministic automation path: no
 * LLM can trigger a payment here. Every request needs an `Idempotency-Key`,
 * claimed in the reward ledger before anything is paid, so a repeat replays
 * the first result instead of paying again.
 *
 * @param deps the ledger, plus optional stand-ins for the reward services
 *   (tests only; each defaults to the real module)
 */
export const createRewardsRouter = (deps: RewardsRouteDeps): Router => {
  const { isAuthorizedRewardKey: isAuthorized = isAuthorizedRewardKey } = deps;
  const router = Router();

  router.post('/api/v1/rewards', async (req, res) => {
    try {
      if (!(await isAuthorized(req.header('x-api-key') ?? ''))) {
        res.status(401).json({ error: 'invalid API key' });
        return;
      }
    } catch (error) {
      if (error instanceof RewardError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error('rewards key validation failed:', error);
      res.status(503).json({ error: 'rewards endpoint unavailable' });
      return;
    }

    // Required rather than derived from the body: only the caller knows what
    // makes two deliveries the same (GitHub's X-GitHub-Delivery), and two
    // genuine identical rewards must still both pay.
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) {
      res.status(400).json({ error: 'Idempotency-Key header is required' });
      return;
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      res.status(400).json({ error: 'Idempotency-Key header is invalid' });
      return;
    }

    sendRewardResult(
      res,
      await processReward(deps, { idempotencyKey, body: req.body }),
    );
  });

  return router;
};
