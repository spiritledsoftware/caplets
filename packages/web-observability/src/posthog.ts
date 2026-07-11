import { buildWebEvent } from "./events";
import type { WebEventName, WebEventProperties, WebEventPropertySet } from "./events";
import { assertWebEventSafeProperties } from "./privacy";

export type PostHogFinalProperties = WebEventPropertySet & {
  token: string;
  distinct_id: string;
  $process_person_profile: false;
  $geoip_disable: true;
};

export type PostHogFinalCapture = {
  uuid: string;
  event: WebEventName;
  properties: PostHogFinalProperties;
  timestamp?: Date;
};

export type PostHogFinalSanitizer = (input: unknown) => PostHogFinalCapture | null;

export type PostHogCaptureCapability = {
  capture(name: WebEventName, properties: WebEventProperties): unknown;
};

export function sanitizePostHogCapture(input: unknown): PostHogFinalCapture | null {
  try {
    if (!isRecord(input) || !isRecord(input.properties)) return null;

    const uuid = nonemptyString(input.uuid);
    const token = nonemptyString(input.properties.token);
    const distinctId = nonemptyString(input.properties.distinct_id);
    if (!uuid || !token || !distinctId) return null;
    if (input.properties.$is_identified !== false || input.properties.$device_id !== distinctId) {
      return null;
    }

    const timestamp = input.timestamp;
    if (timestamp !== undefined && !isTimestamp(timestamp)) return null;

    const event = buildFinalWebEvent(input.event, categoricalProperties(input.properties));
    if (!event) return null;

    return {
      uuid,
      event: event.name,
      properties: {
        token,
        distinct_id: distinctId,
        ...event.properties,
        $process_person_profile: false,
        $geoip_disable: true,
      },
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  } catch {
    return null;
  }
}

export function createPostHogBeforeSend(
  sanitizer: PostHogFinalSanitizer = sanitizePostHogCapture,
): (input: unknown) => PostHogFinalCapture | null {
  return (input) => {
    try {
      return sanitizer(input);
    } catch {
      return null;
    }
  };
}

export function capturePostHogEvent<Name extends WebEventName>(
  capability: PostHogCaptureCapability,
  event: { name: Name; properties: WebEventProperties<Name> },
): void {
  try {
    capability.capture(event.name, event.properties);
  } catch {
    // Provider capture must never interrupt a public-site interaction.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTimestamp(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function categoricalProperties(input: Record<string, unknown>): WebEventPropertySet {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    try {
      assertWebEventSafeProperties({ [key]: value });
      properties[key] = value;
    } catch {
      // Final provider payloads silently drop SDK and application additions.
    }
  }
  return properties as WebEventPropertySet;
}

function buildFinalWebEvent(
  name: unknown,
  properties: WebEventPropertySet,
): { name: WebEventName; properties: WebEventProperties } | null {
  if (typeof name !== "string") return null;
  try {
    return buildWebEvent({
      name: name as WebEventName,
      properties: properties as WebEventProperties,
    });
  } catch {
    return null;
  }
}
