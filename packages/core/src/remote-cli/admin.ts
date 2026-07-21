import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { addAbortSignal } from "node:stream";

import { CAPLETS_ERROR_CODES, CapletsError, redactSecrets } from "../errors";
import {
  adminV2CreateCapletRecordInstallationObservation,
  adminV2DeleteBackendAuth,
  adminV2DeleteCapletRecord,
  adminV2DeleteCapletRecordInstallation,
  adminV2DeleteCapletRecordRevision,
  adminV2DeleteVaultValue,
  adminV2GetBackendAuth,
  adminV2GetCapletRecord,
  adminV2GetCapletRecordInstallation,
  adminV2GetCapletRecordRevision,
  adminV2GetVaultGrant,
  adminV2GetVaultValue,
  adminV2InstallCatalogCaplets,
  adminV2ListBackendAuth,
  adminV2ListCapletRecordInstallationObservations,
  adminV2ListCapletRecordInstallations,
  adminV2ListCapletRecordRevisions,
  adminV2ListCapletRecords,
  adminV2ListVaultGrants,
  adminV2ListVaultValueGrants,
  adminV2ListVaultValues,
  adminV2PutCapletRecordCurrentRevision,
  adminV2PutCapletRecordInstallation,
  adminV2PutVaultGrant,
  adminV2PutVaultValue,
  adminV2RefreshBackendAuth,
  adminV2RevokeVaultAccess,
  adminV2StartBackendAuthFlow,
  adminV2UpdateCapletRecord,
  adminV2UpdateCatalogCaplets,
  adminV2GetCapletRecordBundleStream,
  adminV2GetCapletRecordRevisionBundleStream,
  adminV2PutCapletRecordBundleStream,
  createOrderedBundleMultipartBody,
  createClient,
  type AdminBackendAuthConnection,
  type AdminBackendAuthConnectionPage,
  type AdminCapletInstallation,
  type AdminCapletInstallationObservation,
  type AdminCapletInstallationObservationPage,
  type AdminCapletInstallationRisk,
  type AdminCapletInstallationPage,
  type AdminCapletRecordPage,
  type AdminCapletRevisionPage,
  type AdminVaultGrant,
  type AdminVaultGrantPage,
  type AdminVaultValue,
  type AdminVaultValuePage,
  type Client,
  type Problem,
} from "@caplets/sdk";
import type { RemoteCliRequest } from "../remote-control/types";
import type { RemoteCliCommandAdapter } from "./client";
import type { RemoteBundleDownload } from "./bundle";

export type RemoteAdminCommandAdapter = RemoteCliCommandAdapter;

export type CreateRemoteAdminCommandAdapterOptions = {
  baseUrl: URL;
  bearerToken: string;
  fetch?: typeof fetch;
  idempotencyKey?: () => string;
};

type FieldsResult<T> =
  | { data: T; error: undefined; response?: Response }
  | { data: undefined; error: Problem; response?: Response };

type SuccessfulFields<T> = { data: T; response?: Response };
type RemoteVaultGrant = Omit<AdminVaultGrant, "resourceVersion">;

