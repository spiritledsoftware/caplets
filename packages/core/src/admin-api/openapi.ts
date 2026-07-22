import { OpenAPIHono, createRoute, type RouteConfig, z } from "@hono/zod-openapi";
import {
  PROJECT_BINDING_SOCKET_PROTOCOL,
  projectBindingConnectProbeSchema,
  projectBindingConnectQuerySchema,
  projectBindingHeartbeatRequestSchema,
  projectBindingHeartbeatResponseSchema,
  projectBindingLegacyErrorEnvelopeSchema,
  projectBindingSessionCreateRequestSchema,
  projectBindingSessionCreateResponseSchema,
  projectBindingSessionDeleteResponseSchema,
  projectBindingSessionGetResponseSchema,
  projectBindingStatusResponseSchema,
  projectBindingTextAuthErrorSchema,
} from "../project-binding/protocol";
import {
  OPERATOR_ACTIVITY_ACTION_MAX_LENGTH,
  OPERATOR_ACTIVITY_ACTION_PATTERN,
} from "../storage/operator-activity";
import { adminBundleInstallationSchema } from "./bundle-contract";

const JSON_MEDIA = "application/json";
const PROBLEM_MEDIA = "application/problem+json";
const MERGE_PATCH_MEDIA = "application/merge-patch+json";
const MULTIPART_FORM_MEDIA = "multipart/form-data";
const MULTIPART_MIXED_MEDIA = "multipart/mixed";
const EVENT_STREAM_MEDIA = "text/event-stream";
const TEXT_MEDIA = "text/plain";

const bearerSecurity: NonNullable<RouteConfig["security"]> = [{ bearerAuth: [] }];
const adminSecurity: NonNullable<RouteConfig["security"]> = [
  { bearerAuth: [] },
  { dashboardSession: [] },
];
const publicSecurity: NonNullable<RouteConfig["security"]> = [];

const problemSchema = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    code: z.string().min(1),
    nextAction: z.string().optional(),
    links: z.record(z.string(), z.string().url()).optional(),
  })
  .openapi("Problem");

const resourceSchema = z
  .object({
    id: z.string().min(1),
    generation: z.number().int().nonnegative().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    state: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("AdminResource");

function cursorPageSchema(name: string, itemSchema: z.ZodType) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().min(1).optional(),
    })
    .strict()
    .openapi(name);
}

export const adminV2CursorQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    sort: z
      .literal("desc")
      .optional()
      .describe("Omit for ascending order; pass desc for descending order."),
  })
  .strict();
const timestampSchema = z.string().datetime().max(40);
const generationSchema = z.number().int().nonnegative();
const domainObjectSchema = z.record(z.string(), z.unknown());
const roleSchema = z.enum(["access", "operator"]);
export const ADMIN_CATALOG_MUTATION_MAX_CAPLETS = 500;
export const ADMIN_INSTALLATION_SOURCE_IDENTITY_MAX_LENGTH = 64 * 1024;
export const ADMIN_INSTALLATION_RISK_MAX_LIST_ITEMS = 64;
export const ADMIN_INSTALLATION_RISK_MAX_STRING_LENGTH = 512;
export const ADMIN_MUTATION_DOCUMENT_MAX_LENGTH = 1024 * 1024;

const installationRiskStringSchema = z
  .string()
  .min(1)
  .max(ADMIN_INSTALLATION_RISK_MAX_STRING_LENGTH);
const installationRiskStringListSchema = z
  .array(installationRiskStringSchema)
  .max(ADMIN_INSTALLATION_RISK_MAX_LIST_ITEMS);
const installationRiskSchema = z
  .object({
    backendFamilies: z
      .array(z.string().min(1).max(128))
      .max(ADMIN_INSTALLATION_RISK_MAX_LIST_ITEMS),
    safety: z.enum(["standard", "mutating_saas", "local_control", "unknown"]),
    projectBindingRequired: z.boolean(),
    authScopes: installationRiskStringListSchema.optional(),
    runtimeFeatures: installationRiskStringListSchema.optional(),
    mutating: z.boolean(),
    destructive: z.boolean(),
    bodyHash: z.string().min(1).max(128).optional(),
    referenceHash: z.string().min(1).max(128).optional(),
  })
  .strict()
  .openapi("AdminCapletInstallationRisk");
const setupActionSchema = z
  .object({
    kind: z.enum([
      "auth",
      "vault",
      "project_binding",
      "backend_check",
      "exposure_validation",
      "code_mode",
    ]),
    label: z.string(),
    required: z.boolean(),
  })
  .strict()
  .openapi("AdminSetupAction");
const hostSummarySchema = z
  .object({
    host: z
      .object({
        current: z.literal(true),
        baseUrl: z.string().url(),
        dashboardUrl: z.string().url(),
        version: z.string(),
        roleModel: z.literal("current-host"),
      })
      .strict(),
    attention: z.array(
      z
        .object({
          kind: z.literal("pending-login"),
          severity: z.literal("warning"),
          label: z.string(),
          href: z.string(),
        })
        .strict(),
    ),
    sections: z
      .object({
        caplets: z.object({ count: z.number().int().nonnegative(), href: z.string() }).strict(),
        catalog: z.object({ href: z.string() }).strict(),
        access: z
          .object({
            clients: z.number().int().nonnegative(),
            pending: z.number().int().nonnegative(),
            href: z.string(),
          })
          .strict(),
        vault: z.object({ count: z.number().int().nonnegative(), href: z.string() }).strict(),
        projectBinding: z
          .object({ state: z.enum(["connected", "disconnected"]), href: z.string() })
          .strict(),
        runtime: z.object({ status: z.enum(["ok", "error"]), href: z.string() }).strict(),
        logs: z.object({ href: z.string() }).strict(),
        diagnostics: z.object({ href: z.string() }).strict(),
        activity: z.object({ href: z.string() }).strict(),
        settings: z.object({ href: z.string() }).strict(),
      })
      .strict(),
  })
  .strict()
  .openapi("AdminHostSummary");
const runtimeSchema = z
  .object({
    runtime: z
      .object({
        status: z.enum(["ok", "error"]),
        version: z.string(),
        bind: z.string(),
        baseUrl: z.string().url(),
        publicOrigin: z.string().url().nullable(),
        reason: z.string().optional(),
      })
      .strict(),
    daemon: z
      .object({
        restartAvailable: z.boolean(),
        stopAvailable: z.boolean(),
        uninstallAvailable: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .openapi("AdminRuntime");
const adminRuntimeEventRuntimeSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), version: z.string() }).strict(),
    z
      .object({
        status: z.literal("error"),
        version: z.string(),
        reason: z.string().optional(),
      })
      .strict(),
  ])
  .openapi("AdminRuntimeEventRuntime");
export const adminRuntimeEventSchema = z
  .object({
    type: z.literal("runtime_health"),
    runtime: adminRuntimeEventRuntimeSchema,
    projectBinding: z.object({ state: z.enum(["connected", "disconnected"]) }).strict(),
  })
  .strict()
  .openapi("AdminRuntimeEvent");
const runtimeRestartResultSchema = z
  .object({
    restartAvailable: z.literal(true),
  })
  .strict()
  .openapi("AdminRuntimeRestartResult");
const logEntrySchema = z
  .object({
    timestamp: timestampSchema,
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
    message: z.string(),
    source: z.string().optional(),
  })
  .strict()
  .openapi("AdminLogEntry");
