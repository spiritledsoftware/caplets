export const DISABLE_UPDATE_CHECK_ENV = "CAPLETS_DISABLE_UPDATE_CHECK";
export const UPDATE_NOTICE_STDERR_ENV = "CAPLETS_UPDATE_NOTICE_STDERR";

export type UpdateCheckEnv = Record<string, string | undefined> | NodeJS.ProcessEnv;

export function isUpdateCheckDisabled(env: UpdateCheckEnv = process.env): boolean {
  return env[DISABLE_UPDATE_CHECK_ENV] === "1" || env[DISABLE_UPDATE_CHECK_ENV] === "true";
}

export function isUpdateNoticeStderrOptIn(env: UpdateCheckEnv = process.env): boolean {
  return env[UPDATE_NOTICE_STDERR_ENV] === "1" || env[UPDATE_NOTICE_STDERR_ENV] === "true";
}