/** Maps the frozen CLI intent vocabulary to generated Admin v2 operations and DTOs. */
export function createRemoteAdminCommandAdapter(
  options: CreateRemoteAdminCommandAdapterOptions,
): RemoteAdminCommandAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const client = createClient({
    baseUrl: options.baseUrl.toString(),
    auth: options.bearerToken,
    fetch: fetchImpl,
    responseStyle: "fields",
    throwOnError: false,
  });
  const nextIdempotencyKey = options.idempotencyKey ?? randomUUID;

  return {
    async request(command, args) {
      switch (command) {
        case "install": {
          const key = nextIdempotencyKey();
          const result = await mutate(key, () =>
            adminV2InstallCatalogCaplets({
              client,
              body: {
                ...optionalString(args, "repo"),
                ...optionalStringArray(args, "capletIds"),
                ...optionalBoolean(args, "force"),
                ...optionalBoolean(args, "disableCatalogIndexing"),
              },
              headers: { "Idempotency-Key": key, "If-None-Match": "*" },
            }),
          );
          return { remote: true, ...result.data };
        }
        case "update": {
          const key = nextIdempotencyKey();
          const result = await mutate(key, () =>
            adminV2UpdateCatalogCaplets({
              client,
              body: {
                ...optionalStringArray(args, "capletIds"),
                ...optionalBoolean(args, "force"),
                ...(typeof args.allowRiskIncrease === "boolean"
                  ? { acknowledgeRiskIncrease: args.allowRiskIncrease }
                  : {}),
                ...optionalBoolean(args, "disableCatalogIndexing"),
              },
              headers: { "Idempotency-Key": key, "If-None-Match": "*" },
            }),
          );
          return { remote: true, ...result.data };
        }
        case "auth_login_start": {
          const key = nextIdempotencyKey();
          return (
            await mutate(key, () =>
              adminV2StartBackendAuthFlow({
                client,
                body: { serverId: requiredString(args, "server") },
                headers: { "Idempotency-Key": key, "If-None-Match": "*" },
              }),
            )
          ).data;
        }
        case "auth_logout":
          return await deleteBackendAuth(client, args, nextIdempotencyKey());
        case "auth_refresh":
          return await refreshBackendAuth(client, args, nextIdempotencyKey());
        case "auth_list":
          return (
            await collectPages<AdminBackendAuthConnection, AdminBackendAuthConnectionPage>(
              (cursor) =>
                adminV2ListBackendAuth({ client, query: cursor === undefined ? {} : { cursor } }),
            )
          ).map(authStatus);
        case "vault_set":
          return {
            remote: true,
            ...vaultStatus(await putVaultValue(client, args, nextIdempotencyKey())),
          };
        case "vault_list":
          return (
            await collectPages<AdminVaultValue, AdminVaultValuePage>((cursor) =>
              adminV2ListVaultValues({ client, query: cursor === undefined ? {} : { cursor } }),
            )
          ).map(vaultStatus);
        case "vault_get":
          if (args.reveal === true) {
            throw new CapletsError(
              "REQUEST_INVALID",
              "Raw Vault reveal is available only through the private dashboard ceremony.",
            );
          }
          return vaultStatus(
            requireResponseData(
              (
                await successful(
                  adminV2GetVaultValue({
                    client,
                    path: { storedKey: requiredString(args, "name") },
                  }),
                )
              ).data,
            ),
          );
        case "vault_delete":
          return await deleteVaultValue(client, args, nextIdempotencyKey());
        case "vault_access_grant":
          return await putVaultGrant(client, args, nextIdempotencyKey());
        case "vault_access_revoke":
          return await revokeVaultGrants(client, args, nextIdempotencyKey());
        case "vault_access_list":
          return (await listVaultGrants(client, args)).map(vaultGrant);
        case "storage_records_list":
          return await collectPages<AdminCapletRecordPage["items"][number], AdminCapletRecordPage>(
            (cursor) =>
              adminV2ListCapletRecords({
                client,
                query: cursor === undefined ? {} : { cursor },
              }),
          );
        case "storage_records_get":
          return requireResponseData(
            (
              await successful(
                adminV2GetCapletRecord({ client, path: { id: requiredString(args, "id") } }),
              )
            ).data,
          ).record;
        case "storage_records_revisions":
          return await collectPages<
            AdminCapletRevisionPage["items"][number],
            AdminCapletRevisionPage
          >((cursor) =>
            adminV2ListCapletRecordRevisions({
              client,
              path: { id: requiredString(args, "id") },
              query: cursor === undefined ? {} : { cursor },
            }),
          );
        case "storage_records_restore":
          return await restoreRevision(client, args, nextIdempotencyKey());
        case "storage_records_delete_revision":
          return await deleteRevision(client, args, nextIdempotencyKey());
        case "storage_records_retention":
          return await patchRecord(
            client,
            args,
            { historyLimit: nullableNonNegativeInteger(args, "historyLimit") },
            nextIdempotencyKey(),
          );
        case "storage_records_rename":
          return await patchRecord(
            client,
            args,
            { id: requiredString(args, "newId") },
            nextIdempotencyKey(),
          );
        case "storage_records_delete":
          return await deleteRecord(client, args, nextIdempotencyKey());
        case "storage_records_installation_status": {
          const id = requiredString(args, "id");
          const [installations, observations] = await Promise.all([
            listInstallations(client, id),
            listInstallationObservations(client, id),
          ]);
          return { installations, observations };
        }
        case "storage_records_installation_detach":
          return await detachInstallation(client, args, nextIdempotencyKey());
        case "storage_records_installation_observe":
          return await observeInstallation(client, args, nextIdempotencyKey());
        case "storage_records_installation_replace":
          return await replaceInstallation(client, args, nextIdempotencyKey());
        case "storage_records_import":
          return await putRecordBundle(client, args, nextIdempotencyKey(), true);
        case "storage_records_update":
          return await putRecordBundle(client, args, nextIdempotencyKey(), false);
        case "storage_records_export":
          return await getRecordBundle(client, args);
        case "auth_login_complete":
          throw new CapletsError(
            "UNSUPPORTED_OPERATION",
            "Backend OAuth callback completion uses the public callback adapter.",
          );
        default:
          throw new CapletsError(
            "UNKNOWN_OPERATION",
            `Remote command ${command} is not an Admin v2 resource operation.`,
          );
      }
    },
  };
}