const logPageSchema = cursorPageSchema("AdminLogPage", logEntrySchema);
const diagnosticsSchema = z
  .object({
    status: z.enum(["ok", "warning", "error"]),
    diagnostics: z.array(
      z.object({ id: z.string(), status: z.string(), detail: z.string().optional() }).strict(),
    ),
    checks: z.array(
      z
        .object({
          id: z.string(),
          status: z.enum(["ok", "warning", "error"]),
          detail: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi("AdminDiagnostics");
const projectBindingSchema = z
  .object({
    state: z.enum(["connected", "disconnected"]),
    affectedCaplets: z.array(z.string()),
    actions: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          enabled: z.boolean(),
          reason: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi("AdminProjectBinding");
const activityEntrySchema = z
  .object({
    id: z.string().min(1),
    createdAt: timestampSchema,
    actorClientId: z.string().min(1),
    action: z.string().min(1),
    outcome: z.enum(["success", "failure"]),
    target: z
      .object({
        type: z.string().min(1),
        id: z.string().min(1),
        label: z.string().optional(),
      })
      .strict(),
    metadata: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict()
  .openapi("AdminActivityEntry");
const activityPageSchema = cursorPageSchema("AdminActivityPage", activityEntrySchema);
const effectiveCapletSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string(),
    backend: z.string(),
    exposure: z
      .enum([
        "direct",
        "progressive",
        "code_mode",
        "direct_and_code_mode",
        "progressive_and_code_mode",
      ])
      .optional(),
    setupRequired: z.boolean(),
    authRequired: z.boolean(),
    projectBindingRequired: z.boolean(),
    source: z.string().optional(),
    updateState: z.enum(["unknown", "locked"]),
    setupActions: z.array(setupActionSchema),
  })
  .strict()
  .openapi("AdminEffectiveCaplet");
const effectiveCapletPageSchema = cursorPageSchema(
  "AdminEffectiveCapletPage",
  effectiveCapletSchema,
);
const catalogSourceSchema = z
  .object({
    provider: z.literal("github"),
    owner: z.string(),
    repo: z.string(),
    repository: z.string(),
    canonicalUrl: z.string().url(),
  })
  .strict()
  .openapi("AdminCatalogSource");
const catalogWorkflowSchema = z
  .object({
    kind: z.enum([
      "code_mode",
      "mcp",
      "openapi",
      "google_discovery",
      "graphql",
      "http",
      "cli",
      "set",
      "unknown",
    ]),
    label: z.string(),
  })
  .strict();
const catalogEntryChildSchema = z
  .object({
    id: z.string(),
    childId: z.string().optional(),
    name: z.string(),
    backend: z.string(),
    workflow: catalogWorkflowSchema,
  })
  .strict();
const catalogEntrySchema = z
  .object({
    entryKey: z.string().min(1),
    id: z.string().min(1),
    name: z.string(),
    description: z.string(),
    source: catalogSourceSchema,
    sourcePath: z.string(),
    trustLevel: z.enum(["official", "community"]),
    resolvedRevision: z.string().optional(),
    indexedContentHash: z.string().optional(),
    contentMarkdown: z.string().optional(),
    icon: z
      .union([
        z.object({ type: z.literal("url"), url: z.string().url() }).strict(),
        z.object({ type: z.literal("bundled"), path: z.string(), url: z.string().url() }).strict(),
      ])
      .optional(),
    tags: z.array(z.string()),
    setupReadiness: z.enum(["ready", "required", "unknown"]),
    authReadiness: z.enum(["ready", "required", "unknown"]),
    projectBindingReadiness: z.enum(["ready", "required", "unknown"]),
    workflow: catalogWorkflowSchema,
    children: z.array(catalogEntryChildSchema).optional(),
    installCommand: z
      .object({
        text: z.string(),
        copyable: z.boolean(),
        revisionBound: z.boolean(),
        reason: z
          .enum(["revision_unavailable", "revision_install_unsupported", "unsupported_source"])
          .optional(),
      })
      .strict(),
    warnings: z.array(
      z
        .object({
          code: z.enum([
            "unverified_community",
            "local_control",
            "mutating_saas",
            "auth_required",
            "setup_required",
            "project_binding_required",
            "readiness_unknown",
          ]),
          severity: z.enum(["info", "caution", "danger"]),
          label: z.string(),
          message: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi("AdminCatalogEntry");
const catalogEntryPageSchema = cursorPageSchema("AdminCatalogEntryPage", catalogEntrySchema);
const catalogDetailSchema = z
  .object({
    entry: catalogEntrySchema,
    setupActions: z.array(setupActionSchema),
    projectScopedInstallAvailable: z.literal(false),
  })
  .strict()
  .openapi("AdminCatalogEntryDetail");
const catalogUpdateCandidateSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal("locked"),
    risk: domainObjectSchema,
  })
  .strict()
  .openapi("AdminCatalogUpdateCandidate");
const catalogUpdateCandidatePageSchema = cursorPageSchema(
  "AdminCatalogUpdateCandidatePage",
  catalogUpdateCandidateSchema,
);
const catalogIndexingResultSchema = z
  .object({
    status: z.enum([
      "accepted",
      "already_current",
      "counted",
      "ineligible",
      "rate_limited",
      "rejected",
      "revision_unavailable",
      "suppressed",
      "unavailable",
    ]),
    entryKey: z.string().min(1).optional(),
    reason: z.string().optional(),
  })
  .strict();
const catalogMutationInstalledSummarySchema = z
  .object({
    kind: z.enum(["file", "directory"]),
    status: z.enum(["installed", "restored", "updated", "content_updated", "noop"]).optional(),
    catalogIndexing: z
      .object({ status: catalogIndexingResultSchema.shape.status })
      .strict()
      .optional(),
  })
  .strict()
  .openapi("AdminCatalogMutationInstalledSummary");
const catalogMutationSetupActionSummarySchema = z
  .object({
    kind: setupActionSchema.shape.kind,
    required: z.boolean(),
  })
  .strict()
  .openapi("AdminCatalogMutationSetupActionSummary");
const catalogMutationResultSchema = z
  .object({
    installed: z
      .array(catalogMutationInstalledSummarySchema)
      .max(ADMIN_CATALOG_MUTATION_MAX_CAPLETS),
    installedCount: z.number().int().nonnegative(),
    setupActions: z.array(catalogMutationSetupActionSummarySchema).max(6),
    setupActionCount: z.number().int().nonnegative(),
  })
  .strict()
  .openapi("AdminCatalogMutationResult");
const remoteClientSchema = z
  .object({
    clientId: z.string().min(1).max(256),
    clientLabel: z.string().max(120),
    role: roleSchema,
    hostUrl: z.string().url().max(32_768),
    createdAt: timestampSchema,
    generation: generationSchema,
    lastUsedAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
  })
  .strict()
  .openapi("AdminRemoteClient");
const remoteClientPageSchema = cursorPageSchema("AdminRemoteClientPage", remoteClientSchema);
const remoteClientDeleteResultSchema = z
  .object({
    revoked: z.boolean(),
    clientId: z.string().min(1).max(256),
    sessionEnded: z.boolean(),
  })
  .strict()
  .openapi("AdminRemoteClientDeleteResult");
const remoteLoginRequestSchema = z
  .object({
    flowId: z.string().min(1).max(64),
    hostUrl: z.string().url().max(32_768),
    hostIdentity: z.string().max(512).optional(),
    status: z.enum(["pending", "approved", "denied", "cancelled", "expired", "exchanged"]),
    requestedRole: roleSchema,
    grantedRole: roleSchema.optional(),
    operatorCodeFingerprint: z.string().max(256).optional(),
    clientLabel: z.string().max(120),
    clientFingerprint: z.string().max(256).optional(),
    sourceHint: z.string().max(256).optional(),
    createdAt: timestampSchema,
    codeExpiresAt: timestampSchema,
    flowExpiresAt: timestampSchema,
    generation: generationSchema,
    approvedAt: timestampSchema.optional(),
    deniedAt: timestampSchema.optional(),
    cancelledAt: timestampSchema.optional(),
    exchangedAt: timestampSchema.optional(),
  })
  .strict()
  .openapi("AdminRemoteLoginRequest");
const remoteLoginRequestPageSchema = cursorPageSchema(
  "AdminRemoteLoginRequestPage",
  remoteLoginRequestSchema,
);
const backendAuthConnectionSchema = z
  .object({
    server: z.string().min(1).max(512),
    generation: generationSchema,
    status: z.enum(["expired", "authenticated"]),
    authType: z.enum(["oauth2", "oidc"]).optional(),
    expiresAt: timestampSchema.optional(),
    scope: z.string().max(65_536).optional(),
  })
  .strict()
  .openapi("AdminBackendAuthConnection");
const backendAuthConnectionPageSchema = cursorPageSchema(
  "AdminBackendAuthConnectionPage",
  backendAuthConnectionSchema,
);
const backendAuthDeleteResultSchema = z
  .object({ server: z.string().min(1).max(512), deleted: z.boolean() })
  .strict()
  .openapi("AdminBackendAuthDeleteResult");
const backendAuthFlowSchema = z
  .object({
    flowId: z.string().min(1).max(64),
    server: z.string().min(1).max(512),
    status: z.enum(["pending", "completing", "completed", "expired", "failed", "unknown"]),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    updatedAt: timestampSchema,
    claimedAt: timestampSchema.optional(),
    terminalAt: timestampSchema.optional(),
  })
  .strict()
  .openapi("AdminBackendAuthFlow");
const backendAuthFlowStartResultSchema = z
  .union([
    z.object({ server: z.string().min(1).max(512), authenticated: z.literal(true) }).strict(),
    z
      .object({
        server: z.string().min(1).max(512),
        flowId: z.string().min(1).max(64),
        authorizationUrl: z.string().url().max(32_768),
      })
      .strict(),
  ])
  .openapi("AdminBackendAuthFlowStartResult");
const backendAuthCallbackResultSchema = z
  .object({ server: z.string().min(1).max(512), authenticated: z.literal(true) })
  .strict()
  .openapi("AdminBackendAuthCallbackResult");
const vaultValuePresentSchema = z
  .object({
    key: z.string().min(1).max(128),
    present: z.literal(true),
    generation: generationSchema,
    valueBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .openapi("AdminVaultValue");
const vaultValuePageSchema = cursorPageSchema("AdminVaultValuePage", vaultValuePresentSchema);
const vaultDeleteResultSchema = z
  .object({
    key: z.string().min(1).max(128),
    deleted: z.boolean(),
    grantsRetained: z.number().int().nonnegative(),
  })
  .strict()
  .openapi("AdminVaultValueDeleteResult");
const vaultGrantSchema = z
  .object({
    storedKey: z.string().min(1).max(128),
    referenceName: z.string().min(1).max(128),
    capletId: z.string().min(1).max(64),
    origin: z.object({ kind: z.string().min(1).max(64) }).strict(),
    resourceVersion: z.string().min(1).max(128),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .openapi("AdminVaultGrant");
const vaultGrantPageSchema = cursorPageSchema("AdminVaultGrantPage", vaultGrantSchema);
const vaultGrantRevokeResultSchema = z
  .object({ revoked: z.array(vaultGrantSchema).max(1) })
  .strict()
  .openapi("AdminVaultGrantRevokeResult");
const capletRecordKeySchema = z.string().min(1).max(64);
const capletRecordIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u);
const capletRecordTimestampSchema = timestampSchema.max(40);
const capletRevisionKeySchema = z.string().min(1).max(64);
const capletRevisionNameSchema = z.string().max(80);

const capletBundleEntrySchema = z
  .object({
    path: z.string().min(1),
    hash: z.string().min(1),
    mediaType: z.string().min(1),
    size: z.number().int().nonnegative(),
    executable: z.boolean(),
  })
  .strict()
  .openapi("AdminCapletBundleEntry");
const capletBackendSchema = z
  .object({
    family: z.string().min(1),
    childId: z.string().nullable(),
    config: domainObjectSchema,
  })
  .strict()
  .openapi("AdminCapletBackend");
const capletRevisionSchema = z
  .object({
    revisionKey: capletRevisionKeySchema,
    sequence: z.number().int().positive(),
    name: capletRevisionNameSchema,
    description: z.string().max(1_500),
    body: z.string(),
    schemaUrl: z.string().url().nullable(),
    content: domainObjectSchema,
    contentHash: z.string().min(1),
    sourceRevision: z.string().nullable(),
    sourceContentHash: z.string().nullable(),
    createdAt: timestampSchema,
    actor: z.string(),
    tags: z.array(z.string()),
    backends: z.array(capletBackendSchema),
    bundle: z.array(capletBundleEntrySchema),
  })
  .strict()
  .openapi("AdminCapletRevision");
const capletRevisionSummarySchema = z
  .object({
    revisionKey: capletRevisionKeySchema,
    sequence: z.number().int().positive(),
    name: capletRevisionNameSchema,
    createdAt: capletRecordTimestampSchema,
  })
  .strict()
  .openapi("AdminCapletRevisionSummary");
const capletRevisionPageSchema = cursorPageSchema(
  "AdminCapletRevisionPage",
  capletRevisionSummarySchema,
);
const capletRecordSchema = z
  .object({
    recordKey: capletRecordKeySchema,
    id: capletRecordIdSchema,
    headGeneration: generationSchema,
    historyLimit: z.number().int().nonnegative().nullable(),
    createdAt: capletRecordTimestampSchema,
    updatedAt: capletRecordTimestampSchema,
    currentRevision: capletRevisionSchema,
  })
  .strict()
  .openapi("AdminCapletRecord");
const capletRecordSummarySchema = z
  .object({
    recordKey: capletRecordKeySchema,
    id: capletRecordIdSchema,
    headGeneration: generationSchema,
    historyLimit: z.number().int().nonnegative().nullable(),
    createdAt: capletRecordTimestampSchema,
    updatedAt: capletRecordTimestampSchema,
    currentRevision: capletRevisionSummarySchema,
  })
  .strict()
  .openapi("AdminCapletRecordSummary");
const capletRecordPageSchema = cursorPageSchema("AdminCapletRecordPage", capletRecordSummarySchema);
const capletRecordDetailSchema = z
  .object({
    record: capletRecordSchema,
    document: z.string(),
  })
  .strict()
  .openapi("AdminCapletRecordDetail");
const capletRecordDeleteResultSchema = z
  .object({ deleted: z.literal(true), id: capletRecordIdSchema })
  .strict()
  .openapi("AdminCapletRecordDeleteResult");
const installationSchema = z
  .object({
    installationKey: z.string().min(1).max(64),
    capletId: capletRecordIdSchema,
    recordKey: capletRecordKeySchema,
    generation: generationSchema,
    status: z.enum(["active", "detached"]),
    sourceKind: z.string().min(1).max(128),
    sourceIdentity: z.string().min(1).max(ADMIN_INSTALLATION_SOURCE_IDENTITY_MAX_LENGTH),
    channel: z.string().min(1).max(256).nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    detachedAt: timestampSchema.nullable(),
    detachedBy: z.string().max(128).nullable(),
  })
  .strict()
  .openapi("AdminCapletInstallation");
const installationMutationResultSchema = installationSchema
  .pick({
    installationKey: true,
    capletId: true,
    recordKey: true,
    generation: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    detachedAt: true,
  })
  .strict()
  .openapi("AdminCapletInstallationMutationResult");
const installationPageSchema = cursorPageSchema("AdminCapletInstallationPage", installationSchema);
const installationDeleteResultSchema = z
  .object({
    installationKey: z.string().min(1).max(64),
    capletId: capletRecordIdSchema,
    deleted: z.literal(true),
  })
  .strict()
  .openapi("AdminCapletInstallationDeleteResult");
const installationObservationSchema = z
  .object({
    observationKey: z.string().min(1).max(64),
    installationKey: z.string().min(1).max(64),
    resolvedRevision: z.string().min(1).max(256).nullable(),
    contentHash: z.string().min(1).max(128).nullable(),
    risk: installationRiskSchema.nullable(),
    status: z.enum(["current", "metadata-only", "source-unavailable"]),
    observedAt: timestampSchema,
  })
  .strict()
  .openapi("AdminCapletInstallationObservation");
const installationObservationPageSchema = cursorPageSchema(
  "AdminCapletInstallationObservationPage",
  installationObservationSchema,
);
const installationObservationMutationResultSchema = installationObservationSchema
  .omit({ risk: true })
  .strict()
  .openapi("AdminCapletInstallationObservationMutationResult");

const idPathSchema = z.object({ id: z.string().min(1).max(64) });
const clientPathSchema = z.object({ clientId: z.string().min(1).max(256) });
const flowPathSchema = z.object({ flowId: z.string().min(1).max(64) });
const serverPathSchema = z.object({ serverId: z.string().min(1).max(512) });
const vaultValuePathSchema = z.object({ storedKey: z.string().min(1).max(128) });
const vaultGrantPathSchema = z.object({
  storedKey: z.string().min(1).max(128),
  capletId: z.string().min(1).max(64),
  referenceName: z.string().min(1).max(128),
});
const revisionPathSchema = z.object({
  id: z.string().min(1).max(64),
  revisionKey: z.string().min(1).max(64),
});
const installationPathSchema = z.object({
  id: z.string().min(1).max(64),
  installationKey: z.string().min(1).max(64),
});
const entryPathSchema = z.object({ entryKey: z.string().min(1).max(256) });
const attachSessionPathSchema = z.object({ sessionId: z.string().min(1) });
const bindingPathSchema = z.object({ bindingId: z.string().min(1) });

export const adminV2IfMatchHeadersSchema = z.object({
  "If-Match": z.string().min(1).openapi({
    description: "Strong ETag of the current resource. Required for an existing resource mutation.",
  }),
});

export const adminV2UpsertConditionalHeadersSchema = z.object({
  "If-Match": z.string().min(1).optional().openapi({
    description: "Strong ETag required when replacing an existing resource.",
  }),
  "If-None-Match": z.literal("*").optional().openapi({
    description: "Use * when creating a resource that must not already exist.",
  }),
});

export const adminV2IdempotencyHeadersSchema = z.object({
  "Idempotency-Key": z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x21-\x7e]+$/)
    .openapi({
      description:
        "Principal-scoped retry key. Reuse with the same validated request replays the finalized response.",
    }),
});
const dashboardSessionHeadersSchema = z.object({
  "X-Caplets-CSRF": z.string().min(1).optional().openapi({
    description:
      "Required for unsafe requests authenticated by a dashboard session cookie; optional and ignored for bearer authentication.",
  }),
});

const idempotentMutationHeadersSchema = adminV2IdempotencyHeadersSchema.extend({
  "If-Match": adminV2IfMatchHeadersSchema.shape["If-Match"],
});
const idempotentCreationHeadersSchema = adminV2IdempotencyHeadersSchema.extend({
  "If-None-Match": z.literal("*").openapi({
    description: "Creation precondition. The target operation resource must not already exist.",
  }),
});
const idempotentUpsertHeadersSchema = adminV2IdempotencyHeadersSchema.extend(
  adminV2UpsertConditionalHeadersSchema.shape,
);
const vaultValueUpsertHeadersSchema = idempotentUpsertHeadersSchema.extend({
  "X-Caplets-Grant-If-Match": z.string().min(1).optional().openapi({
    description:
      "Opaque strong ETag of the current grant named by the request body. Required when that grant exists.",
  }),
});
const revisionDeleteHeadersSchema = idempotentMutationHeadersSchema.extend({
  "X-Caplets-Parent-If-Match": z.string().min(1).openapi({
    description:
      "Opaque strong ETag of the current parent Caplet Record. Required in addition to the target revision If-Match.",
  }),
});

const attachSessionHeaderSchema = z.object({
  "Caplets-Attach-Session-Id": z.string().min(1).optional(),
});

export const adminV2JsonObjectSchema = z.record(z.string(), z.unknown());
export const adminV2MergePatchSchema = z.record(z.string(), z.unknown());
const requestBodySchema = adminV2JsonObjectSchema;
const jsonObjectSchema = adminV2JsonObjectSchema;

const bundleUploadSchema = z
  .object({
    manifest: z.string().openapi({
      description: "JSON bundle manifest. This part must be first.",
    }),
    file: z.array(z.string().openapi({ format: "binary" })).openapi({
      description: "Repeated bundle files in manifest order.",
    }),
  })
  .openapi("CapletBundleUpload");

const bundleDownloadSchema = z.string().openapi("CapletBundleDownload", { format: "binary" });

const serviceDiscoverySchema = z
  .object({
    name: z.literal("caplets"),
    protocol: z.literal("caplets-http"),
    schemaVersion: z.literal(1),
    links: z
      .object({
        self: z.literal("/api"),
        openapi: z.literal("/api/openapi.json"),
        v1: z.literal("/api/v1"),
        admin: z.literal("/api/v2/admin/host"),
      })
      .strict(),
  })
  .strict()
  .openapi("ServiceDiscovery");

const versionDiscoverySchema = z
  .object({
    version: z.literal(1),
    path: z.literal("/api/v1"),
    links: z
      .object({
        health: z.literal("/api/v1/healthz"),
        attachSessions: z.literal("/api/v1/attach/sessions").optional(),
        attachManifest: z.literal("/api/v1/attach/manifest").optional(),
        attachEvents: z.literal("/api/v1/attach/events").optional(),
        attachInvoke: z.literal("/api/v1/attach/invoke").optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("VersionDiscovery");

const healthSchema = z
  .object({
    status: z.enum(["ok", "unavailable"]),
    ready: z.boolean(),
    checks: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("Health");

const remoteLoginStartSchema = z
  .object({
    clientLabel: z.string().min(1).optional(),
    clientFingerprint: z.string().min(1).optional(),
  })
  .strict();
const pendingLoginSecretSchema = z
  .object({
    flowId: z.string().min(1),
    pendingCompletionSecret: z.string().min(1),
  })
  .strict();
const pendingLoginRefreshSchema = pendingLoginSecretSchema
  .extend({
    pendingRefreshSecret: z.string().min(1),
  })
  .strict();
const remoteLoginStartResponseSchema = z
  .object({
    flowId: z.string().min(1),
    operatorCode: z.string().min(1),
    operatorCodeFingerprint: z.string().min(1),
    approvalCommand: z.string().min(1),
    pendingRefreshSecret: z.string().min(1),
    pendingCompletionSecret: z.string().min(1),
    codeExpiresAt: z.string().datetime(),
    flowExpiresAt: z.string().datetime(),
    intervalSeconds: z.number().int().positive(),
  })
  .strict()
  .openapi("RemoteLoginStartResponse");
const remoteLoginPollResponseSchema = z
  .object({
    flowId: z.string().min(1),
    status: z.enum(["pending", "approved", "denied", "cancelled", "expired", "exchanged"]),
  })
  .strict()
  .openapi("RemoteLoginPollResponse");
const remoteLoginRefreshResponseSchema = z
  .object({
    flowId: z.string().min(1),
    operatorCode: z.string().min(1),
    operatorCodeFingerprint: z.string().min(1),
    pendingRefreshSecret: z.string().min(1),
    codeExpiresAt: z.string().datetime(),
    flowExpiresAt: z.string().datetime(),
    intervalSeconds: z.number().int().positive(),
    generation: z.number().int().positive().optional(),
  })
  .strict()
  .openapi("RemoteLoginRefreshResponse");
const remoteLoginCompletionResponseSchema = z
  .object({
    hostUrl: z.string().url(),
    clientId: z.string().min(1),
    clientLabel: z.string(),
    role: z.enum(["access", "operator"]),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .openapi("RemoteLoginCompletionResponse");
const remoteCredentialsSchema = remoteLoginCompletionResponseSchema
  .omit({ hostUrl: true, createdAt: true })
  .strict()
  .openapi("RemoteCredentials");
const remoteClientDeleteResponseSchema = z
  .object({
    revoked: z.boolean(),
    clientId: z.string().min(1),
  })
  .strict()
  .openapi("RemoteClientDeleteResponse");
const remoteLoginCancelResponseSchema = z
  .object({
    flowId: z.string().min(1),
    status: z.literal("cancelled"),
    generation: z.number().int().positive().optional(),
  })
  .strict()
  .openapi("RemoteLoginCancelResponse");
const remoteLoginErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("RemoteLoginErrorResponse");

const attachManifestSchema = z
  .object({
    version: z.literal(1),
    revision: z.string(),
    generatedAt: z.string().datetime(),
    caplets: z.array(jsonObjectSchema),
    tools: z.array(jsonObjectSchema),
    resources: z.array(jsonObjectSchema),
    resourceTemplates: z.array(jsonObjectSchema),
    prompts: z.array(jsonObjectSchema),
    completions: z.array(jsonObjectSchema),
    codeModeCaplets: z.array(jsonObjectSchema),
    diagnostics: z.array(jsonObjectSchema),
  })
  .strict()
  .openapi("AttachManifest");
export const attachManifestRevisionEventSchema = z
  .object({ revision: z.string().min(1) })
  .strict()
  .openapi("AttachManifestRevisionEvent");

const attachSessionSchema = z
  .object({
    projectRoot: z.string().optional(),
    projectConfigPath: z.string().optional(),
  })
  .strict()
  .openapi("AttachSessionRequest");
const attachSessionCreateResponseSchema = z
  .object({ sessionId: z.string().min(1) })
  .strict()
  .openapi("AttachSessionCreateResponse");
const attachSessionDeleteResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict()
  .openapi("AttachSessionDeleteResponse");

const attachInvokeSchema = z
  .object({
    revision: z.string().min(1),
    kind: z.enum(["caplet", "tool", "resource", "resourceTemplate", "prompt", "completion"]),
    exportId: z.string().min(1),
    input: z.unknown(),
  })
  .strict()
  .openapi("AttachInvokeRequest");
const attachInvokeResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.unknown(),
  })
  .strict()
  .openapi("AttachInvokeResponse");
const attachErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("AttachErrorResponse");
const publicV1TextErrorSchema = z.string().openapi("PublicV1TextError");

function media(schema: z.ZodType) {
  return { schema };
}

function jsonBody(schema: z.ZodType = requestBodySchema) {
  return {
    required: true,
    content: { [JSON_MEDIA]: media(schema) },
  };
}

const problemResponseHeaders = z.object({
  "Cache-Control": z.literal("no-store"),
  "Retry-After": z.string().min(1).optional(),
});

const problemResponse = {
  description: "RFC 9457 Problem Details. Sensitive implementation details are redacted.",
  headers: problemResponseHeaders,
  content: { [PROBLEM_MEDIA]: media(problemSchema) },
};

const projectBindingLegacyErrorResponse = {
  description: "Legacy Project Binding v1 JSON error envelope.",
  content: { [JSON_MEDIA]: media(projectBindingLegacyErrorEnvelopeSchema) },
};

const projectBindingUnauthorizedResponse = {
  description: "Missing or invalid bearer credential.",
  content: { [TEXT_MEDIA]: media(projectBindingTextAuthErrorSchema) },
};

const projectBindingAuthForbiddenResponse = {
  description: "Bearer credential lacks the Access Client role.",
  content: { [TEXT_MEDIA]: media(projectBindingTextAuthErrorSchema) },
};

const projectBindingForbiddenResponse = {
  description: "Insufficient role or rejected Project Binding session.",
  content: {
    [TEXT_MEDIA]: media(projectBindingTextAuthErrorSchema),
    [JSON_MEDIA]: media(projectBindingLegacyErrorEnvelopeSchema),
  },
};

function projectBindingSuccessResponse(schema: z.ZodType, description: string) {
  return {
    description,
    content: { [JSON_MEDIA]: media(schema) },
  };
}

const noStoreHeaders = z.object({
  "Cache-Control": z.literal("no-store"),
});
const replayHeaderShape = {
  "Idempotency-Replayed": z.literal("true").optional(),
};
const noStoreMutationHeaders = noStoreHeaders.extend(replayHeaderShape);
const noStoreResourceHeaders = noStoreHeaders.extend({
  ETag: z.string().min(1),
});
const noStoreResourceMutationHeaders = noStoreResourceHeaders.extend(replayHeaderShape);
const noStoreCreatedHeaders = noStoreResourceHeaders.extend({
  Location: z.string().min(1),
});
const noStoreCreatedMutationHeaders = noStoreCreatedHeaders.extend(replayHeaderShape);
const renamedResourceMutationHeaders = noStoreResourceMutationHeaders.extend({
  Location: z.string().min(1).optional(),
});
const bundleDownloadHeaders = noStoreResourceHeaders.extend({
  "Content-Disposition": z.string().min(1),
});
const remoteLoginErrorResponse = {
  description: "Legacy Remote Login error envelope.",
  content: { [JSON_MEDIA]: media(remoteLoginErrorResponseSchema) },
};
const publicV1ForbiddenResponse = {
  description: "Request rejected by host protection.",
  content: { [TEXT_MEDIA]: media(publicV1TextErrorSchema) },
};
const remoteClientUnauthorizedResponse = {
  description: "Missing, invalid, or rejected bearer credential.",
  content: {
    [TEXT_MEDIA]: media(publicV1TextErrorSchema),
    [JSON_MEDIA]: media(remoteLoginErrorResponseSchema),
  },
};
const attachUnauthorizedResponse = {
  description: "Missing or invalid bearer credential.",
  content: { [TEXT_MEDIA]: media(publicV1TextErrorSchema) },
};
const attachForbiddenResponse = {
  description: "Request rejected by host protection.",
  content: { [TEXT_MEDIA]: media(publicV1TextErrorSchema) },
};
const attachErrorResponse = {
  description: "Legacy Attach error envelope.",
  content: { [JSON_MEDIA]: media(attachErrorResponseSchema) },
};

function remoteLoginResponses(success: RouteConfig["responses"]): RouteConfig["responses"] {
  return {
    ...success,
    400: remoteLoginErrorResponse,
    401: remoteLoginErrorResponse,
    403: publicV1ForbiddenResponse,
    404: remoteLoginErrorResponse,
    409: remoteLoginErrorResponse,
    500: remoteLoginErrorResponse,
    503: remoteLoginErrorResponse,
    504: remoteLoginErrorResponse,
  };
}

function remoteCredentialResponses(success: RouteConfig["responses"]): RouteConfig["responses"] {
  return {
    ...success,
    400: remoteLoginErrorResponse,
    401: remoteLoginErrorResponse,
    404: remoteLoginErrorResponse,
    409: remoteLoginErrorResponse,
    500: remoteLoginErrorResponse,
    503: remoteLoginErrorResponse,
    504: remoteLoginErrorResponse,
  };
}

function remoteClientResponses(success: RouteConfig["responses"]): RouteConfig["responses"] {
  return {
    ...success,
    400: remoteLoginErrorResponse,
    401: remoteClientUnauthorizedResponse,
    403: publicV1ForbiddenResponse,
    404: remoteLoginErrorResponse,
    409: remoteLoginErrorResponse,
    500: remoteLoginErrorResponse,
    503: remoteLoginErrorResponse,
    504: remoteLoginErrorResponse,
  };
}
function attachResponses(success: RouteConfig["responses"]): RouteConfig["responses"] {
  return {
    ...success,
    400: attachErrorResponse,
    401: attachUnauthorizedResponse,
    403: attachForbiddenResponse,
    404: attachErrorResponse,
    409: attachErrorResponse,
    500: attachErrorResponse,
  };
}

function attachDeleteResponses(success: RouteConfig["responses"]): RouteConfig["responses"] {
  return {
    ...success,
    401: attachUnauthorizedResponse,
    403: attachForbiddenResponse,
  };
}

function successResponse(
  schema: z.ZodType = resourceSchema,
  options: { description?: string; headers?: z.ZodObject } = {},
) {
  return {
    description: options.description ?? "Successful direct resource representation.",
    headers: options.headers ?? noStoreHeaders,
    content: { [JSON_MEDIA]: media(schema) },
  };
}

function pageResponse(schema: z.ZodType, description = "Cursor page of resources.") {
  return successResponse(schema, { description });
}

function routeResponses(success: RouteConfig["responses"]): RouteConfig["responses"] {
  return { ...success, default: problemResponse };
}

function registerRoute(app: OpenAPIHono, route: RouteConfig): void {
  app.openAPIRegistry.registerPath(createRoute(route));
}

function registerPublicRoutes(app: OpenAPIHono): void {
  registerRoute(app, {
    method: "get",
    path: "/api",
    operationId: "getServiceDiscovery",
    tags: ["Discovery"],
    security: publicSecurity,
    responses: routeResponses({
      200: successResponse(serviceDiscoverySchema, { headers: z.object({}) }),
    }),
  });
  registerRoute(app, {
    method: "get",
    path: "/api/v1",
    operationId: "getVersionDiscovery",
    tags: ["Discovery"],
    security: publicSecurity,
    responses: routeResponses({
      200: successResponse(versionDiscoverySchema, { headers: z.object({}) }),
    }),
  });
  registerRoute(app, {
    method: "get",
    path: "/api/v1/healthz",
    operationId: "getHealth",
    tags: ["Discovery"],
    security: publicSecurity,
    responses: routeResponses({
      200: successResponse(healthSchema, { description: "Host is ready.", headers: z.object({}) }),
      503: successResponse(healthSchema, {
        description: "Host is not ready.",
        headers: z.object({ "Retry-After": z.string().optional() }),
      }),
    }),
  });

  const remoteRoutes: RouteConfig[] = [
    {
      method: "post",
      path: "/api/v1/remote/login/start",
      operationId: "startRemoteLogin",
      request: { body: jsonBody(remoteLoginStartSchema) },
      responses: remoteLoginResponses({
        200: successResponse(remoteLoginStartResponseSchema, {
          description: "Pending Remote Login challenge and completion material.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "post",
      path: "/api/v1/remote/login/poll",
      operationId: "pollRemoteLogin",
      request: { body: jsonBody(pendingLoginSecretSchema) },
      responses: remoteLoginResponses({
        200: successResponse(remoteLoginPollResponseSchema, {
          description: "Current Pending Remote Login status.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "post",
      path: "/api/v1/remote/login/refresh",
      operationId: "refreshPendingRemoteLogin",
      request: { body: jsonBody(pendingLoginRefreshSchema) },
      responses: remoteLoginResponses({
        200: successResponse(remoteLoginRefreshResponseSchema, {
          description: "Rotated Pending Remote Login challenge and refresh material.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "post",
      path: "/api/v1/remote/login/complete",
      operationId: "completeRemoteLogin",
      request: { body: jsonBody(pendingLoginSecretSchema) },
      responses: remoteLoginResponses({
        200: successResponse(remoteLoginCompletionResponseSchema, {
          description: "Issued Remote Client credentials.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "post",
      path: "/api/v1/remote/login/cancel",
      operationId: "cancelRemoteLogin",
      request: { body: jsonBody(pendingLoginSecretSchema) },
      responses: remoteLoginResponses({
        200: successResponse(remoteLoginCancelResponseSchema, {
          description: "Cancelled Pending Remote Login.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "post",
      path: "/api/v1/remote/refresh",
      operationId: "refreshRemoteCredentials",
      request: { body: jsonBody(z.object({ refreshToken: z.string().min(1) })) },
      responses: remoteCredentialResponses({ 200: successResponse(remoteCredentialsSchema) }),
    },
  ];
  for (const route of remoteRoutes) {
    registerRoute(app, { ...route, tags: ["Remote access"], security: publicSecurity });
  }
  registerRoute(app, {
    method: "delete",
    path: "/api/v1/remote/client",
    operationId: "revokeCurrentRemoteClient",
    tags: ["Remote access"],
    security: bearerSecurity,
    responses: remoteClientResponses({ 200: successResponse(remoteClientDeleteResponseSchema) }),
  });

  const attachRoutes: RouteConfig[] = [
    {
      method: "post",
      path: "/api/v1/attach/sessions",
      operationId: "createAttachSession",
      request: { body: jsonBody(attachSessionSchema) },
      responses: attachResponses({
        201: successResponse(attachSessionCreateResponseSchema, {
          description: "Created Attach session.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "delete",
      path: "/api/v1/attach/sessions/{sessionId}",
      operationId: "deleteAttachSession",
      request: { params: attachSessionPathSchema },
      responses: attachDeleteResponses({
        200: successResponse(attachSessionDeleteResponseSchema, {
          description: "Closed Attach session.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "get",
      path: "/api/v1/attach/manifest",
      operationId: "getAttachManifest",
      request: { headers: attachSessionHeaderSchema },
      responses: attachResponses({
        200: successResponse(attachManifestSchema, {
          description: "Current Attach export manifest.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "post",
      path: "/api/v1/attach/invoke",
      operationId: "invokeAttachExport",
      request: { headers: attachSessionHeaderSchema, body: jsonBody(attachInvokeSchema) },
      responses: attachResponses({
        200: successResponse(attachInvokeResponseSchema, {
          description: "Attach export invocation result.",
          headers: z.object({}),
        }),
      }),
    },
    {
      method: "get",
      path: "/api/v1/attach/events",
      operationId: "streamAttachEvents",
      request: { headers: attachSessionHeaderSchema },
      responses: attachResponses({
        200: {
          description: "Server-sent manifest revision events.",
          headers: z.object({
            "Cache-Control": z.literal("no-cache"),
            Connection: z.literal("keep-alive"),
            "X-Accel-Buffering": z.literal("no"),
          }),
          content: { [EVENT_STREAM_MEDIA]: media(attachManifestRevisionEventSchema) },
        },
      }),
    },
  ];
  for (const route of attachRoutes) {
    registerRoute(app, { ...route, tags: ["Attach"], security: bearerSecurity });
  }

  const projectBindingRoutes: RouteConfig[] = [
    {
      method: "get",
      path: "/api/v1/attach/project-bindings/connect",
      operationId: "upgradeProjectBindingConnection",
      request: { query: projectBindingConnectQuerySchema },
      responses: {
        101: {
          description: `Switching Protocols response. The server always negotiates \`${PROJECT_BINDING_SOCKET_PROTOCOL}\`. OpenAPI models only the HTTP upgrade response, not WebSocket message sequencing or payload transport.`,
          headers: z.object({
            Connection: z.literal("Upgrade"),
            Upgrade: z.literal("websocket"),
            "Sec-WebSocket-Protocol": z.literal(PROJECT_BINDING_SOCKET_PROTOCOL),
          }),
        },
        400: projectBindingLegacyErrorResponse,
        401: projectBindingUnauthorizedResponse,
        403: projectBindingForbiddenResponse,
        404: projectBindingLegacyErrorResponse,
        409: projectBindingLegacyErrorResponse,
        426: {
          description: "HTTP probe response when a WebSocket upgrade was not requested.",
          content: { [JSON_MEDIA]: media(projectBindingConnectProbeSchema) },
        },
      },
    },
    {
      method: "post",
      path: "/api/v1/attach/project-bindings/sessions",
      operationId: "createProjectBindingSession",
      request: { body: jsonBody(projectBindingSessionCreateRequestSchema) },
      responses: {
        201: projectBindingSuccessResponse(
          projectBindingSessionCreateResponseSchema,
          "Created Project Binding session.",
        ),
        400: projectBindingLegacyErrorResponse,
        401: projectBindingUnauthorizedResponse,
        403: projectBindingAuthForbiddenResponse,
        500: projectBindingLegacyErrorResponse,
        503: projectBindingLegacyErrorResponse,
      },
    },
    {
      method: "get",
      path: "/api/v1/attach/project-bindings/{bindingId}/status",
      operationId: "getProjectBindingStatus",
      request: { params: bindingPathSchema },
      responses: {
        200: projectBindingSuccessResponse(
          projectBindingStatusResponseSchema,
          "Current Project Binding status.",
        ),
        401: projectBindingUnauthorizedResponse,
        403: projectBindingAuthForbiddenResponse,
      },
    },
    {
      method: "get",
      path: "/api/v1/attach/project-bindings/{bindingId}/session",
      operationId: "getProjectBindingSession",
      request: { params: bindingPathSchema },
      responses: {
        200: projectBindingSuccessResponse(
          projectBindingSessionGetResponseSchema,
          "Current Project Binding session.",
        ),
        401: projectBindingUnauthorizedResponse,
        403: projectBindingAuthForbiddenResponse,
        404: projectBindingLegacyErrorResponse,
      },
    },
    {
      method: "post",
      path: "/api/v1/attach/project-bindings/{bindingId}/heartbeat",
      operationId: "heartbeatProjectBindingSession",
      request: {
        params: bindingPathSchema,
        body: jsonBody(projectBindingHeartbeatRequestSchema),
      },
      responses: {
        200: projectBindingSuccessResponse(
          projectBindingHeartbeatResponseSchema,
          "Renewed Project Binding session.",
        ),
        400: projectBindingLegacyErrorResponse,
        401: projectBindingUnauthorizedResponse,
        403: projectBindingForbiddenResponse,
        404: projectBindingLegacyErrorResponse,
        500: projectBindingLegacyErrorResponse,
      },
    },
    {
      method: "delete",
      path: "/api/v1/attach/project-bindings/{bindingId}/session",
      operationId: "deleteProjectBindingSession",
      request: { params: bindingPathSchema },
      responses: {
        200: projectBindingSuccessResponse(
          projectBindingSessionDeleteResponseSchema,
          "Ended Project Binding session.",
        ),
        400: projectBindingLegacyErrorResponse,
        401: projectBindingUnauthorizedResponse,
        403: projectBindingForbiddenResponse,
        404: projectBindingLegacyErrorResponse,
        500: projectBindingLegacyErrorResponse,
      },
    },
  ];
  for (const route of projectBindingRoutes) {
    registerRoute(app, { ...route, tags: ["Project Binding"], security: bearerSecurity });
  }
}

type AdminRequestBody = NonNullable<NonNullable<RouteConfig["request"]>["body"]>;

export type AdminV2RouteDefinition = {
  method: RouteConfig["method"];
  relativePath: `/${string}`;
  operationId: `adminV2${string}`;
  operationKinds: readonly string[];
  tags: string[];
  params?: z.ZodObject;
  query?: z.ZodObject;
  headers?: z.ZodObject;
  body?: AdminRequestBody;
  responses?: RouteConfig["responses"];
  security?: RouteConfig["security"];
  page?: boolean;
  conditional?: boolean;
  upsert?: boolean;
  etag?: boolean;
  created?: boolean;
  streaming?: "bundle-download" | "bundle-upload" | "sse";
};

const emptyBodySchema = z.object({}).strict();
const catalogInstallBodySchema = z
  .object({
    source: z.string().min(1).max(8_192).optional(),
    entryKey: z.string().min(1).max(256).optional(),
    repo: z.string().min(1).max(8_192).optional(),
    capletIds: z
      .array(z.string().min(1).max(128))
      .max(ADMIN_CATALOG_MUTATION_MAX_CAPLETS)
      .optional(),
    force: z.boolean().optional(),
    disableCatalogIndexing: z.boolean().optional(),
  })
  .strict()
  .openapi("AdminCatalogInstallRequest");
const catalogUpdateBodySchema = z
  .object({
    capletIds: z
      .array(z.string().min(1).max(128))
      .max(ADMIN_CATALOG_MUTATION_MAX_CAPLETS)
      .optional(),
    force: z.boolean().optional(),
    acknowledgeRiskIncrease: z.boolean().optional(),
    disableCatalogIndexing: z.boolean().optional(),
  })
  .strict()
  .openapi("AdminCatalogUpdateRequest");
const remoteClientPatchSchema = z
  .object({ role: roleSchema })
  .strict()
  .openapi("AdminRemoteClientPatch");
const remoteLoginPatchSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("approve"),
        grantedRole: roleSchema.optional(),
      })
      .strict(),
    z.object({ action: z.literal("deny") }).strict(),
  ])
  .openapi("AdminRemoteLoginRequestPatch");
const backendAuthFlowBodySchema = z
  .object({ serverId: z.string().min(1).max(512) })
  .strict()
  .openapi("AdminBackendAuthFlowStartRequest");
const backendAuthRefreshBodySchema = z
  .object({ serverId: z.string().min(1).max(512) })
  .strict()
  .openapi("AdminBackendAuthRefreshRequest");
const vaultValueBodySchema = z
  .object({
    value: z.string().max(64 * 1024),
    grant: z.string().min(1).max(64).optional(),
    referenceName: z.string().min(1).max(128).optional(),
  })
  .strict()
  .openapi("AdminVaultValuePutRequest");
const capletRecordPatchSchema = z
  .object({
    id: capletRecordIdSchema.optional(),
    document: z.string().max(ADMIN_MUTATION_DOCUMENT_MAX_LENGTH).optional(),
    historyLimit: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .openapi("AdminCapletRecordPatch");
const currentRevisionBodySchema = z
  .object({ revisionKey: capletRevisionKeySchema })
  .strict()
  .openapi("AdminCapletCurrentRevisionPutRequest");
const installationBodySchema = adminBundleInstallationSchema.openapi(
  "AdminCapletInstallationPutRequest",
);
const installationObservationBodySchema = z
  .object({
    status: z.enum(["current", "metadata-only", "source-unavailable"]),
    resolvedRevision: z.string().min(1).max(256).nullable().optional(),
    contentHash: z.string().min(1).max(128).nullable().optional(),
    risk: installationRiskSchema.nullable().optional(),
  })
  .strict()
  .openapi("AdminCapletInstallationObservationRequest");
const catalogQuerySchema = adminV2CursorQuerySchema
  .extend({
    source: z.string().min(1),
    query: z.string().optional(),
  })
  .strict();
const remoteClientsQuerySchema = adminV2CursorQuerySchema
  .extend({
    role: roleSchema.optional(),
    revoked: z.enum(["true", "false"]).optional(),
  })
  .strict();
const remoteLoginsQuerySchema = adminV2CursorQuerySchema
  .extend({
    status: z
      .enum(["pending", "approved", "denied", "cancelled", "expired", "exchanged"])
      .optional(),
  })
  .strict();
const activityQuerySchema = adminV2CursorQuerySchema
  .extend({
    action: z
      .string()
      .min(1)
      .max(OPERATOR_ACTIVITY_ACTION_MAX_LENGTH)
      .regex(OPERATOR_ACTIVITY_ACTION_PATTERN)
      .openapi({ pattern: OPERATOR_ACTIVITY_ACTION_PATTERN.source })
      .optional(),
  })
  .strict();
const vaultGrantsQuerySchema = adminV2CursorQuerySchema
  .extend({
    storedKey: z.string().min(1).optional(),
    capletId: z.string().min(1).optional(),
  })
  .strict();
const capletRecordsQuerySchema = adminV2CursorQuerySchema
  .extend({
    source: z.string().min(1).optional(),
    status: z.enum(["active", "detached"]).optional(),
    tag: z.string().min(1).optional(),
    search: z.string().min(1).optional(),
  })
  .strict();
const backendCallbackQuerySchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .strict();

const bundleDownloadResponses: RouteConfig["responses"] = {
  200: {
    description: "Streaming manifest-first Caplet Bundle.",
    headers: bundleDownloadHeaders,
    content: { [MULTIPART_MIXED_MEDIA]: media(bundleDownloadSchema) },
  },
  default: problemResponse,
};

const capletRevisionDeleteResultSchema = z
  .object({ record: capletRecordSummarySchema.optional() })
  .strict()
  .openapi("AdminCapletRevisionDeleteResult");

const backendAuthCallbackRoute = {
  method: "get",
  path: "/api/v2/admin/backend-auth-flows/{flowId}/callback",
  operationId: "adminV2CompleteBackendAuthFlowCallback",
  tags: ["Admin Backend auth"],
  security: publicSecurity,
  request: { params: flowPathSchema, query: backendCallbackQuerySchema },
  responses: routeResponses({
    200: successResponse(backendAuthCallbackResultSchema, { headers: noStoreHeaders }),
  }),
} as const satisfies RouteConfig;

export const ADMIN_V2_ROUTE_DEFINITIONS: readonly AdminV2RouteDefinition[] = [
  {
    method: "get",
    relativePath: "/host",
    operationId: "adminV2GetHost",
    operationKinds: ["summary"],
    tags: ["Admin Host"],
    etag: true,
    responses: routeResponses({
      200: successResponse(hostSummarySchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "get",
    relativePath: "/runtime",
    operationId: "adminV2GetRuntime",
    operationKinds: ["runtime"],
    tags: ["Admin Host"],
    etag: true,
    responses: routeResponses({
      200: successResponse(runtimeSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "post",
    relativePath: "/runtime-restarts",
    operationId: "adminV2CreateRuntimeRestart",
    operationKinds: ["runtime_restart"],
    tags: ["Admin Host"],
    created: true,
    body: jsonBody(emptyBodySchema),
    responses: routeResponses({
      201: successResponse(runtimeRestartResultSchema, {
        headers: noStoreCreatedMutationHeaders,
      }),
      503: problemResponse,
    }),
  },
  {
    method: "get",
    relativePath: "/logs",
    operationId: "adminV2ListLogs",
    operationKinds: ["logs"],
    tags: ["Admin Host"],
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(logPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/diagnostics",
    operationId: "adminV2GetDiagnostics",
    operationKinds: ["diagnostics"],
    tags: ["Admin Host"],
    responses: routeResponses({ 200: successResponse(diagnosticsSchema) }),
  },
  {
    method: "get",
    relativePath: "/project-binding",
    operationId: "adminV2GetProjectBinding",
    operationKinds: ["project_binding"],
    tags: ["Admin Host"],
    etag: true,
    responses: routeResponses({
      200: successResponse(projectBindingSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "get",
    relativePath: "/events",
    operationId: "adminV2ListEvents",
    operationKinds: ["runtime_event"],
    tags: ["Admin Host"],
    streaming: "sse",
    responses: {
      200: {
        description: "Current Host event stream.",
        headers: noStoreHeaders,
        content: { [EVENT_STREAM_MEDIA]: media(adminRuntimeEventSchema) },
      },
      default: problemResponse,
    },
  },
  {
    method: "get",
    relativePath: "/activity",
    operationId: "adminV2ListActivity",
    operationKinds: ["activity_page"],
    tags: ["Admin Host"],
    query: activityQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(activityPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/caplets",
    operationId: "adminV2ListEffectiveCaplets",
    operationKinds: ["caplets_page"],
    tags: ["Admin Effective Caplets"],
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(effectiveCapletPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/catalog/entries",
    operationId: "adminV2ListCatalogEntries",
    operationKinds: ["catalog_entries_page"],
    tags: ["Admin Catalog"],
    query: catalogQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(catalogEntryPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/catalog/entries/{entryKey}",
    operationId: "adminV2GetCatalogEntry",
    operationKinds: ["catalog_detail"],
    tags: ["Admin Catalog"],
    params: entryPathSchema,
    query: z.object({ source: z.string().min(1) }).strict(),
    etag: true,
    responses: routeResponses({
      200: successResponse(catalogDetailSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "get",
    relativePath: "/catalog/update-candidates",
    operationId: "adminV2ListCatalogUpdateCandidates",
    operationKinds: ["catalog_update_candidates_page"],
    tags: ["Admin Catalog"],
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(catalogUpdateCandidatePageSchema) }),
  },
  {
    method: "post",
    relativePath: "/catalog/installations",
    operationId: "adminV2InstallCatalogCaplets",
    operationKinds: ["catalog_install"],
    tags: ["Admin Catalog"],
    created: true,
    body: jsonBody(catalogInstallBodySchema),
    responses: routeResponses({
      201: successResponse(catalogMutationResultSchema, {
        headers: noStoreCreatedMutationHeaders,
      }),
    }),
  },
  {
    method: "post",
    relativePath: "/catalog/update-runs",
    operationId: "adminV2UpdateCatalogCaplets",
    operationKinds: ["catalog_update"],
    tags: ["Admin Catalog"],
    created: true,
    body: jsonBody(catalogUpdateBodySchema),
    responses: routeResponses({
      201: successResponse(catalogMutationResultSchema, {
        headers: noStoreCreatedMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/remote-clients",
    operationId: "adminV2ListRemoteClients",
    operationKinds: ["remote_clients_page"],
    tags: ["Admin Remote access"],
    query: remoteClientsQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(remoteClientPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/remote-clients/{clientId}",
    operationId: "adminV2GetRemoteClient",
    operationKinds: ["remote_client_get"],
    tags: ["Admin Remote access"],
    params: clientPathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(remoteClientSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "patch",
    relativePath: "/remote-clients/{clientId}",
    operationId: "adminV2UpdateRemoteClient",
    operationKinds: ["client_change_role"],
    tags: ["Admin Remote access"],
    params: clientPathSchema,
    conditional: true,
    body: {
      required: true,
      content: { [MERGE_PATCH_MEDIA]: media(remoteClientPatchSchema) },
    },
    responses: routeResponses({
      200: successResponse(remoteClientSchema, { headers: noStoreResourceMutationHeaders }),
    }),
  },
  {
    method: "delete",
    relativePath: "/remote-clients/{clientId}",
    operationId: "adminV2DeleteRemoteClient",
    operationKinds: ["client_revoke"],
    tags: ["Admin Remote access"],
    params: clientPathSchema,
    conditional: true,
    responses: routeResponses({
      200: successResponse(remoteClientDeleteResultSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/remote-login-requests",
    operationId: "adminV2ListRemoteLoginRequests",
    operationKinds: ["remote_login_requests_page"],
    tags: ["Admin Remote access"],
    query: remoteLoginsQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(remoteLoginRequestPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/remote-login-requests/{flowId}",
    operationId: "adminV2GetRemoteLoginRequest",
    operationKinds: ["remote_login_request_get"],
    tags: ["Admin Remote access"],
    params: flowPathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(remoteLoginRequestSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "patch",
    relativePath: "/remote-login-requests/{flowId}",
    operationId: "adminV2UpdateRemoteLoginRequest",
    operationKinds: ["pending_login_approve", "pending_login_deny"],
    tags: ["Admin Remote access"],
    params: flowPathSchema,
    conditional: true,
    body: {
      required: true,
      content: { [MERGE_PATCH_MEDIA]: media(remoteLoginPatchSchema) },
    },
    responses: routeResponses({
      200: successResponse(remoteLoginRequestSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/backend-auth-connections",
    operationId: "adminV2ListBackendAuth",
    operationKinds: ["backend_auth_connections_page"],
    tags: ["Admin Backend auth"],
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(backendAuthConnectionPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/backend-auth-connections/{serverId}",
    operationId: "adminV2GetBackendAuth",
    operationKinds: ["backend_auth_connection_get"],
    tags: ["Admin Backend auth"],
    params: serverPathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(backendAuthConnectionSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "delete",
    relativePath: "/backend-auth-connections/{serverId}",
    operationId: "adminV2DeleteBackendAuth",
    operationKinds: ["backend_auth_connection_delete"],
    tags: ["Admin Backend auth"],
    params: serverPathSchema,
    conditional: true,
    responses: routeResponses({
      200: successResponse(backendAuthDeleteResultSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
    }),
  },
  {
    method: "post",
    relativePath: "/backend-auth-flows",
    operationId: "adminV2StartBackendAuthFlow",
    operationKinds: ["backend_auth_flow_start"],
    tags: ["Admin Backend auth"],
    created: true,
    body: jsonBody(backendAuthFlowBodySchema),
    responses: routeResponses({
      201: successResponse(backendAuthFlowStartResultSchema, {
        headers: noStoreCreatedMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/backend-auth-flows/{flowId}",
    operationId: "adminV2GetBackendAuthFlow",
    operationKinds: ["backend_auth_flow_get"],
    tags: ["Admin Backend auth"],
    params: flowPathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(backendAuthFlowSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "post",
    relativePath: "/backend-auth-refreshes",
    operationId: "adminV2RefreshBackendAuth",
    operationKinds: ["backend_auth_refresh"],
    tags: ["Admin Backend auth"],
    conditional: true,
    body: jsonBody(backendAuthRefreshBodySchema),
    responses: routeResponses({
      200: successResponse(backendAuthConnectionSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/vault-values",
    operationId: "adminV2ListVaultValues",
    operationKinds: ["vault_values_page"],
    tags: ["Admin Vault"],
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(vaultValuePageSchema) }),
  },
  {
    method: "get",
    relativePath: "/vault-values/{storedKey}",
    operationId: "adminV2GetVaultValue",
    operationKinds: ["vault_get"],
    tags: ["Admin Vault"],
    params: vaultValuePathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(vaultValuePresentSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "put",
    relativePath: "/vault-values/{storedKey}",
    operationId: "adminV2PutVaultValue",
    operationKinds: ["vault_set"],
    tags: ["Admin Vault"],
    params: vaultValuePathSchema,
    upsert: true,
    headers: vaultValueUpsertHeadersSchema,
    body: jsonBody(vaultValueBodySchema),
    responses: routeResponses({
      200: successResponse(vaultValuePresentSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
      201: successResponse(vaultValuePresentSchema, {
        headers: noStoreCreatedMutationHeaders,
      }),
      412: problemResponse,
      428: problemResponse,
    }),
  },
  {
    method: "delete",
    relativePath: "/vault-values/{storedKey}",
    operationId: "adminV2DeleteVaultValue",
    operationKinds: ["vault_delete"],
    tags: ["Admin Vault"],
    params: vaultValuePathSchema,
    conditional: true,
    responses: routeResponses({
      200: successResponse(vaultDeleteResultSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/vault-grants",
    operationId: "adminV2ListVaultGrants",
    operationKinds: ["vault_grants_page"],
    tags: ["Admin Vault"],
    query: vaultGrantsQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(vaultGrantPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/vault-values/{storedKey}/grants",
    operationId: "adminV2ListVaultValueGrants",
    operationKinds: ["vault_grants_page"],
    tags: ["Admin Vault"],
    params: vaultValuePathSchema,
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(vaultGrantPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/vault-values/{storedKey}/grants/{capletId}/{referenceName}",
    operationId: "adminV2GetVaultGrant",
    operationKinds: ["vault_access_list"],
    tags: ["Admin Vault"],
    params: vaultGrantPathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(vaultGrantSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "put",
    relativePath: "/vault-values/{storedKey}/grants/{capletId}/{referenceName}",
    operationId: "adminV2PutVaultGrant",
    operationKinds: ["vault_access_grant"],
    tags: ["Admin Vault"],
    params: vaultGrantPathSchema,
    upsert: true,
    body: jsonBody(emptyBodySchema),
    responses: routeResponses({
      200: successResponse(vaultGrantSchema, { headers: noStoreResourceMutationHeaders }),
      201: successResponse(vaultGrantSchema, { headers: noStoreCreatedMutationHeaders }),
    }),
  },
  {
    method: "delete",
    relativePath: "/vault-values/{storedKey}/grants/{capletId}/{referenceName}",
    operationId: "adminV2RevokeVaultAccess",
    operationKinds: ["vault_access_revoke"],
    tags: ["Admin Vault"],
    params: vaultGrantPathSchema,
    conditional: true,
    responses: routeResponses({
      200: successResponse(vaultGrantRevokeResultSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/caplet-records",
    operationId: "adminV2ListCapletRecords",
    operationKinds: ["stored_caplets_page"],
    tags: ["Admin Caplet Records"],
    query: capletRecordsQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(capletRecordPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/caplet-records/{id}",
    operationId: "adminV2GetCapletRecord",
    operationKinds: ["stored_caplet_get"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(capletRecordDetailSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "patch",
    relativePath: "/caplet-records/{id}",
    operationId: "adminV2UpdateCapletRecord",
    operationKinds: ["stored_caplet_update"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    conditional: true,
    body: {
      required: true,
      content: { [MERGE_PATCH_MEDIA]: media(capletRecordPatchSchema) },
    },
    responses: routeResponses({
      200: successResponse(capletRecordSummarySchema, { headers: renamedResourceMutationHeaders }),
    }),
  },
  {
    method: "delete",
    relativePath: "/caplet-records/{id}",
    operationId: "adminV2DeleteCapletRecord",
    operationKinds: ["stored_caplet_delete"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    conditional: true,
    responses: routeResponses({
      200: successResponse(capletRecordDeleteResultSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/caplet-records/{id}/bundle",
    operationId: "adminV2GetCapletRecordBundle",
    operationKinds: ["stored_caplet_bundle_get"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    streaming: "bundle-download",
    responses: bundleDownloadResponses,
  },
  {
    method: "put",
    relativePath: "/caplet-records/{id}/bundle",
    operationId: "adminV2PutCapletRecordBundle",
    operationKinds: ["stored_caplet_bundle_import", "stored_caplet_bundle_update"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    upsert: true,
    streaming: "bundle-upload",
    headers: idempotentUpsertHeadersSchema,
    body: {
      required: true,
      content: { [MULTIPART_FORM_MEDIA]: media(bundleUploadSchema) },
    },
    responses: routeResponses({
      200: successResponse(capletRecordSummarySchema, { headers: noStoreResourceMutationHeaders }),
      201: successResponse(capletRecordSummarySchema, { headers: noStoreCreatedMutationHeaders }),
    }),
  },
  {
    method: "get",
    relativePath: "/caplet-records/{id}/revisions",
    operationId: "adminV2ListCapletRecordRevisions",
    operationKinds: ["stored_caplet_revisions_page"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(capletRevisionPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/caplet-records/{id}/revisions/{revisionKey}",
    operationId: "adminV2GetCapletRecordRevision",
    operationKinds: ["stored_caplet_get"],
    tags: ["Admin Caplet Records"],
    params: revisionPathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(capletRecordDetailSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "get",
    relativePath: "/caplet-records/{id}/revisions/{revisionKey}/bundle",
    operationId: "adminV2GetCapletRecordRevisionBundle",
    operationKinds: ["stored_caplet_bundle_get"],
    tags: ["Admin Caplet Records"],
    params: revisionPathSchema,
    streaming: "bundle-download",
    responses: bundleDownloadResponses,
  },
  {
    method: "delete",
    relativePath: "/caplet-records/{id}/revisions/{revisionKey}",
    operationId: "adminV2DeleteCapletRecordRevision",
    operationKinds: ["stored_caplet_delete_revision"],
    tags: ["Admin Caplet Records"],
    params: revisionPathSchema,
    conditional: true,
    headers: revisionDeleteHeadersSchema,
    responses: routeResponses({
      200: successResponse(capletRevisionDeleteResultSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
      412: problemResponse,
      428: problemResponse,
    }),
  },
  {
    method: "put",
    relativePath: "/caplet-records/{id}/current-revision",
    operationId: "adminV2PutCapletRecordCurrentRevision",
    operationKinds: ["stored_caplet_restore_revision"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    conditional: true,
    body: jsonBody(currentRevisionBodySchema),
    responses: routeResponses({
      200: successResponse(capletRecordSummarySchema, { headers: noStoreResourceMutationHeaders }),
    }),
  },
  {
    method: "get",
    relativePath: "/caplet-records/{id}/installations",
    operationId: "adminV2ListCapletRecordInstallations",
    operationKinds: ["stored_caplet_installations_page"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({ 200: pageResponse(installationPageSchema) }),
  },
  {
    method: "get",
    relativePath: "/caplet-records/{id}/installations/{installationKey}",
    operationId: "adminV2GetCapletRecordInstallation",
    operationKinds: ["stored_caplet_installation_get"],
    tags: ["Admin Caplet Records"],
    params: installationPathSchema,
    etag: true,
    responses: routeResponses({
      200: successResponse(installationSchema, { headers: noStoreResourceHeaders }),
    }),
  },
  {
    method: "put",
    relativePath: "/caplet-records/{id}/installations/{installationKey}",
    operationId: "adminV2PutCapletRecordInstallation",
    operationKinds: ["stored_caplet_installation_put"],
    tags: ["Admin Caplet Records"],
    params: installationPathSchema,
    upsert: true,
    body: jsonBody(installationBodySchema),
    responses: routeResponses({
      200: successResponse(installationMutationResultSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
      201: successResponse(installationMutationResultSchema, {
        headers: noStoreCreatedMutationHeaders,
      }),
    }),
  },
  {
    method: "delete",
    relativePath: "/caplet-records/{id}/installations/{installationKey}",
    operationId: "adminV2DeleteCapletRecordInstallation",
    operationKinds: ["stored_caplet_installation_delete"],
    tags: ["Admin Caplet Records"],
    params: installationPathSchema,
    conditional: true,
    responses: routeResponses({
      200: successResponse(installationDeleteResultSchema, {
        headers: noStoreResourceMutationHeaders,
      }),
    }),
  },
  {
    method: "get",
    relativePath: "/caplet-records/{id}/installation-observations",
    operationId: "adminV2ListCapletRecordInstallationObservations",
    operationKinds: ["stored_caplet_installation_observations_page"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    query: adminV2CursorQuerySchema,
    page: true,
    responses: routeResponses({
      200: pageResponse(installationObservationPageSchema),
    }),
  },
  {
    method: "post",
    relativePath: "/caplet-records/{id}/installation-observations",
    operationId: "adminV2CreateCapletRecordInstallationObservation",
    operationKinds: ["stored_caplet_installation_observe"],
    tags: ["Admin Caplet Records"],
    params: idPathSchema,
    created: true,
    headers: idempotentMutationHeadersSchema,
    body: jsonBody(installationObservationBodySchema),
    responses: routeResponses({
      201: successResponse(installationObservationMutationResultSchema, {
        headers: noStoreCreatedMutationHeaders,
      }),
    }),
  },
];

export function adminV2RequestHeadersForDefinition(
  definition: AdminV2RouteDefinition,
): z.ZodObject | undefined {
  let headers: z.ZodObject | undefined;
  if (definition.headers) headers = definition.headers;
  else if (definition.conditional) headers = idempotentMutationHeadersSchema;
  else if (definition.upsert) headers = idempotentUpsertHeadersSchema;
  else if (definition.created) headers = idempotentCreationHeadersSchema;
  else if (definition.method !== "get") headers = adminV2IdempotencyHeadersSchema;
  if (definition.method === "get") return headers;
  return headers
    ? headers.extend(dashboardSessionHeadersSchema.shape)
    : dashboardSessionHeadersSchema;
}

function registerAdminRoute(app: OpenAPIHono, definition: AdminV2RouteDefinition): void {
  const requestHeaders = adminV2RequestHeadersForDefinition(definition);

  let responseHeaders: z.ZodObject = noStoreHeaders;
  if (definition.created) {
    responseHeaders = noStoreCreatedMutationHeaders;
  } else if (definition.conditional || definition.upsert) {
    responseHeaders = noStoreResourceMutationHeaders;
  } else if (definition.etag) {
    responseHeaders = noStoreResourceHeaders;
  } else if (definition.method !== "get") {
    responseHeaders = noStoreMutationHeaders;
  }

  const success = successResponse(resourceSchema, { headers: responseHeaders });
  const responses =
    definition.responses ?? routeResponses({ [definition.created ? 201 : 200]: success });
  const authProblemResponses = {
    401: problemResponse,
    403: problemResponse,
  };
  const uploadCapacityProblemResponse =
    definition.streaming === "bundle-upload" ? { 429: problemResponse } : {};
  registerRoute(app, {
    method: definition.method,
    path: `/api/v2/admin${definition.relativePath}`,
    operationId: definition.operationId,
    tags: definition.tags,
    security: definition.security ?? adminSecurity,
    ...(definition.params || definition.query || requestHeaders || definition.body
      ? {
          request: {
            ...(definition.params ? { params: definition.params } : {}),
            ...(definition.query ? { query: definition.query } : {}),
            ...(requestHeaders ? { headers: requestHeaders } : {}),
            ...(definition.body ? { body: definition.body } : {}),
          },
        }
      : {}),
    responses: {
      ...authProblemResponses,
      ...uploadCapacityProblemResponse,
      ...responses,
    },
  });
}

function registerAdminRoutes(app: OpenAPIHono): void {
  for (const definition of ADMIN_V2_ROUTE_DEFINITIONS) {
    registerAdminRoute(app, definition);
  }
  registerRoute(app, backendAuthCallbackRoute);
}

/**
 * Builds the canonical public HTTP description without mounting runtime routes.
 * A fresh registry on every call prevents request or host state from affecting output.
 */
export function createRootOpenApiDocument(): ReturnType<OpenAPIHono["getOpenAPI31Document"]> {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "Caplets remote credential",
    description: "Operator or Access Client bearer credential, according to route policy.",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "dashboardSession", {
    type: "apiKey",
    in: "cookie",
    name: "caplets_dashboard_session",
    description:
      "Host-only HttpOnly dashboard session cookie. Browser requests remain subject to same-origin checks and unsafe methods require X-Caplets-CSRF.",
  });
  registerPublicRoutes(app);
  registerAdminRoutes(app);
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Caplets HTTP API",
      version: "2.0.0",
      description: "Canonical public non-MCP HTTP contract for Caplets.",
    },
    servers: [{ url: "/" }],
  });
}
