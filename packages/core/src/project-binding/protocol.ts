import { z } from "@hono/zod-openapi";
import { CAPLETS_ERROR_CODES } from "../errors";
import { PROJECT_BINDING_ERROR_CODES } from "./errors";

export const PROJECT_BINDING_SOCKET_PROTOCOL = "caplets.project-binding.v1";

export const projectBindingSocketProtocolSchema = z
  .literal(PROJECT_BINDING_SOCKET_PROTOCOL)
  .openapi("ProjectBindingSocketProtocol");

export const PROJECT_BINDING_STATES = [
  "not_attached",
  "attaching",
  "syncing",
  "ready",
  "degraded",
  "blocked",
  "offline",
  "cleaning_up",
  "ended",
  "expired",
] as const;

export const projectBindingStateSchema = z
  .enum(PROJECT_BINDING_STATES)
  .openapi("ProjectBindingState");
export type ProjectBindingState = z.infer<typeof projectBindingStateSchema>;

export const PROJECT_BINDING_SYNC_STATES = [
  "not_started",
  "pending",
  "syncing",
  "idle",
  "failed",
] as const;

export const projectBindingSyncStateSchema = z
  .enum(PROJECT_BINDING_SYNC_STATES)
  .openapi("ProjectBindingSyncState");
export type ProjectBindingSyncState = z.infer<typeof projectBindingSyncStateSchema>;

export const PROJECT_BINDING_READINESS_STATES = ["not_ready", "ready", "quarantined"] as const;

export const projectBindingReadinessSchema = z
  .enum(PROJECT_BINDING_READINESS_STATES)
  .openapi("ProjectBindingReadiness");
export type ProjectBindingReadiness = z.infer<typeof projectBindingReadinessSchema>;

export const PROJECT_BINDING_TERMINAL_REASON_CODES = [
  ...PROJECT_BINDING_ERROR_CODES,
  "interrupted",
  "completed",
] as const;

export const bindingTerminalReasonSchema = z
  .object({
    code: z.enum(PROJECT_BINDING_TERMINAL_REASON_CODES),
    message: z.string(),
    recoveryCommand: z.string().optional(),
    requestId: z.string().optional(),
  })
  .strict()
  .openapi("BindingTerminalReason");
export type BindingTerminalReason = z.infer<typeof bindingTerminalReasonSchema>;

const projectBindingIdentifierSchema = z.string().min(1);
const trimmedProjectBindingIdentifierSchema = z.string().trim().min(1);

const projectBindingSocketHeartbeatSchema = z
  .object({
    type: z.literal("heartbeat"),
    bindingId: projectBindingIdentifierSchema,
    sessionId: projectBindingIdentifierSchema,
    state: projectBindingStateSchema,
    syncState: projectBindingSyncStateSchema,
  })
  .strict();

const projectBindingSocketEndSchema = z
  .object({
    type: z.literal("end"),
    bindingId: projectBindingIdentifierSchema,
    sessionId: projectBindingIdentifierSchema,
    reason: bindingTerminalReasonSchema,
  })
  .strict();

export const projectBindingSocketClientMessageSchema = z
  .discriminatedUnion("type", [projectBindingSocketHeartbeatSchema, projectBindingSocketEndSchema])
  .openapi("ProjectBindingSocketClientMessage");
export type ProjectBindingSocketClientMessage = z.infer<
  typeof projectBindingSocketClientMessageSchema
>;

const projectBindingSocketStateSchema = z
  .object({
    type: z.literal("state"),
    state: projectBindingStateSchema,
    syncState: projectBindingSyncStateSchema,
    requestId: z.string().optional(),
  })
  .strict();

const projectBindingSocketReadySchema = z
  .object({
    type: z.literal("ready"),
    bindingId: projectBindingIdentifierSchema,
    sessionId: projectBindingIdentifierSchema,
    syncState: projectBindingSyncStateSchema,
    requestId: z.string().optional(),
  })
  .strict();

const projectBindingSocketBlockedSchema = z
  .object({
    type: z.literal("blocked"),
    reason: bindingTerminalReasonSchema,
  })
  .strict();

const projectBindingSocketEndedSchema = z
  .object({
    type: z.literal("ended"),
    reason: bindingTerminalReasonSchema,
  })
  .strict();

export const projectBindingSocketServerMessageSchema = z
  .discriminatedUnion("type", [
    projectBindingSocketStateSchema,
    projectBindingSocketReadySchema,
    projectBindingSocketBlockedSchema,
    projectBindingSocketEndedSchema,
  ])
  .openapi("ProjectBindingSocketServerMessage");
export type ProjectBindingSocketServerMessage = z.infer<
  typeof projectBindingSocketServerMessageSchema
>;

export const projectBindingSessionCreateRequestSchema = z
  .object({
    projectRoot: trimmedProjectBindingIdentifierSchema,
    projectFingerprint: trimmedProjectBindingIdentifierSchema,
  })
  .strict()
  .openapi("ProjectBindingSessionCreateRequest");