async function refreshBackendAuth(
  client: Client,
  args: RemoteCliRequest["arguments"],
  key: string,
) {
  const serverId = requiredString(args, "server");
  const etag = await detailEtag(adminV2GetBackendAuth({ client, path: { serverId } }));
  const connection = requireResponseData(
    (
      await mutate(key, () =>
        adminV2RefreshBackendAuth({
          client,
          body: { serverId },
          headers: { "Idempotency-Key": key, "If-Match": etag },
        }),
      )
    ).data,
  );
  return { server: connection.server };
}

async function deleteBackendAuth(client: Client, args: RemoteCliRequest["arguments"], key: string) {
  const serverId = requiredString(args, "server");
  const etag = await detailEtag(adminV2GetBackendAuth({ client, path: { serverId } }));
  return (
    await mutate(key, () =>
      adminV2DeleteBackendAuth({
        client,
        path: { serverId },
        headers: { "Idempotency-Key": key, "If-Match": etag },
      }),
    )
  ).data;
}

async function putVaultValue(client: Client, args: RemoteCliRequest["arguments"], key: string) {
  const storedKey = requiredString(args, "name");
  const value = requiredString(args, "value");
  const grant = typeof args.grant === "string" && args.grant.length > 0 ? args.grant : undefined;
  const explicitReferenceName =
    typeof args.referenceName === "string" && args.referenceName.length > 0
      ? args.referenceName
      : undefined;
  const referenceName = explicitReferenceName ?? storedKey;
  const headers: {
    "Idempotency-Key": string;
    "If-Match"?: string;
    "If-None-Match"?: "*";
    "X-Caplets-Grant-If-Match"?: string;
  } =
    args.force === true
      ? await vaultForceSetHeaders(client, storedKey, key)
      : { "Idempotency-Key": key, "If-None-Match": "*" };
  if (grant !== undefined) {
    const detail = await adminV2GetVaultGrant({
      client,
      path: { storedKey, capletId: grant, referenceName },
    });
    if (detail.error !== undefined) {
      if (detail.response?.status !== 404) throw problemError(detail.error, detail.response);
    } else {
      const etag = detail.response?.headers.get("etag");
      if (!etag) {
        throw new CapletsError(
          "DOWNSTREAM_PROTOCOL_ERROR",
          "Remote Admin detail response omitted its required ETag.",
        );
      }
      headers["X-Caplets-Grant-If-Match"] = etag;
    }
  }
  return requireResponseData(
    (
      await mutate(key, () =>
        adminV2PutVaultValue({
          client,
          path: { storedKey },
          body: {
            value,
            ...(grant === undefined ? {} : { grant }),
            ...(explicitReferenceName === undefined ? {} : { referenceName }),
          },
          headers,
        }),
      )
    ).data,
  );
}

async function vaultForceSetHeaders(client: Client, storedKey: string, key: string) {
  const fields = await adminV2GetVaultValue({ client, path: { storedKey } });
  if (fields.error !== undefined) {
    if (fields.response?.status === 404) {
      return { "Idempotency-Key": key, "If-None-Match": "*" as const };
    }
    throw problemError(fields.error, fields.response);
  }
  const etag = fields.response?.headers.get("etag");
  if (!etag) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote Admin detail response omitted its required ETag.",
    );
  }
  return { "Idempotency-Key": key, "If-Match": etag };
}

async function deleteVaultValue(client: Client, args: RemoteCliRequest["arguments"], key: string) {
  const storedKey = requiredString(args, "name");
  const etag = await detailEtag(adminV2GetVaultValue({ client, path: { storedKey } }));
  return (
    await mutate(key, () =>
      adminV2DeleteVaultValue({
        client,
        path: { storedKey },
        headers: { "Idempotency-Key": key, "If-Match": etag },
      }),
    )
  ).data;
}

async function listVaultGrants(
  client: Client,
  args: RemoteCliRequest["arguments"],
): Promise<AdminVaultGrant[]> {
  const storedKey = typeof args.name === "string" ? args.name : undefined;
  if (storedKey) {
    return await collectPages<AdminVaultGrant, AdminVaultGrantPage>((cursor) =>
      adminV2ListVaultValueGrants({
        client,
        path: { storedKey },
        query: cursor === undefined ? {} : { cursor },
      }),
    );
  }
  const capletId = typeof args.capletId === "string" ? args.capletId : undefined;
  return await collectPages<AdminVaultGrant, AdminVaultGrantPage>((cursor) =>
    adminV2ListVaultGrants({
      client,
      query: {
        ...(cursor === undefined ? {} : { cursor }),
        ...(capletId === undefined ? {} : { capletId }),
      },
    }),
  );
}

