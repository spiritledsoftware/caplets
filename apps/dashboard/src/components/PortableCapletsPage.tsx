import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  DownloadIcon,
  EyeIcon,
  FileUpIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DASHBOARD_PORTABLE_CHUNK_BYTES,
  dashboardApi,
  dashboardPortableDownload,
  dashboardPortableOperation,
  dashboardPortableStatus,
  dashboardPortableUploadChunk,
  type DashboardPortableArtifact,
  type DashboardPortableOutcome,
  type DashboardPortableProposal,
  type DashboardPortableSetupDependency,
} from "@/lib/api";
import { dashboardPath } from "@/lib/paths";
import {
  capletDetailHref,
  capletsListHref,
  capletsLocationFromPath,
  safeCapletsReturnHref,
  type CapletsHistoryState,
  type CapletsLocation,
} from "./caplets-route";

const MAX_PORTABLE_BYTES = 256 * 1024 * 1024;
const PORTABLE_CHUNK_BYTES = DASHBOARD_PORTABLE_CHUNK_BYTES;
const LIVE_REASON_ID = "portable-live-authority-reason";

export type PortableCapletRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  source?: string;
  activation?: string;
  owner?: string;
  provenance?: { id?: string; kind?: string };
  shadowChain?: Array<{ owner?: string; source?: { kind?: string }; provenance?: { id?: string } }>;
  setupRequired?: boolean | "true" | "false";
  expectedAggregateVersion?: number;
  expectedAuthorityToken?: { authorityGeneration: number; effectiveGeneration: number };
  expectedSecurityEpoch?: number;
};

export type PortableManagementTarget = {
  id?: string;
  selector?: "effective" | "underlying-sql";
  owner?: "sql" | "filesystem";
  source?: { kind?: string };
  effective?: boolean;
  underlyingSqlAvailable?: boolean;
  shadowChain?: Array<{ owner?: string; source?: { kind?: string }; provenance?: { id?: string } }>;
};

export type PortableCapletsPageProps = {
  caplets: PortableCapletRecord[];
  managementTargets: PortableManagementTarget[];
  loading: boolean;
  liveAuthorityAvailable: boolean;
  liveAuthorityUnavailableReason: string;
  renderCapletSummary?: (caplet: PortableCapletRecord) => ReactNode;
  renderCapletAction?: (caplet: PortableCapletRecord) => ReactNode;
};

type ImportState =
  | { phase: "idle" }
  | { phase: "preview"; artifact: DashboardPortableArtifact; proposal: DashboardPortableProposal }
  | {
      phase: "activated";
      caplet: {
        id: string;
        activation: string;
        setupDependencies: DashboardPortableSetupDependency[];
      };
    };

type Inspection = {
  target?: PortableManagementTarget;
  record?: Record<string, unknown>;
};

