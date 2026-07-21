import { z } from "@hono/zod-openapi";

import {
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
} from "../storage/caplet-records";

export const DEFAULT_ADMIN_BUNDLE_MANIFEST_BYTES = 16 * 1024 * 1024;
export const DEFAULT_ADMIN_BUNDLE_DOCUMENT_BYTES = MAX_BUNDLE_FILE_BYTES;
export const DEFAULT_ADMIN_BUNDLE_HEADER_BYTES = 8 * 1024;
export const DEFAULT_ADMIN_BUNDLE_HEADER_PAIRS = 64;
export const DEFAULT_ADMIN_BUNDLE_BOUNDARY_BYTES = 70;
const DEFAULT_ADMIN_BUNDLE_PARTS = MAX_BUNDLE_FILES + 2;
export const DEFAULT_ADMIN_BUNDLE_MULTIPART_OVERHEAD_BYTES =
  DEFAULT_ADMIN_BUNDLE_PARTS * (DEFAULT_ADMIN_BUNDLE_HEADER_BYTES + 4) +
  (DEFAULT_ADMIN_BUNDLE_PARTS + 1) * (DEFAULT_ADMIN_BUNDLE_BOUNDARY_BYTES + 8);
export const DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES =
  DEFAULT_ADMIN_BUNDLE_MANIFEST_BYTES +
  DEFAULT_ADMIN_BUNDLE_DOCUMENT_BYTES +
  MAX_BUNDLE_TOTAL_BYTES +
  DEFAULT_ADMIN_BUNDLE_MULTIPART_OVERHEAD_BYTES;

export type AdminBundleUploadLimits = {
  maxManifestBytes: number;
  maxDocumentBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
  maxRequestBytes: number;
  maxHeaderBytes: number;
  maxHeaderPairs: number;
};

export const DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS: Readonly<AdminBundleUploadLimits> = {
  maxManifestBytes: DEFAULT_ADMIN_BUNDLE_MANIFEST_BYTES,
  maxDocumentBytes: DEFAULT_ADMIN_BUNDLE_DOCUMENT_BYTES,
  maxFiles: MAX_BUNDLE_FILES,
  maxFileBytes: MAX_BUNDLE_FILE_BYTES,
  maxTotalFileBytes: MAX_BUNDLE_TOTAL_BYTES,
  maxRequestBytes: DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES,
  maxHeaderBytes: DEFAULT_ADMIN_BUNDLE_HEADER_BYTES,
  maxHeaderPairs: DEFAULT_ADMIN_BUNDLE_HEADER_PAIRS,
};

export const adminBundleManifestEntrySchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    executable: z.boolean(),
  })
  .strict();

export const adminBundleInstallationSchema = z
  .object({
    sourceKind: z.string().min(1).max(128),
    sourceIdentity: z
      .string()
      .min(1)
      .max(64 * 1024),
    channel: z.string().min(1).max(256).optional(),
  })
  .strict();

export const adminBundleManifestSchema = z
  .object({
    version: z.literal(1),
    files: z.array(adminBundleManifestEntrySchema).min(1),
    historyLimit: z.number().int().nonnegative().nullable().optional(),
    sourceRevision: z.string().min(1).optional(),
    sourceContentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    detachInstallation: z.boolean().optional(),
    installation: adminBundleInstallationSchema.optional(),
  })
  .strict()
  .openapi("AdminCapletBundleManifest");

export type AdminBundleManifest = z.infer<typeof adminBundleManifestSchema>;
export type AdminBundleManifestEntry = z.infer<typeof adminBundleManifestEntrySchema>;