async function putVaultGrant(client: Client, args: RemoteCliRequest["arguments"], key: string) {
  const path = {
    storedKey: requiredString(args, "name"),
    capletId: requiredString(args, "capletId"),
    referenceName: requiredString(args, "referenceName"),
  };
  const fields = await adminV2GetVaultGrant({ client, path });
  let precondition: { "If-None-Match": "*" } | { "If-Match": string };
  if (fields.error !== undefined) {
    if (fields.response?.status !== 404) throw problemError(fields.error, fields.response);
    precondition = { "If-None-Match": "*" };
  } else {
    const etag = fields.response?.headers.get("etag");
    if (!etag) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        "Remote Admin detail response omitted its required ETag.",
      );
    }
    precondition = { "If-Match": etag };
  }
  const grant = requireResponseData(
    (
      await mutate(key, () =>
        adminV2PutVaultGrant({
          client,
          path,
          body: {},
          headers: { "Idempotency-Key": key, ...precondition },
        }),
      )
    ).data,
  );
  return vaultGrant(grant);
}

async function revokeVaultGrants(client: Client, args: RemoteCliRequest["arguments"], key: string) {
  const storedKey = requiredString(args, "name");
  const capletId = requiredString(args, "capletId");
  const referenceName =
    args.referenceName === undefined ? undefined : requiredString(args, "referenceName");
  const matchingGrants = (await listVaultGrants(client, { name: storedKey })).filter(
    (candidate) =>
      candidate.capletId === capletId &&
      (referenceName === undefined || candidate.referenceName === referenceName),
  );
  const grantsByReferenceName = new Map<string, AdminVaultGrant>();
  for (const grant of matchingGrants) {
    if (!grantsByReferenceName.has(grant.referenceName)) {
      grantsByReferenceName.set(grant.referenceName, grant);
    }
  }
  const grants = [...grantsByReferenceName.values()];
  if (grants.length === 0) {
    throw new CapletsError("CONFIG_NOT_FOUND", "Remote Vault grant was not found.");
  }

  const revoked: RemoteVaultGrant[] = [];
  for (const [index, grant] of grants.entries()) {
    const path = {
      storedKey,
      capletId,
      referenceName: grant.referenceName,
    };
    const etag = await detailEtag(adminV2GetVaultGrant({ client, path }));
    const mutationKey = scopedRevokeIdempotencyKey(key, path, index);
    const result = requireResponseData(
      (
        await mutate(mutationKey, () =>
          adminV2RevokeVaultAccess({
            client,
            path,
            headers: {
              "Idempotency-Key": mutationKey,
              "If-Match": etag,
            },
          }),
        )
      ).data,
    );
    revoked.push(...result.revoked.map(vaultGrant));
  }
  return revoked;
}

function scopedRevokeIdempotencyKey(
  key: string,
  path: { storedKey: string; capletId: string; referenceName: string },
  index: number,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([key, path.storedKey, path.capletId, path.referenceName]))
    .digest("base64url");
  return `vault-revoke:${index}:${digest}`;
}

async function patchRecord(
  client: Client,
  args: RemoteCliRequest["arguments"],
  body: { id?: string; historyLimit?: number | null },
  key: string,
) {
  const id = requiredString(args, "id");
  const etag = await generationCheckedEtag(
    adminV2GetCapletRecord({ client, path: { id } }),
    args,
    (detail) => detail.record.headGeneration,
    `Caplet Record ${id}`,
  );
  return (
    await mutate(key, () =>
      adminV2UpdateCapletRecord({
        client,
        path: { id },
        body,
        headers: { "Idempotency-Key": key, "If-Match": etag },
      }),
    )
  ).data;
}

async function deleteRecord(client: Client, args: RemoteCliRequest["arguments"], key: string) {
  const id = requiredString(args, "id");
  const etag = await generationCheckedEtag(
    adminV2GetCapletRecord({ client, path: { id } }),
    args,
    (detail) => detail.record.headGeneration,
    `Caplet Record ${id}`,
  );
  return (
    await mutate(key, () =>
      adminV2DeleteCapletRecord({
        client,
        path: { id },
        headers: { "Idempotency-Key": key, "If-Match": etag },
      }),
    )
  ).data;
}

