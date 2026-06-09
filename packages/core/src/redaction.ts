export const SECRET_KEY_PATTERN =
  /(token|secret|authorization|auth|api[-_]?key|password|credential|clientsecret|client_secret|code|refresh)/iu;

export const SECRET_TEXT_PATTERNS = [
  /(Authorization:\s*Bearer\s+)[0-9A-Za-z._~+/=-]+/giu,
  /(bearer\s+)[a-z0-9._~+/=-]+/giu,
  /([?&](?:access_token|refresh_token|token|code)=)[^&\s]+/giu,
] as const;

export type RedactionResult = {
  text: string;
  redacted: boolean;
};

export type RedactionOptions = {
  patterns?: readonly RegExp[] | undefined;
  additionalSecrets?: readonly string[] | undefined;
  replacement?: string | undefined;
};

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactSecretText(value: string, options: RedactionOptions = {}): RedactionResult {
  const replacement = options.replacement ?? "[REDACTED]";
  let text = value;
  for (const pattern of [...(options.patterns ?? []), ...SECRET_TEXT_PATTERNS]) {
    text = text.replace(pattern, (...args: unknown[]) => {
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return `${prefix}${replacement}`;
    });
  }
  for (const secret of options.additionalSecrets?.filter(Boolean) ?? []) {
    text = text.split(secret).join(replacement);
  }
  return { text, redacted: text !== value };
}

export function redactUnknownSecrets<T>(value: T, options: RedactionOptions = {}): T {
  if (typeof value === "string") return redactSecretText(value, options).text as T;
  if (Array.isArray(value)) return value.map((item) => redactUnknownSecrets(item, options)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSecretKey(key) ? "[REDACTED]" : redactUnknownSecrets(entry, options),
    ]),
  ) as T;
}
