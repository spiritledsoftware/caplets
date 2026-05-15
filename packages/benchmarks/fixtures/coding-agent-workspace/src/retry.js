function getRetryDelay(attempt) {
  const delays = [50, 150, 300];
  return delays[attempt - 1] ?? null;
}

function shouldRetry(statusCode) {
  return [500, 503].includes(statusCode);
}

module.exports = { getRetryDelay, shouldRetry };