async function restoreRevision(client: Client, args: RemoteCliRequest["arguments"], key: string) {
  const id = requiredString(args, "id");
  const etag = await generationCheckedEtag(
    adminV2GetCapletRecord({ client, path: { id } }),
    args,
    (detail) => detail.record.headGeneration,
    `Caplet Record ${id}`,
  );
  return (
    await mutate(key, () =>
      adminV2PutCapletRecordCurrentRevision({
        client,
        path: { id },
        body: { revisionKey: requiredString(args, "revisionKey") },
        headers: { "Idempotency-Key": key, "If-Match": etag },
      }),
    )
  ).data;
}

async function deleteRevision(client: Client, args: RemoteCliRequest["arguments"], key: string) {
  const id = requiredString(args, "id");
  const revisionKey = requiredString(args, "revisionKey");
  const parentEtag = await generationCheckedEtag(
    adminV2GetCapletRecord({ client, path: { id } }),
    args,
    (detail) => detail.record.headGeneration,
    `Caplet Record ${id}`,
  );
  const etag = await detailEtag(
    adminV2GetCapletRecordRevision({ client, path: { id, revisionKey } }),
  );
  const result = (
    await mutate(key, () =>
      adminV2DeleteCapletRecordRevision({
        client,
        path: { id, revisionKey },
        headers: {
          "Idempotency-Key": key,
          "If-Match": etag,
          "X-Caplets-Parent-If-Match": parentEtag,
        },
      }),
    )
  ).data;
  return { deleted: true, ...result };
}

async function listInstallations(client: Client, id: string): Promise<AdminCapletInstallation[]> {
  return await collectPages<AdminCapletInstallation, AdminCapletInstallationPage>((cursor) =>
    adminV2ListCapletRecordInstallations({
      client,
      path: { id },
      query: cursor === undefined ? {} : { cursor },
    }),
  );
}

async function listInstallationObservations(
  client: Client,
  id: string,
): Promise<AdminCapletInstallationObservation[]> {
  return await collectPages<
    AdminCapletInstallationObservation,
    AdminCapletInstallationObservationPage
  >((cursor) =>
    adminV2ListCapletRecordInstallationObservations({
      client,
      path: { id },
      query: cursor === undefined ? {} : { cursor },
    }),
  );
}

async function detachInstallation(
  client: Client,
  args: RemoteCliRequest["arguments"],
  key: string,
) {
  const id = requiredString(args, "id");
  const active = (await listInstallations(client, id)).find((item) => item.status === "active");
  if (!active) throw new CapletsError("CONFIG_NOT_FOUND", "Active installation was not found.");
  const etag = await generationCheckedEtag(
    adminV2GetCapletRecordInstallation({
      client,
      path: { id, installationKey: active.installationKey },
    }),
    args,
    (installation) => installation.generation,
    `Caplet installation ${id}`,
  );
  return (
    await mutate(key, () =>
      adminV2DeleteCapletRecordInstallation({
        client,
        path: { id, installationKey: active.installationKey },
        headers: { "Idempotency-Key": key, "If-Match": etag },
      }),
    )
  ).data;
}

async function observeInstallation(
  client: Client,
  args: RemoteCliRequest["arguments"],
  key: string,
) {
  const id = requiredString(args, "id");
  const active = (await listInstallations(client, id)).find((item) => item.status === "active");
  if (!active) throw new CapletsError("CONFIG_NOT_FOUND", "Active installation was not found.");
  const risk = installationRisk(args.risk);
  const etag = await generationCheckedEtag(
    adminV2GetCapletRecordInstallation({
      client,
      path: { id, installationKey: active.installationKey },
    }),
    args,
    (installation) => installation.generation,
    `Caplet installation ${id}`,
  );
  return (
    await mutate(key, () =>
      adminV2CreateCapletRecordInstallationObservation({
        client,
        path: { id },
        body: {
          status: installationStatus(args.status),
          ...optionalNullableString(args, "resolvedRevision"),
          ...optionalNullableString(args, "contentHash"),
          ...(risk === undefined ? {} : { risk }),
        },
        headers: { "Idempotency-Key": key, "If-Match": etag },
      }),
    )
  ).data;
}

async function replaceInstallation(
  client: Client,
  args: RemoteCliRequest["arguments"],
  key: string,
) {
  const id = requiredString(args, "id");
  const requestedKey =
    typeof args.detachedInstallationKey === "string" ? args.detachedInstallationKey : undefined;
  const detached = requestedKey
    ? { installationKey: requestedKey }
    : (await listInstallations(client, id)).find((item) => item.status === "detached");
  if (!detached) throw new CapletsError("CONFIG_NOT_FOUND", "Detached installation was not found.");
  const etag = await generationCheckedEtag(
    adminV2GetCapletRecordInstallation({
      client,
      path: { id, installationKey: detached.installationKey },
    }),
    args,
    (installation) => installation.generation,
    `Caplet installation ${id}`,
  );
  return (
    await mutate(key, () =>
      adminV2PutCapletRecordInstallation({
        client,
        path: { id, installationKey: detached.installationKey },
        body: {
          sourceKind: requiredString(args, "sourceKind"),
          sourceIdentity: requiredString(args, "sourceIdentity"),
          ...optionalString(args, "channel"),
        },
        headers: { "Idempotency-Key": key, "If-Match": etag },
      }),
    )
  ).data;
}

