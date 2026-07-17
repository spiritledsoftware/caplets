import { useEffect, useRef, useState } from "react";
import { AlertTriangleIcon, CopyIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { CatalogAuthorityButton } from "./CatalogAuthorityButton";
import type { CatalogCompactEntry } from "./catalog-state";

export type CatalogDetailEntry = CatalogCompactEntry & {
  contentMarkdown?: string;
  sourcePath?: string;
  resolvedRevision?: string;
  indexedContentHash?: string;
};

export type CatalogDetail = {
  entry: CatalogDetailEntry;
  setupActions?: Array<{ kind: string; label: string; required: boolean }>;
};

export type CatalogDetailState =
  | { status: "loading" }
  | { status: "available"; detail: CatalogDetail }
  | { status: "unreadable"; detail: CatalogDetail; message: string }
  | { status: "unavailable"; message: string }
  | { status: "failed"; message: string };

export function installableDetail(detail: CatalogDetail | undefined): detail is CatalogDetail {
  return Boolean(
    detail?.entry.contentMarkdown?.length &&
    detail.entry.installCommand.copyable &&
    detail.entry.installCommand.text.trim(),
  );
}

type CatalogDetailPageProps = {
  state: CatalogDetailState;
  installing: boolean;
  installUnavailableReason?: string;
  onRetry(): void;
  onReturn(): void;
  onInstall(detail: CatalogDetail): void;
  onCopy(command: string): Promise<void>;
};

export function CatalogDetailPage({
  state,
  installing,
  installUnavailableReason,
  onRetry,
  onReturn,
  onInstall,
  onCopy,
}: CatalogDetailPageProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (state.status !== "loading") heading.current?.focus();
  }, [state]);

  if (state.status === "loading") {
    return (
      <main aria-busy="true">
        <p role="status">Loading Caplet details…</p>
      </main>
    );
  }

  if (state.status === "unavailable" || state.status === "failed") {
    return (
      <main>
        <h1 ref={heading} tabIndex={-1}>
          Caplet unavailable
        </h1>
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>
            {state.status === "failed" ? "Could not load Caplet" : "Caplet unavailable"}
          </AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        <div className="mt-4 flex gap-2">
          {state.status === "failed" && <Button onClick={onRetry}>Retry</Button>}
          <Button variant="outline" onClick={onReturn}>
            Return to catalog
          </Button>
        </div>
      </main>
    );
  }

  const { entry, setupActions = [] } = state.detail;
  const safe = installableDetail(state.detail);
  const repositoryUrl = safeRepositoryUrl(entry.source?.repository);

  async function copyCommand() {
    try {
      await onCopy(entry.installCommand.text);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <main
      className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_330px]"
      aria-label="Catalog detail"
    >
      <Card>
        <CardHeader>
          <button className="w-fit text-sm underline" onClick={onReturn}>
            Catalog
          </button>
          <div className="flex gap-4">
            {entry.icon && (
              <img
                src={entry.icon.url}
                alt=""
                className="size-14 rounded-lg border object-contain p-2"
              />
            )}
            <div>
              <div className="flex gap-2">
                <Badge>{entry.trustLevel}</Badge>
                {repositoryUrl ? (
                  <a
                    href={repositoryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 underline"
                  >
                    {entry.source?.repository}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <span>{entry.source?.repository ?? "Source unavailable"}</span>
                )}
              </div>
              <h1 ref={heading} tabIndex={-1} className="mt-2 text-3xl font-medium">
                {entry.name}
              </h1>
              <CardDescription>{entry.description}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.status === "unreadable" && (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>Caplet content unreadable</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}
          <section className="rounded-lg border bg-secondary p-3">
            <h2 className="font-medium">Installation readiness review</h2>
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              <DetailField label="Trust" value={entry.trustLevel} fallback="unknown" />
              <DetailField label="Auth" value={entry.authReadiness} fallback="unknown" />
              <DetailField label="Setup" value={entry.setupReadiness} fallback="unknown" />
              <DetailField
                label="Project Binding"
                value={entry.projectBindingReadiness}
                fallback="unknown"
              />
            </dl>
            {setupActions.map((action) => (
              <div key={`${action.kind}-${action.label}`} className="mt-2">
                <Badge variant={action.required ? "destructive" : "outline"}>
                  {action.required ? "Required" : "Optional"}
                </Badge>{" "}
                {action.label}
              </div>
            ))}
          </section>
          {entry.warnings?.map((warning) => (
            <Alert
              key={warning.code}
              variant={warning.severity === "danger" ? "destructive" : "default"}
            >
              <AlertTriangleIcon />
              <AlertTitle>{warning.label}</AlertTitle>
              <AlertDescription>{warning.message}</AlertDescription>
            </Alert>
          ))}
          <section>
            <h2 className="font-medium">CAPLET.md</h2>
            {entry.contentMarkdown ? (
              <pre className="mt-2 max-h-[32rem] select-text overflow-auto whitespace-pre-wrap rounded-lg bg-primary p-4 text-sm text-primary-foreground">
                <code>{entry.contentMarkdown}</code>
              </pre>
            ) : (
              <p>Readable Caplet content is unavailable.</p>
            )}
          </section>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!safe} onClick={() => void copyCommand()}>
              <CopyIcon />
              Copy command
            </Button>
            <CatalogAuthorityButton
              disabled={!safe || installing}
              unavailableReason={installUnavailableReason}
              onClick={() => onInstall(state.detail)}
            >
              <DownloadIcon />
              {installing ? "Installing…" : "Install"}
            </CatalogAuthorityButton>
          </div>
          {copyFailed && (
            <code role="status" className="block select-all overflow-x-auto rounded bg-muted p-2">
              {entry.installCommand.text}
            </code>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="font-medium">Record</h2>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            <RecordField label="Source path" value={entry.sourcePath} />
            <RecordField label="Workflow" value={entry.workflow?.label} />
            <RecordField
              label="Installs"
              value={entry.installCountDisplay ?? String(entry.installCount ?? "—")}
            />
            <RecordField label="Revision" value={entry.resolvedRevision} />
            <RecordField label="Content hash" value={entry.indexedContentHash} />
          </dl>
        </CardContent>
      </Card>
    </main>
  );
}

function safeRepositoryUrl(repository: string | undefined): string | undefined {
  if (!repository) return;

  try {
    const url = new URL(
      repository.includes("://") ? repository : `https://github.com/${repository}`,
    );
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return;
  }
}

function DetailField({
  label,
  value,
  fallback,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
}) {
  return (
    <div className="rounded bg-background p-2">
      <dt className="text-xs font-bold text-muted-foreground">{label}</dt>
      <dd>{value ?? fallback}</dd>
    </div>
  );
}

function RecordField({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <dt className="text-xs font-bold text-muted-foreground">{label}</dt>
      <dd className="break-all">{value ?? "Not indexed"}</dd>
    </div>
  );
}