export type ProjectBindingSessionCreateRequest = z.infer<
  typeof projectBindingSessionCreateRequestSchema
>;

export const projectBindingResponseSchema = z
  .object({
    bindingId: projectBindingIdentifierSchema,
    state: projectBindingStateSchema,
    syncState: projectBindingSyncStateSchema,
    projectFingerprint: projectBindingIdentifierSchema,
    serverProjectRoot: projectBindingIdentifierSchema,
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .openapi("ProjectBinding");
export type ProjectBindingResponse = z.infer<typeof projectBindingResponseSchema>;

export const projectBindingSessionCreateResponseSchema = z
  .object({
    binding: projectBindingResponseSchema,
    sessionId: projectBindingIdentifierSchema,
  })
  .strict()
  .openapi("ProjectBindingSessionCreateResponse");
export type ProjectBindingSessionCreateResponse = z.infer<
  typeof projectBindingSessionCreateResponseSchema
>;

export const projectBindingHeartbeatRequestSchema = z
  .object({
    sessionId: trimmedProjectBindingIdentifierSchema,
    state: projectBindingStateSchema,
    syncState: projectBindingSyncStateSchema,
  })
  .strict()
  .openapi("ProjectBindingHeartbeatRequest");
export type ProjectBindingHeartbeatRequest = z.infer<typeof projectBindingHeartbeatRequestSchema>;

export const projectBindingHeartbeatResponseSchema = z
  .object({
    ok: z.literal(true),
    binding: projectBindingResponseSchema,
  })
  .strict()
  .openapi("ProjectBindingHeartbeatResponse");
export type ProjectBindingHeartbeatResponse = z.infer<typeof projectBindingHeartbeatResponseSchema>;

export const projectBindingSessionGetResponseSchema = z
  .object({
    ok: z.literal(true),
    binding: projectBindingResponseSchema,
    sessionId: projectBindingIdentifierSchema,
  })
  .strict()
  .openapi("ProjectBindingSessionGetResponse");
export type ProjectBindingSessionGetResponse = z.infer<
  typeof projectBindingSessionGetResponseSchema
>;

export const projectBindingSessionDeleteResponseSchema = z
  .object({
    ok: z.literal(true),
    binding: projectBindingResponseSchema,
  })
  .strict()
  .openapi("ProjectBindingSessionDeleteResponse");
export type ProjectBindingSessionDeleteResponse = z.infer<
  typeof projectBindingSessionDeleteResponseSchema
>;

const projectBindingNotAttachedStatusSchema = z
  .object({
    bindingId: projectBindingIdentifierSchema,
    state: z.literal("not_attached"),
  })
  .strict();

const projectBindingActiveStatusSchema = z
  .object({
    bindingId: projectBindingIdentifierSchema,
    state: projectBindingStateSchema,
    syncState: projectBindingSyncStateSchema,
    readiness: projectBindingReadinessSchema,
    active: z.literal(true),
    expiresAt: z.string().datetime(),
    affinity: z
      .object({
        ownerNodeId: projectBindingIdentifierSchema,
        currentNode: z.boolean(),
        required: z.boolean(),
      })
      .strict(),
  })
  .strict();

const projectBindingQuarantinedStatusSchema = z
  .object({
    bindingId: projectBindingIdentifierSchema,
    state: projectBindingStateSchema,
    syncState: projectBindingSyncStateSchema,
    readiness: z.literal("quarantined"),
    active: z.literal(false),
    requiresOperatorRebind: z.literal(true),
    ownerNodeId: projectBindingIdentifierSchema,
  })
  .strict();

export const projectBindingStatusResponseSchema = z
  .union([
    projectBindingResponseSchema,
    projectBindingNotAttachedStatusSchema,
    projectBindingActiveStatusSchema,
    projectBindingQuarantinedStatusSchema,
  ])
  .openapi("ProjectBindingStatusResponse");
export type ProjectBindingStatusResponse = z.infer<typeof projectBindingStatusResponseSchema>;

export const projectBindingLegacyErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum(CAPLETS_ERROR_CODES),
        message: z.string().optional(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("ProjectBindingLegacyErrorEnvelope");
export type ProjectBindingLegacyErrorEnvelope = z.infer<
  typeof projectBindingLegacyErrorEnvelopeSchema
>;

export const projectBindingTextAuthErrorSchema = z
  .union([z.literal("Unauthorized"), z.literal("Forbidden: access role required")])
  .openapi("ProjectBindingTextAuthError");

export const projectBindingConnectProbeSchema = z
  .object({ error: z.literal("websocket_upgrade_required") })
  .strict()
  .openapi("ProjectBindingConnectProbe");

export const projectBindingConnectQuerySchema = z
  .object({
    bindingId: projectBindingIdentifierSchema,
    sessionId: projectBindingIdentifierSchema,
    projectFingerprint: projectBindingIdentifierSchema,
  })
  .strict()
  .openapi("ProjectBindingConnectQuery");
export type ProjectBindingConnectQuery = z.infer<typeof projectBindingConnectQuerySchema>;