async function putRecordBundle(
  client: Client,
  args: RemoteCliRequest["arguments"],
  key: string,
  create: boolean,
) {
  const id = requiredString(args, "id");
  const installation = create ? bundleInstallation(args) : undefined;
  const files = await prepareBundleFiles(args.files);
  const manifest = JSON.stringify({
    version: 1,
    files: files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      executable: file.executable,
    })),
    ...(typeof args.historyLimit === "number" ? { historyLimit: args.historyLimit } : {}),
    ...(args.detachInstallation === true ? { detachInstallation: true } : {}),
    ...(installation === undefined ? {} : { installation }),
  });
  const headers = create
    ? { "Idempotency-Key": key, "If-None-Match": "*" as const }
    : {
        "Idempotency-Key": key,
        "If-Match": await generationCheckedEtag(
          adminV2GetCapletRecord({ client, path: { id } }),
          args,
          (detail) => detail.record.headGeneration,
          `Caplet Record ${id}`,
        ),
      };
  const boundary = `caplets-${createHash("sha256").update(key).digest("base64url")}`;
  return (
    await mutate(key, () => {
      const multipart = createOrderedBundleMultipartBody(
        manifest,
        files.map((file) => ({
          open: (signal) => addAbortSignal(signal, createReadStream(file.sourcePath)),
        })),
        boundary,
      );
      return adminV2PutCapletRecordBundleStream({
        client,
        path: { id },
        body: multipart.body,
        contentType: multipart.contentType,
        headers,
      });
    })
  ).data;
}

async function getRecordBundle(
  client: Client,
  args: RemoteCliRequest["arguments"],
): Promise<RemoteBundleDownload> {
  const id = requiredString(args, "id");
  const result =
    typeof args.revisionKey === "string"
      ? await successful(
          adminV2GetCapletRecordRevisionBundleStream({
            client,
            path: { id, revisionKey: args.revisionKey },
          }),
        )
      : await successful(adminV2GetCapletRecordBundleStream({ client, path: { id } }));
  if (!result.data) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote Admin bundle response omitted its body stream.",
    );
  }
  const contentType = result.response?.headers.get("content-type");
  if (!contentType) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote Admin bundle response omitted its Content-Type.",
    );
  }
  return { body: result.data, contentType };
}

function bundleInstallation(
  args: RemoteCliRequest["arguments"],
): { sourceKind: string; sourceIdentity: string; channel?: string } | undefined {
  const supplied =
    args.sourceKind !== undefined ||
    args.sourceIdentity !== undefined ||
    args.channel !== undefined;
  if (!supplied) return undefined;
  const sourceKind = requiredString(args, "sourceKind");
  const sourceIdentity = requiredString(args, "sourceIdentity");
  return {
    sourceKind,
    sourceIdentity,
    ...(args.channel === undefined ? {} : { channel: requiredString(args, "channel") }),
  };
}

type PreparedBundleFile = {
  path: string;
  sourcePath: string;
  size: number;
  executable: boolean;
  sha256: string;
};