export function PortableCapletsPage({
  caplets,
  managementTargets,
  loading,
  liveAuthorityAvailable,
  liveAuthorityUnavailableReason,
  renderCapletSummary,
  renderCapletAction,
}: PortableCapletsPageProps) {
  const [location, setLocation] = useState<CapletsLocation>(() =>
    capletsLocationFromPath(window.location.pathname),
  );
  const [portableStatus, setPortableStatus] = useState<"live" | "stale-read-only" | "not-ready">();
  const [statusError, setStatusError] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [importState, setImportState] = useState<ImportState>({ phase: "idle" });
  const [uploadedArtifact, setUploadedArtifact] = useState<DashboardPortableArtifact>();
  const [collisionPolicy, setCollisionPolicy] = useState<"reject" | "replace">("reject");
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preview" | "activate" | "export" | "inspect" | "revalidate">();
  const [error, setError] = useState<string>();
  const [inspection, setInspection] = useState<Inspection>();
  const [selector, setSelector] = useState<"effective" | "underlying-sql">("effective");
  const [fileInputKey, setFileInputKey] = useState(0);
  const selectedFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void dashboardPortableStatus()
      .then((outcome) => {
        if (cancelled) return;
        setPortableStatus(outcome.status);
        setStatusError(false);
      })
      .catch(() => {
        if (!cancelled) setStatusError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const replay = () => {
      setLocation(capletsLocationFromPath(window.location.pathname));
      setInspection(undefined);
      setSelector("effective");
    };
    window.addEventListener("popstate", replay);
    return () => window.removeEventListener("popstate", replay);
  }, []);

  const resetImport = useCallback(() => {
    setSelectedFile(undefined);
    setImportState({ phase: "idle" });
    setUploadedArtifact(undefined);
    setCollisionPolicy("reject");
    setReplacementConfirmed(false);
    setActivationConfirmed(false);
    setError(undefined);
    setBusy(undefined);
    setFileInputKey((current) => current + 1);
  }, []);

  const currentCaplet =
    location.mode === "detail"
      ? caplets.find((caplet) => (caplet.id ?? caplet.name) === location.capletId)
      : undefined;
  const currentManagement =
    location.mode === "detail"
      ? managementTargets.find((target) => target.id === location.capletId)
      : undefined;

  async function previewImport() {
    if (!selectedFile || !liveAuthorityAvailable) return;
    if (collisionPolicy === "replace" && !replacementConfirmed) {
      setError("Confirm replacement before retrying the preview.");
      return;
    }
    setBusy("preview");
    setError(undefined);
    try {
      let artifact = uploadedArtifact;
      if (!artifact) {
        artifact = await uploadPortableFile(selectedFile);
        setUploadedArtifact(artifact);
      }
      const outcome = await dashboardPortableOperation(
        {
          kind: "portable_import_preview",
          artifactReference: artifact.reference,
          collisionPolicy,
          replacementConfirmed,
        },
        artifact.reference.operationId,
      );
      if (outcome.kind !== "portable_import_preview") {
        throw new Error("Portable preview returned an unexpected result.");
      }
      if (outcome.status === "rejected") {
        setImportState({ phase: "idle" });
        setError(previewRejectionMessage(outcome.reason));
        return;
      }
      setImportState({ phase: "preview", artifact, proposal: outcome.proposal });
      setActivationConfirmed(false);
    } catch (reason) {
      setError(safePortableError(reason, "Portable preview failed. Retry the import."));
    } finally {
      setBusy(undefined);
    }
  }

  async function activateImport() {
    if (importState.phase !== "preview" || !activationConfirmed || !liveAuthorityAvailable) return;
    setBusy("activate");
    setError(undefined);
    try {
      const outcome = await dashboardPortableOperation(
        {
          kind: "portable_import_activate",
          proposalId: importState.proposal.proposalId,
          proposalHash: importState.proposal.proposalHash,
        },
        importState.proposal.operationId,
      );
      if (outcome.kind !== "portable_import_activate") {
        throw new Error("Portable activation returned an unexpected result.");
      }
      if (outcome.status === "rejected") {
        setError(`Activation rejected: ${humanize(outcome.reason)}. Review and retry.`);
        return;
      }
      setImportState({ phase: "activated", caplet: outcome.caplet });
    } catch (reason) {
      setError(
        safePortableError(reason, "Portable activation failed. The proposal was not changed."),
      );
    } finally {
      setBusy(undefined);
    }
  }

  async function exportCaplet() {
    if (!currentCaplet || !liveAuthorityAvailable) return;
    const capletId = currentCaplet.id ?? currentCaplet.name;
    if (!capletId) return;
    setBusy("export");
    setError(undefined);
    try {
      const outcome = await dashboardPortableOperation({
        kind: "portable_export_create",
        capletId,
        selector,
      });
      if (outcome.kind !== "portable_export_create" || outcome.status !== "created") {
        throw new Error("Portable export was not created.");
      }
      const anchor = document.createElement("a");
      anchor.href = dashboardPortableDownload(outcome.artifact.reference.uri);
      anchor.download = `${safeFilename(capletId)}.${outcome.artifactType === "bundle" ? "caplet.zip" : "caplet"}`;
      anchor.click();
    } catch (reason) {
      setError(safePortableError(reason, "Portable export failed. Retry when the host is ready."));
    } finally {
      setBusy(undefined);
    }
  }

  async function inspectUnderlying() {
    if (!currentCaplet || !liveAuthorityAvailable) return;
    const capletId = currentCaplet.id ?? currentCaplet.name;
    if (!capletId) return;
    setBusy("inspect");
    setError(undefined);
    try {
      const result = await dashboardApi<Inspection>(
        `management/inspect?resource=caplet&id=${encodeURIComponent(capletId)}&selector=underlying-sql`,
      );
      setInspection(result);
      setSelector("underlying-sql");
    } catch (reason) {
      setError(safePortableError(reason, "Underlying SQL inspection failed."));
    } finally {
      setBusy(undefined);
    }
  }

  async function revalidateSetup() {
    if (!currentCaplet || !liveAuthorityAvailable) return;
    const capletId = currentCaplet.id ?? currentCaplet.name;
    if (
      !capletId ||
      currentCaplet.expectedAggregateVersion === undefined ||
      !currentCaplet.expectedAuthorityToken ||
      currentCaplet.expectedSecurityEpoch === undefined
    ) {
      setError("Refresh the Caplet detail before revalidating setup.");
      return;
    }
    setBusy("revalidate");
    setError(undefined);
    try {
      const outcome = await dashboardPortableOperation({
        kind: "portable_setup_revalidate",
        capletId,
        expectedAggregateVersion: currentCaplet.expectedAggregateVersion,
        expectedAuthorityToken: currentCaplet.expectedAuthorityToken,
        expectedSecurityEpoch: currentCaplet.expectedSecurityEpoch,
      });
      if (outcome.kind !== "portable_setup_revalidate") {
        throw new Error("Setup revalidation returned an unexpected result.");
      }
      if (outcome.status === "rejected") {
        setError(`Setup revalidation rejected: ${humanize(outcome.reason)}.`);
      }
    } catch (reason) {
      setError(safePortableError(reason, "Setup revalidation failed."));
    } finally {
      setBusy(undefined);
    }
  }

  function openDetail(event: MouseEvent<HTMLAnchorElement>, capletId: string) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    const listHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const href = capletDetailHref(capletId, window.location.pathname);
    window.history.pushState(
      { ...(window.history.state as object), capletsListHref: listHref },
      "",
      href,
    );
    setLocation({ mode: "detail", capletId });
    setInspection(undefined);
    setSelector("effective");
  }

  function returnToList() {
    const state = window.history.state as Partial<CapletsHistoryState> | null;
    const fallback = capletsListHref(window.location.pathname);
    const href = safeCapletsReturnHref(state?.capletsListHref ?? fallback, fallback);
    const previousId = location.mode === "detail" ? location.capletId : "";
    window.history.pushState({}, "", href);
    setLocation({ mode: "list" });
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-caplet-id="${CSS.escape(previousId)}"]`)?.focus();
    }, 0);
  }

  if (location.mode === "detail") {
    return (
      <CapletDetail
        caplet={currentCaplet}
        management={currentManagement}
        inspection={inspection}
        selector={selector}
        busy={busy}
        error={error}
        liveAuthorityAvailable={liveAuthorityAvailable}
        liveAuthorityUnavailableReason={liveAuthorityUnavailableReason}
        onReturn={returnToList}
        onSelectEffective={() => setSelector("effective")}
        onInspectUnderlying={() => void inspectUnderlying()}
        onExport={() => void exportCaplet()}
        onRevalidate={() => void revalidateSetup()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Caplets</h1>
          <p className="text-sm text-muted-foreground">
            Installed Caplets and portable operations.
          </p>
        </div>
        {portableStatus ? (
          <Badge variant={portableStatus === "live" ? "secondary" : "outline"}>
            Portable status: {humanize(portableStatus)}
          </Badge>
        ) : null}
      </div>

      {statusError ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Portable status is unavailable.</AlertTitle>
          <AlertDescription>Refresh the dashboard before starting an operation.</AlertDescription>
        </Alert>
      ) : null}
      {!liveAuthorityAvailable ? (
        <Alert role="status" id={LIVE_REASON_ID}>
          <AlertTriangleIcon />
          <AlertTitle>Portable operations are blocked</AlertTitle>
          <AlertDescription>{liveAuthorityUnavailableReason}</AlertDescription>
        </Alert>
      ) : null}
      {error ? <PortableError message={error} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Installed Caplets</CardTitle>
          <CardDescription>
            Select a Caplet to inspect effective and underlying state.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading installed Caplets…
            </p>
          ) : caplets.length ? (
            caplets.map((caplet) => {
              const capletId = caplet.id ?? caplet.name ?? "caplet";
              return (
                <div
                  key={capletId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <a
                    href={capletDetailHref(capletId, window.location.pathname)}
                    data-caplet-id={capletId}
                    className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={(event) => openDetail(event, capletId)}
                  >
                    <span className="block font-medium">{caplet.title ?? capletId}</span>
                    <span className="block text-sm text-muted-foreground">
                      {renderCapletSummary?.(caplet) ??
                        caplet.description ??
                        safeMetadata(caplet.source) ??
                        "No description available."}
                    </span>
                  </a>
                  {renderCapletAction?.(caplet)}
                </div>
              );
            })
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No Caplets are installed. Import a portable Caplet to add one safely.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Import a portable Caplet</CardTitle>
          <CardDescription>
            Selection and preview are inert. Nothing changes until you review and activate the
            proposal.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {importState.phase === "activated" ? (
            <div className="grid gap-3" role="status" aria-live="polite">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2Icon className="size-4 text-[var(--caplets-success)]" />
                Import activated
              </div>
              <dl className="grid gap-2 sm:grid-cols-2">
                <DetailField label="Caplet" value={importState.caplet.id} />
                <DetailField label="Activation" value={humanize(importState.caplet.activation)} />
              </dl>
              <Button type="button" variant="outline" className="w-fit" onClick={resetImport}>
                Import another
              </Button>
            </div>
          ) : (
            <>
              <label className="grid gap-2 text-sm font-medium">
                Select a portable Caplet file
                <input
                  key={fileInputKey}
                  ref={selectedFileRef}
                  type="file"
                  accept=".caplet,.zip,application/vnd.caplets.portable,application/zip"
                  className="min-h-11 rounded-lg border bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-secondary-foreground"
                  disabled={!liveAuthorityAvailable || busy !== undefined}
                  aria-describedby={!liveAuthorityAvailable ? LIVE_REASON_ID : undefined}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    setError(undefined);
                    setImportState({ phase: "idle" });
                    setUploadedArtifact(undefined);
                    if (file && file.size > MAX_PORTABLE_BYTES) {
                      setSelectedFile(undefined);
                      setError("Portable Caplet files cannot exceed 256 MiB.");
                      return;
                    }
                    setSelectedFile(file);
                  }}
                />
              </label>

              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Collision decision</legend>
                <label className="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <input
                    type="radio"
                    name="portable-collision-policy"
                    value="reject"
                    checked={collisionPolicy === "reject"}
                    onChange={() => {
                      setCollisionPolicy("reject");
                      setReplacementConfirmed(false);
                    }}
                  />
                  Reject an existing SQL Caplet
                </label>
                <label className="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <input
                    type="radio"
                    name="portable-collision-policy"
                    value="replace"
                    checked={collisionPolicy === "replace"}
                    onChange={() => setCollisionPolicy("replace")}
                  />
                  Preview replacement of an existing SQL Caplet
                </label>
              </fieldset>

              {collisionPolicy === "replace" ? (
                <label className="flex min-h-11 items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    name="portable-replacement-confirmation"
                    checked={replacementConfirmed}
                    onChange={(event) => setReplacementConfirmed(event.currentTarget.checked)}
                  />
                  I intend to replace the colliding SQL-owned Caplet.
                </label>
              ) : null}

              {importState.phase === "preview" ? (
                <ProposalPreview proposal={importState.proposal} />
              ) : null}

              {importState.phase === "preview" ? (
                <label className="flex min-h-11 items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    name="portable-activation-confirmation"
                    checked={activationConfirmed}
                    onChange={(event) => setActivationConfirmed(event.currentTarget.checked)}
                  />
                  I reviewed the inert diff, collision consequence, and setup requirements.
                </label>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {importState.phase === "preview" ? (
                  <Button
                    type="button"
                    onClick={() => void activateImport()}
                    disabled={!activationConfirmed || busy !== undefined || !liveAuthorityAvailable}
                    aria-busy={busy === "activate"}
                    aria-describedby={!liveAuthorityAvailable ? LIVE_REASON_ID : undefined}
                  >
                    <CheckCircle2Icon data-icon="inline-start" />
                    Activate import
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => void previewImport()}
                    disabled={!selectedFile || busy !== undefined || !liveAuthorityAvailable}
                    aria-busy={busy === "preview"}
                    aria-describedby={!liveAuthorityAvailable ? LIVE_REASON_ID : undefined}
                  >
                    {busy === "preview" ? (
                      <RefreshCwIcon className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <FileUpIcon />
                    )}
                    {error ? "Retry preview" : "Preview import"}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={resetImport}
                  disabled={busy !== undefined}
                >
                  <XIcon data-icon="inline-start" />
                  Cancel import
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CapletDetail({
  caplet,
  management,
  inspection,
  selector,
  busy,
  error,
  liveAuthorityAvailable,
  liveAuthorityUnavailableReason,
  onReturn,
  onSelectEffective,
  onInspectUnderlying,
  onExport,
  onRevalidate,
}: {
  caplet?: PortableCapletRecord;
  management?: PortableManagementTarget;
  inspection?: Inspection;
  selector: "effective" | "underlying-sql";
  busy?: "preview" | "activate" | "export" | "inspect" | "revalidate";
  error?: string;
  liveAuthorityAvailable: boolean;
  liveAuthorityUnavailableReason: string;
  onReturn: () => void;
  onSelectEffective: () => void;
  onInspectUnderlying: () => void;
  onExport: () => void;
  onRevalidate: () => void;
}) {
  const capletId = caplet?.id ?? caplet?.name;
  const target = selector === "underlying-sql" ? inspection?.target : management;
  const setupRequired = caplet?.setupRequired === true || caplet?.setupRequired === "true";
  return (
    <div className="flex flex-col gap-4">
      <Button type="button" variant="ghost" className="w-fit" onClick={onReturn}>
        <ArrowLeftIcon data-icon="inline-start" />
        Back to Caplets
      </Button>
      {!liveAuthorityAvailable ? (
        <Alert role="status" id={LIVE_REASON_ID}>
          <AlertTriangleIcon />
          <AlertTitle>Live operations are blocked</AlertTitle>
          <AlertDescription>{liveAuthorityUnavailableReason}</AlertDescription>
        </Alert>
      ) : null}
      {error ? <PortableError message={error} /> : null}
      {!caplet || !capletId ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Caplet unavailable</AlertTitle>
          <AlertDescription>Return to the list and refresh the dashboard.</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{caplet.title ?? capletId}</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              {caplet.description ?? "Installed Caplet detail."}
            </p>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>
                {selector === "effective" ? "Effective record" : "Underlying SQL record"}
              </CardTitle>
              <CardDescription>
                Ownership, provenance, and shadow status for this exact layer.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="Caplet inspection layer"
              >
                <Button
                  type="button"
                  variant={selector === "effective" ? "secondary" : "outline"}
                  onClick={onSelectEffective}
                >
                  <EyeIcon data-icon="inline-start" />
                  Effective
                </Button>
                <Button
                  type="button"
                  variant={selector === "underlying-sql" ? "secondary" : "outline"}
                  onClick={onInspectUnderlying}
                  disabled={
                    !management?.underlyingSqlAvailable ||
                    busy !== undefined ||
                    !liveAuthorityAvailable
                  }
                  aria-busy={busy === "inspect"}
                  aria-describedby={!liveAuthorityAvailable ? LIVE_REASON_ID : undefined}
                >
                  Underlying SQL
                </Button>
              </div>
              <dl className="grid gap-3 sm:grid-cols-2">
                <DetailField label="Caplet ID" value={capletId} />
                <DetailField
                  label="Layer"
                  value={selector === "effective" ? "Effective" : "Underlying SQL"}
                />
                <DetailField label="Owner" value={target?.owner ?? caplet.owner ?? "unknown"} />
                <DetailField
                  label="Source"
                  value={safeMetadata(target?.source?.kind ?? caplet.source) ?? "unknown"}
                />
                <DetailField label="Activation" value={humanize(caplet.activation ?? "unknown")} />
                <DetailField
                  label="Shadow status"
                  value={shadowSummary(target?.shadowChain ?? caplet.shadowChain)}
                />
                {selector === "underlying-sql" &&
                inspection?.record?.aggregateVersion !== undefined ? (
                  <DetailField
                    label="Aggregate version"
                    value={String(inspection.record.aggregateVersion)}
                  />
                ) : null}
              </dl>
            </CardContent>
          </Card>
          {setupRequired ? (
            <Card>
              <CardHeader>
                <CardTitle>Setup required</CardTitle>
                <CardDescription>
                  Complete authorized remediation, then revalidate against the current host token.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button
                  render={<a href={setupHref("local", window.location.href)} />}
                  nativeButton={false}
                  variant="outline"
                >
                  Open Vault setup
                </Button>
                <Button
                  type="button"
                  onClick={onRevalidate}
                  disabled={busy !== undefined || !liveAuthorityAvailable}
                  aria-busy={busy === "revalidate"}
                  aria-describedby={!liveAuthorityAvailable ? LIVE_REASON_ID : undefined}
                >
                  Revalidate setup
                </Button>
              </CardContent>
            </Card>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={onExport}
              disabled={busy !== undefined || !liveAuthorityAvailable}
              aria-busy={busy === "export"}
              aria-describedby={!liveAuthorityAvailable ? LIVE_REASON_ID : undefined}
            >
              <DownloadIcon data-icon="inline-start" />
              Export {selector === "effective" ? "effective" : "underlying SQL"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ProposalPreview({ proposal }: { proposal: DashboardPortableProposal }) {
  const requiredSetup = proposal.setupDependencies.filter(
    (dependency) => dependency.status === "required",
  );
  return (
    <section className="grid gap-4 rounded-lg border p-4" aria-labelledby="portable-preview-title">
      <div className="grid gap-1">
        <h2 id="portable-preview-title" className="font-semibold">
          Inert import preview
        </h2>
        <p className="text-sm text-muted-foreground">{proposal.consequence}</p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        <DetailField label="Caplet" value={proposal.capletId} />
        <DetailField label="Collision policy" value={humanize(proposal.collisionPolicy)} />
        <DetailField label="Proposal hash" value={proposal.proposalHash} />
        <DetailField label="Expires" value={formatTimestamp(proposal.expiresAt)} />
      </dl>
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Deterministic diff</h3>
        {proposal.differences.length ? (
          <ul className="grid gap-2">
            {proposal.differences.map((difference, index) => (
              <li
                key={`${difference.field}-${index}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm"
              >
                <code className="break-all">{difference.field}</code>
                <Badge variant="outline">{humanize(difference.effect)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No canonical field differences.</p>
        )}
      </div>
      {requiredSetup.length ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Setup decisions</h3>
          <ul className="grid gap-2">
            {requiredSetup.map((dependency) => (
              <li
                key={`${dependency.type}-${dependency.name}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm"
              >
                <span>
                  <code>{dependency.name}</code> · {humanize(dependency.type)}
                </span>
                <Button
                  render={<a href={setupHref(dependency.type, window.location.href)} />}
                  nativeButton={false}
                  size="sm"
                  variant="outline"
                >
                  Open setup
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Activation may commit this Caplet as setup required. It becomes runnable only after
            current-token revalidation succeeds.
          </p>
        </div>
      ) : null}
    </section>
  );
}

async function uploadPortableFile(file: File): Promise<DashboardPortableArtifact> {
  const operationId = `portable_${crypto.randomUUID()}`;
  const wholeSha256 = await sha256File(file);
  const created = await dashboardPortableOperation(
    {
      kind: "portable_import_session_create",
      expectedByteLength: file.size,
      expectedSha256: wholeSha256,
      mimeType: file.type || "application/octet-stream",
    },
    operationId,
  );
  if (
    created.kind !== "portable_import_session_create" ||
    created.session.operationId !== operationId
  ) {
    throw new Error("Portable upload session was not created for this operation.");
  }
  for (let offset = 0; offset < file.size; offset += PORTABLE_CHUNK_BYTES) {
    const bytes = new Uint8Array(
      await file.slice(offset, offset + PORTABLE_CHUNK_BYTES).arrayBuffer(),
    );
    await dashboardPortableUploadChunk({
      sessionId: created.session.sessionId,
      operationId,
      offset,
      sha256: sha256Bytes(bytes),
      bytes,
    });
  }
  const finalized = await dashboardPortableOperation(
    {
      kind: "portable_import_session_finalize",
      sessionId: created.session.sessionId,
    },
    operationId,
  );
  if (
    finalized.kind !== "portable_import_session_finalize" ||
    finalized.status !== "finalized" ||
    finalized.artifact.reference.operationId !== operationId
  ) {
    throw new Error("Portable upload could not be finalized for this operation.");
  }
  return finalized.artifact;
}

async function sha256File(file: File): Promise<string> {
  const digest = new IncrementalSha256();
  for (let offset = 0; offset < file.size; offset += PORTABLE_CHUNK_BYTES) {
    digest.update(
      new Uint8Array(await file.slice(offset, offset + PORTABLE_CHUNK_BYTES).arrayBuffer()),
    );
  }
  return digest.hex();
}

function sha256Bytes(bytes: Uint8Array): string {
  return new IncrementalSha256().update(bytes).hex();
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class IncrementalSha256 {
  readonly #state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  readonly #block = new Uint8Array(64);
  readonly #words = new Uint32Array(64);
  #blockLength = 0;
  #byteLength = 0;
  #finished = false;

  update(bytes: Uint8Array): this {
    if (this.#finished) throw new Error("SHA-256 digest is already finalized.");
    this.#byteLength += bytes.byteLength;
    let offset = 0;
    if (this.#blockLength > 0) {
      const copied = Math.min(64 - this.#blockLength, bytes.byteLength);
      this.#block.set(bytes.subarray(0, copied), this.#blockLength);
      this.#blockLength += copied;
      offset = copied;
      if (this.#blockLength === 64) {
        this.#transform(this.#block, 0);
        this.#blockLength = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.#transform(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.#block.set(bytes.subarray(offset), 0);
      this.#blockLength = bytes.byteLength - offset;
    }
    return this;
  }

  hex(): string {
    if (!this.#finished) {
      const bitLength = this.#byteLength * 8;
      this.#block[this.#blockLength] = 0x80;
      this.#blockLength += 1;
      if (this.#blockLength > 56) {
        this.#block.fill(0, this.#blockLength);
        this.#transform(this.#block, 0);
        this.#blockLength = 0;
      }
      this.#block.fill(0, this.#blockLength, 56);
      const high = Math.floor(bitLength / 0x1_0000_0000);
      const low = bitLength >>> 0;
      this.#block[56] = high >>> 24;
      this.#block[57] = high >>> 16;
      this.#block[58] = high >>> 8;
      this.#block[59] = high;
      this.#block[60] = low >>> 24;
      this.#block[61] = low >>> 16;
      this.#block[62] = low >>> 8;
      this.#block[63] = low;
      this.#transform(this.#block, 0);
      this.#finished = true;
    }
    return Array.from(this.#state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  #transform(bytes: Uint8Array, offset: number): void {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      this.#words[index] =
        (((bytes[start] ?? 0) << 24) |
          ((bytes[start + 1] ?? 0) << 16) |
          ((bytes[start + 2] ?? 0) << 8) |
          (bytes[start + 3] ?? 0)) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = this.#words[index - 15] ?? 0;
      const beforePrevious = this.#words[index - 2] ?? 0;
      const sigma0 =
        ((previous >>> 7) | (previous << 25)) ^
        ((previous >>> 18) | (previous << 14)) ^
        (previous >>> 3);
      const sigma1 =
        ((beforePrevious >>> 17) | (beforePrevious << 15)) ^
        ((beforePrevious >>> 19) | (beforePrevious << 13)) ^
        (beforePrevious >>> 10);
      this.#words[index] =
        (this.#words[index - 16]! + sigma0 + this.#words[index - 7]! + sigma1) >>> 0;
    }
    let a = this.#state[0]!;
    let b = this.#state[1]!;
    let c = this.#state[2]!;
    let d = this.#state[3]!;
    let e = this.#state[4]!;
    let f = this.#state[5]!;
    let g = this.#state[6]!;
    let h = this.#state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const first =
        (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + this.#words[index]!) >>> 0;
      const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + sum0 + majority) >>> 0;
    }
    this.#state[0] = (this.#state[0]! + a) >>> 0;
    this.#state[1] = (this.#state[1]! + b) >>> 0;
    this.#state[2] = (this.#state[2]! + c) >>> 0;
    this.#state[3] = (this.#state[3]! + d) >>> 0;
    this.#state[4] = (this.#state[4]! + e) >>> 0;
    this.#state[5] = (this.#state[5]! + f) >>> 0;
    this.#state[6] = (this.#state[6]! + g) >>> 0;
    this.#state[7] = (this.#state[7]! + h) >>> 0;
  }
}

function previewRejectionMessage(
  reason: Extract<
    DashboardPortableOutcome,
    { kind: "portable_import_preview"; status: "rejected" }
  >["reason"],
): string {
  if (reason === "sql-collision")
    return "SQL collision rejected. Choose replacement, confirm it, and retry the preview.";
  if (reason === "filesystem-owned")
    return "Filesystem-owned Caplets cannot be replaced by portable import.";
  return `Preview rejected: ${humanize(reason)}.`;
}

function safePortableError(reason: unknown, fallback: string): string {
  const message = reason instanceof Error ? reason.message : "";
  return /(?:^|\s)(?:\/[\w.-]+){2,}|[a-z]:\\|file:\/\//iu.test(message)
    ? fallback
    : message || fallback;
}

function setupHref(type: DashboardPortableSetupDependency["type"], returnTo: string): string {
  const fallback = capletsListHref(window.location.pathname);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const safeReturn = safeCapletsReturnHref(
    new URL(returnTo, window.location.origin).pathname +
      new URL(returnTo, window.location.origin).search,
    current || fallback,
  );
  const route = type === "local" ? "vault" : type === "external" ? "runtime" : "settings";
  return `${dashboardPath(route)}?returnTo=${encodeURIComponent(safeReturn)}`;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="font-mono text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="m-0 break-words [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function PortableError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>Portable operation needs attention</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function safeMetadata(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return /^(?:\/|[a-z]:\\|file:\/\/)/iu.test(value) ? "Local source" : value;
}

function shadowSummary(chain: PortableManagementTarget["shadowChain"]): string {
  if (!chain?.length) return "No shadow chain";
  return chain
    .map(
      (layer) => `${layer.owner ?? "unknown"} (${safeMetadata(layer.source?.kind) ?? "unknown"})`,
    )
    .join(" → ");
}

function safeFilename(value: string): string {
  const safe = value
    .normalize("NFC")
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "");
  return safe || "caplet";
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "unknown";
}

function humanize(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}
