export function getRetryDelay(attempt) {
  const delays = [50, 150, 300];
  return delays[attempt - 1] ?? null;
}

export function shouldRetry(statusCode) {
  return [409, 500, 503].includes(statusCode);
}