async function prepareBundleFiles(value: unknown): Promise<PreparedBundleFile[]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", "Remote Caplet Bundle files are required.");
  }
  const files: PreparedBundleFile[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== "string" ||
      typeof candidate.sourcePath !== "string" ||
      !Number.isSafeInteger(candidate.size) ||
      (candidate.size as number) < 0 ||
      typeof candidate.executable !== "boolean"
    ) {
      throw new CapletsError("REQUEST_INVALID", "Remote Caplet Bundle file is malformed.");
    }
    const hashed = await sha256File(candidate.sourcePath);
    if (hashed.size !== candidate.size) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet Bundle file ${candidate.path} changed while preparing its upload.`,
      );
    }
    files.push({
      path: candidate.path,
      sourcePath: candidate.sourcePath,
      size: candidate.size as number,
      executable: candidate.executable,
      sha256: hashed.digest,
    });
  }
  return files;
}

async function sha256File(path: string): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { digest: hash.digest("hex"), size };
}

const MAX_COLLECTED_PAGES = 100;
const MAX_COLLECTED_ITEMS = 10_000;

async function collectPages<Item, Page extends { items: Item[]; nextCursor?: string }>(
  load: (cursor: string | undefined) => Promise<FieldsResult<Page>>,
): Promise<Item[]> {
  const items: Item[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    if (pageCount >= MAX_COLLECTED_PAGES) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        "Remote Admin pagination exceeded its page limit.",
      );
    }
    const page = (await successful(load(cursor))).data;
    pageCount += 1;
    if (page.items.length > MAX_COLLECTED_ITEMS - items.length) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        "Remote Admin pagination exceeded its item limit.",
      );
    }
    items.push(...page.items);
    const nextCursor =
      typeof page.nextCursor === "string" && page.nextCursor.length > 0
        ? page.nextCursor
        : undefined;
    if (nextCursor !== undefined) {
      if (seenCursors.has(nextCursor)) {
        throw new CapletsError(
          "DOWNSTREAM_PROTOCOL_ERROR",
          "Remote Admin pagination repeated a cursor.",
        );
      }
      seenCursors.add(nextCursor);
    }
    cursor = nextCursor;
  } while (cursor !== undefined);
  return items;
}

async function generationCheckedEtag<T>(
  result: Promise<FieldsResult<T | undefined>>,
  args: RemoteCliRequest["arguments"],
  generation: (detail: T) => number,
  resource: string,
): Promise<string> {
  const fields = await successful(result);
  const detail = requireResponseData(fields.data);
  assertGeneration(args, generation(detail), resource);
  const etag = fields.response?.headers.get("etag");
  if (!etag) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote Admin detail response omitted its required ETag.",
    );
  }
  return etag;
}

function assertGeneration(
  args: RemoteCliRequest["arguments"],
  currentGeneration: number,
  resource: string,
): void {
  const value = args.expectedGeneration;
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote command expectedGeneration must be a positive integer.",
    );
  }
  const expectedGeneration = value as number;
  if (expectedGeneration !== currentGeneration) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${resource} changed after it was read; reload and retry.`,
      { kind: "stale_generation", expectedGeneration, currentGeneration },
    );
  }
}

async function detailEtag<T>(result: Promise<FieldsResult<T>>): Promise<string> {
  const fields = await successful(result);
  const etag = fields.response?.headers.get("etag");
  if (!etag) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote Admin detail response omitted its required ETag.",
    );
  }
  return etag;
}

const MAX_IDEMPOTENCY_RECOVERY_ATTEMPTS = 4;
const MAX_IDEMPOTENCY_RETRY_DELAY_MS = 30_000;
const MAX_IDEMPOTENCY_RECOVERY_DURATION_MS = 35_000;

async function mutate<T>(
  key: string,
  call: (idempotencyKey: string) => Promise<FieldsResult<T>>,
): Promise<SuccessfulFields<T>> {
  let result: FieldsResult<T>;
  try {
    result = await call(key);
  } catch {
    result = await call(key);
  }
  if (result.error !== undefined && retryableMutationFailure(result.response)) {
    result = await call(key);
  }
  result = await recoverInProgressMutation(key, call, result);
  return successful(Promise.resolve(result));
}

async function recoverInProgressMutation<T>(
  key: string,
  call: (idempotencyKey: string) => Promise<FieldsResult<T>>,
  initial: FieldsResult<T>,
): Promise<FieldsResult<T>> {
  const deadline = Date.now() + MAX_IDEMPOTENCY_RECOVERY_DURATION_MS;
  let attempts = 1;
  let result = initial;
  while (
    result.error !== undefined &&
    result.response?.status === 409 &&
    result.error.code === "IDEMPOTENCY_IN_PROGRESS"
  ) {
    if (attempts >= MAX_IDEMPOTENCY_RECOVERY_ATTEMPTS) return result;
    const delayMs = validatedIdempotencyRetryDelay(result.response, deadline - Date.now());
    if (delayMs === undefined) return result;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    result = await call(key);
    attempts += 1;
  }
  return result;
}

function validatedIdempotencyRetryDelay(
  response: Response,
  remainingMs: number,
): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  const delayMs = seconds * 1_000;
  if (
    delayMs > MAX_IDEMPOTENCY_RETRY_DELAY_MS ||
    delayMs > remainingMs ||
    !Number.isSafeInteger(delayMs)
  ) {
    return undefined;
  }
  return delayMs;
}

async function successful<T>(result: Promise<FieldsResult<T>>): Promise<SuccessfulFields<T>> {
  const fields = await result;
  if (fields.error === undefined) {
    return fields.response === undefined
      ? { data: fields.data }
      : { data: fields.data, response: fields.response };
  }
  throw problemError(fields.error, fields.response);
}

