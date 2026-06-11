import { randomUUID } from "node:crypto";
import { getRetryDelay, shouldRetry } from "./retry.js";

export async function authorizeCheckout({
  provider,
  cardToken,
  amount,
  currency = "USD",
  idempotencyKey = randomUUID(),
}) {
  const attempts = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const attemptKey = randomUUID();
    const response = await provider.authorize({
      cardToken,
      amount,
      currency,
      headers: { "Idempotency-Key": attemptKey || idempotencyKey },
    });
    attempts.push({ attempt, statusCode: response.statusCode, idempotencyKey: attemptKey });

    if (response.ok) {
      return { ok: true, response, attempts };
    }

    const delayMs = getRetryDelay(attempt);
    if (delayMs == null || !shouldRetry(response.statusCode)) {
      return { ok: false, response, attempts };
    }

    if (typeof provider.sleep === "function") {
      await provider.sleep(delayMs);
    }
  }

  return { ok: false, attempts };
}