function problemError(problem: Problem, response?: Response): CapletsError {
  const code = CAPLETS_ERROR_CODES.includes(problem.code as (typeof CAPLETS_ERROR_CODES)[number])
    ? (problem.code as (typeof CAPLETS_ERROR_CODES)[number])
    : response?.status === 401 || response?.status === 403
      ? "AUTH_FAILED"
      : "DOWNSTREAM_TOOL_ERROR";
  return new CapletsError(code, String(redactSecrets(problem.detail)), {
    ...(problem.nextAction ? { nextAction: problem.nextAction } : {}),
    ...(problem.links ? { links: problem.links } : {}),
  });
}

function retryableMutationFailure(response: Response | undefined): boolean {
  return (
    response === undefined ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  );
}

function authStatus(connection: AdminBackendAuthConnection) {
  const { generation: _generation, authType: _authType, ...status } = connection;
  return status;
}

function vaultStatus(value: AdminVaultValue) {
  const { generation: _generation, ...status } = value;
  return status;
}

function vaultGrant(grant: AdminVaultGrant) {
  const { resourceVersion: _resourceVersion, ...status } = grant;
  return status;
}

function requireResponseData<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote Admin response omitted its required representation.",
    );
  }
  return value;
}

function requiredString(args: RemoteCliRequest["arguments"], key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", `Remote command requires ${key}.`);
  }
  return value;
}

function optionalString(args: RemoteCliRequest["arguments"], key: string): Record<string, string> {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}

function optionalNullableString(
  args: RemoteCliRequest["arguments"],
  key: string,
): Record<string, string | null> {
  const value = args[key];
  return value === null || typeof value === "string" ? { [key]: value } : {};
}

function optionalStringArray(
  args: RemoteCliRequest["arguments"],
  key: string,
): Record<string, string[]> {
  const value = args[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? { [key]: value }
    : {};
}

function optionalBoolean(
  args: RemoteCliRequest["arguments"],
  key: string,
): Record<string, boolean> {
  return typeof args[key] === "boolean" ? { [key]: args[key] } : {};
}

function nullableNonNegativeInteger(
  args: RemoteCliRequest["arguments"],
  key: string,
): number | null {
  const value = args[key];
  if (value === null) return null;
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  throw new CapletsError("REQUEST_INVALID", `Remote command requires non-negative ${key}.`);
}

function installationRisk(value: unknown): AdminCapletInstallationRisk | undefined {
  if (!isRecord(value)) return undefined;
  const backendFamilies = installationRiskStringArray(value.backendFamilies, "backendFamilies");
  const safety = value.safety;
  if (
    safety !== "standard" &&
    safety !== "mutating_saas" &&
    safety !== "local_control" &&
    safety !== "unknown"
  ) {
    throw new CapletsError("REQUEST_INVALID", "Remote installation observation risk is invalid.");
  }
  if (
    typeof value.projectBindingRequired !== "boolean" ||
    typeof value.mutating !== "boolean" ||
    typeof value.destructive !== "boolean"
  ) {
    throw new CapletsError("REQUEST_INVALID", "Remote installation observation risk is invalid.");
  }
  const authScopes =
    value.authScopes === undefined
      ? undefined
      : installationRiskStringArray(value.authScopes, "authScopes");
  const runtimeFeatures =
    value.runtimeFeatures === undefined
      ? undefined
      : installationRiskStringArray(value.runtimeFeatures, "runtimeFeatures");
  const bodyHash = installationRiskOptionalString(value.bodyHash, "bodyHash");
  const referenceHash = installationRiskOptionalString(value.referenceHash, "referenceHash");
  return {
    backendFamilies,
    safety,
    projectBindingRequired: value.projectBindingRequired,
    mutating: value.mutating,
    destructive: value.destructive,
    ...(authScopes === undefined ? {} : { authScopes }),
    ...(runtimeFeatures === undefined ? {} : { runtimeFeatures }),
    ...(bodyHash === undefined ? {} : { bodyHash }),
    ...(referenceHash === undefined ? {} : { referenceHash }),
  };
}

function installationRiskStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Remote installation observation risk.${field} is invalid.`,
    );
  }
  return value;
}

function installationRiskOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  throw new CapletsError(
    "REQUEST_INVALID",
    `Remote installation observation risk.${field} is invalid.`,
  );
}

function installationStatus(value: unknown): "current" | "metadata-only" | "source-unavailable" {
  if (value === "current" || value === "metadata-only" || value === "source-unavailable") {
    return value;
  }
  throw new CapletsError("REQUEST_INVALID", "Remote installation observation status is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
