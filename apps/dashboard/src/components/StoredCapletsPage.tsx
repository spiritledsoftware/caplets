import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ClipboardIcon,
  DatabaseIcon,
  DownloadIcon,
  FilePenLineIcon,
  HistoryIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  adminV2CreateCapletRecordFromDocument,
  adminV2DeleteCapletRecord,
  adminV2DeleteCapletRecordRevision,
  adminV2GetCapletRecord,
  adminV2GetCapletRecordRevision,
  adminV2ListCapletRecordRevisions,
  adminV2ListCapletRecords,
  adminV2PutCapletRecordCurrentRevision,
  adminV2UpdateCapletRecord,
  createDashboardMutationIntent,
} from "@/lib/api";

type StoredCapletRevision = {
  revisionKey: string;
  sequence?: number;
  name?: string;
  description?: string;
  contentHash?: string;
  sourceRevision?: string | null;
  createdAt?: string;
};

export type StoredCapletRecord = {
  id: string;
  name?: string;
  description?: string;
  generation?: number;
  headGeneration?: number;
  recordKey?: string;
  historyLimit?: number | null;
  createdAt?: string;
  updatedAt?: string;
  storageKind?: string;
  currentRevision?: StoredCapletRevision | string;
};

type StoredCapletDetail = {
  record: StoredCapletRecord;
  document: string;
  revisions: StoredCapletRevision[];
  revisionNextCursor?: string;
  etag: string;
};
type StoredCapletPage = {
  items: StoredCapletRecord[];
  nextCursor?: string;
};

type StoredCapletsAction = (
  label: string | ((result: unknown) => string),
  callback: () => Promise<unknown>,
) => Promise<void>;

export type StoredCapletsPageProps = {
  action: StoredCapletsAction;
  confirmAction: (title: string, description: string) => Promise<boolean>;
  confirmDestructive: (
    title: string,
    description: string,
    confirmLabel?: string,
  ) => Promise<boolean>;
  confirmTyped: (title: string, description: string, expectedPhrase: string) => Promise<boolean>;
};

function generationOf(record: StoredCapletRecord): number {
  return record.generation ?? record.headGeneration ?? 0;
}

function currentRevisionKey(record: StoredCapletRecord): string | undefined {
  if (typeof record.currentRevision === "string") return record.currentRevision;
  return record.currentRevision?.revisionKey;
}

function recordName(record: StoredCapletRecord): string {
  if (record.name) return record.name;
  if (typeof record.currentRevision === "object" && record.currentRevision?.name) {
    return record.currentRevision.name;
  }
  return record.id;
}

function recordDescription(record: StoredCapletRecord): string | undefined {
  if (record.description) return record.description;
  if (typeof record.currentRevision === "object") return record.currentRevision?.description;
  return undefined;
}

function retentionLabel(limit: number | null | undefined): string {
  if (limit === null) return "Host default";
  if (limit === undefined) return "Not reported";
  return `${limit} revision${limit === 1 ? "" : "s"}`;
}

function timestampLabel(value: string | undefined): string {
  if (!value) return "Not reported";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return timestamp.toLocaleString();
}

async function fetchStoredCaplets(cursor?: string) {
  return cursor === undefined ? adminV2ListCapletRecords() : adminV2ListCapletRecords({ cursor });
}

async function fetchStoredCapletDetail(id: string): Promise<StoredCapletDetail> {
  const [current, revisions] = await Promise.all([
    adminV2GetCapletRecord(id),
    adminV2ListCapletRecordRevisions(id),
  ]);
  return {
    record: current.data.record,
    document: current.data.document,
    revisions: revisions.items,
    revisionNextCursor: revisions.nextCursor,
    etag: current.etag,
  };
}

export function StoredCapletsPage({
  action,
  confirmAction,
  confirmDestructive,
  confirmTyped,
}: StoredCapletsPageProps) {
  const [records, setRecords] = useState<StoredCapletRecord[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string>();
  const [listNextCursor, setListNextCursor] = useState<string>();
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listPaginationError, setListPaginationError] = useState<string>();
  const [importOpen, setImportOpen] = useState(false);
  const [importId, setImportId] = useState("");
  const [importHistoryLimit, setImportHistoryLimit] = useState("");
  const [importDocument, setImportDocument] = useState("");
  const [importFileName, setImportFileName] = useState<string>();
  const [importError, setImportError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<StoredCapletDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [revisionLoadingMore, setRevisionLoadingMore] = useState(false);
  const [revisionPaginationError, setRevisionPaginationError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyAction, setBusyAction] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const recordCursors = useRef(new Set<string>());
  const revisionCursors = useRef(new Set<string>());
  const replaceRecordPage = useCallback((page: StoredCapletPage) => {
    recordCursors.current = new Set(page.nextCursor ? [page.nextCursor] : []);
    setRecords(page.items);
    setListNextCursor(page.nextCursor);
    setListPaginationError(undefined);
  }, []);
  const replaceDetail = useCallback((loaded: StoredCapletDetail) => {
    revisionCursors.current = new Set(loaded.revisionNextCursor ? [loaded.revisionNextCursor] : []);
    setDetail(loaded);
    setRevisionPaginationError(undefined);
  }, []);

  const loadRecords = useCallback(async () => {
    const request = ++listRequest.current;
    setListLoading(true);
    setListLoadingMore(false);
    setListError(undefined);
    setListPaginationError(undefined);
    setListNextCursor(undefined);
    recordCursors.current = new Set();
    try {
      const page = await fetchStoredCaplets();
      if (request !== listRequest.current) return;
      replaceRecordPage(page);
    } catch (error) {
      if (request === listRequest.current) {
        setListError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
  }, [replaceRecordPage]);

  const loadDetail = useCallback(
    async (id: string) => {
      const request = ++detailRequest.current;
      setDetailLoading(true);
      setRevisionLoadingMore(false);
      setDetailError(undefined);
      setRevisionPaginationError(undefined);
      revisionCursors.current = new Set();
      try {
        const loaded = await fetchStoredCapletDetail(id);
        if (request !== detailRequest.current) return;
        replaceDetail(loaded);
        setDraft(loaded.document);
        setEditing(false);
        setMutationError(undefined);
      } catch (error) {
        if (request === detailRequest.current) {
          setDetail(undefined);
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (request === detailRequest.current) setDetailLoading(false);
      }
    },
    [replaceDetail],
  );

  async function loadMoreRecords() {
    if (!listNextCursor || listLoadingMore) return;
    const cursor = listNextCursor;
    const request = listRequest.current;
    setListLoadingMore(true);
    setListPaginationError(undefined);
    try {
      const page = await fetchStoredCaplets(cursor);
      if (request !== listRequest.current) return;
      if (page.nextCursor !== undefined && recordCursors.current.has(page.nextCursor)) {
        throw new Error("Stored Caplet pagination returned a repeated cursor.");
      }
      if (page.nextCursor !== undefined) recordCursors.current.add(page.nextCursor);
      setRecords((current) => [...current, ...page.items]);
      setListNextCursor(page.nextCursor);
    } catch (error) {
      if (request === listRequest.current) {
        setListPaginationError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === listRequest.current) setListLoadingMore(false);
    }
  }

  async function loadMoreRevisions() {
    if (!detail?.revisionNextCursor || revisionLoadingMore) return;
    const cursor = detail.revisionNextCursor;
    const recordId = detail.record.id;
    const request = detailRequest.current;
    setRevisionLoadingMore(true);
    setRevisionPaginationError(undefined);
    try {
      const page = await adminV2ListCapletRecordRevisions(recordId, { cursor });
      if (request !== detailRequest.current) return;
      if (page.nextCursor !== undefined && revisionCursors.current.has(page.nextCursor)) {
        throw new Error("Stored Caplet revision pagination returned a repeated cursor.");
      }
      if (page.nextCursor !== undefined) revisionCursors.current.add(page.nextCursor);
      setDetail((current) =>
        current?.record.id === recordId
          ? {
              ...current,
              revisions: [...current.revisions, ...page.items],
              revisionNextCursor: page.nextCursor,
            }
          : current,
      );
    } catch (error) {
      if (request === detailRequest.current) {
        setRevisionPaginationError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === detailRequest.current) setRevisionLoadingMore(false);
    }
  }

  useEffect(() => {
    void loadRecords();
    return () => {
      ++listRequest.current;
    };
  }, [loadRecords]);

  useEffect(() => {
    if (!selectedId) {
      ++detailRequest.current;
      setDetail(undefined);
      setDetailError(undefined);
      setEditing(false);
      setMutationError(undefined);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(
    () => () => {
      ++detailRequest.current;
    },
    [],
  );

  const sortedRecords = useMemo(
    () => [...records].sort((left, right) => left.id.localeCompare(right.id)),
    [records],
  );
  const dirty = Boolean(detail && editing && draft !== detail.document);

  async function refreshAfterMutation(id: string) {
    const [nextDetail, nextRecords] = await Promise.all([
      fetchStoredCapletDetail(id),
      fetchStoredCaplets(),
    ]);
    replaceDetail(nextDetail);
    setDraft(nextDetail.document);
    replaceRecordPage(nextRecords);
    setEditing(false);
    setMutationError(undefined);
  }

  function mutationFailure(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    setMutationError(message);
    throw error;
  }

  function resetImport() {
    setImportId("");
    setImportHistoryLimit("");
    setImportDocument("");
    setImportFileName(undefined);
    setImportError(undefined);
  }

  async function submitImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = importId.trim();
    const historyLimitText = importHistoryLimit.trim();
    const historyLimit = historyLimitText === "" ? undefined : Number(historyLimitText);
    if (!id) {
      setImportError("Enter the stored Caplet id.");
      return;
    }
    if (!importDocument.trim()) {
      setImportError("Add a CAPLET.md document or choose a Markdown file.");
      return;
    }
    if (historyLimit !== undefined && (!Number.isSafeInteger(historyLimit) || historyLimit < 0)) {
      setImportError("History limit must be a non-negative whole number.");
      return;
    }

    setImportError(undefined);
    setBusyAction("import");
    try {
      const intent = createDashboardMutationIntent();
      await action(`Imported ${id}`, async () => {
        try {
          const response = await adminV2CreateCapletRecordFromDocument(
            id,
            importDocument,
            intent,
            historyLimit,
          );
          const nextRecords = await fetchStoredCaplets();
          replaceRecordPage(nextRecords);
          resetImport();
          setImportOpen(false);
          setSelectedId(response.id);
          return response;
        } catch (error) {
          setImportError(error instanceof Error ? error.message : String(error));
          throw error;
        }
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function chooseMarkdown(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setImportDocument(await file.text());
      setImportFileName(file.name);
      setImportError(undefined);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read the Markdown file.");
    }
  }

  async function saveDocument() {
    if (!detail || !draft.trim() || busyAction) return;
    const id = detail.record.id;
    setBusyAction("save");
    setMutationError(undefined);
    try {
      const intent = createDashboardMutationIntent();
      await action(`Saved ${id}`, async () => {
        try {
          const result = await adminV2UpdateCapletRecord(
            id,
            { document: draft },
            detail.etag,
            intent,
          );
          await refreshAfterMutation(id);
          return result;
        } catch (error) {
          return mutationFailure(error);
        }
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function restoreRevision(revision: StoredCapletRevision) {
    if (!detail || busyAction) return;
    const id = detail.record.id;
    const confirmed = await confirmAction(
      `Restore revision ${revision.sequence ?? revision.revisionKey}?`,
      "Restoring creates a new current revision from this stored snapshot. The present document remains in SQL history.",
    );
    if (!confirmed) return;

    setBusyAction(`restore:${revision.revisionKey}`);
    setMutationError(undefined);
    try {
      const intent = createDashboardMutationIntent();
      await action(`Restored revision ${revision.sequence ?? revision.revisionKey}`, async () => {
        try {
          const result = await adminV2PutCapletRecordCurrentRevision(
            id,
            revision.revisionKey,
            detail.etag,
            intent,
          );
          await refreshAfterMutation(id);
          return result;
        } catch (error) {
          return mutationFailure(error);
        }
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function deleteRevision(revision: StoredCapletRevision) {
    if (!detail || busyAction) return;
    const id = detail.record.id;
    const confirmed = await confirmDestructive(
      `Delete revision ${revision.sequence ?? revision.revisionKey}?`,
      "This permanently removes the selected SQL revision. It does not delete file overlays or Vault values.",
      "Delete revision",
    );
    if (!confirmed) return;

    setBusyAction(`delete-revision:${revision.revisionKey}`);
    setMutationError(undefined);
    try {
      const intent = createDashboardMutationIntent();
      await action(`Deleted revision ${revision.sequence ?? revision.revisionKey}`, async () => {
        try {
          const revisionDetail = await adminV2GetCapletRecordRevision(id, revision.revisionKey);
          const result = await adminV2DeleteCapletRecordRevision(
            id,
            revision.revisionKey,
            revisionDetail.etag,
            detail.etag,
            intent,
          );
          const nextRecords = await fetchStoredCaplets();
          replaceRecordPage(nextRecords);
          if (result.record) {
            const nextDetail = await fetchStoredCapletDetail(id);
            replaceDetail(nextDetail);
            setDraft(nextDetail.document);
            setEditing(false);
          } else {
            setSelectedId(undefined);
          }
          return result;
        } catch (error) {
          return mutationFailure(error);
        }
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function deleteRecord() {
    if (!detail || busyAction) return;
    const id = detail.record.id;
    const phrase = `delete ${id}`;
    const confirmed = await confirmTyped(
      `Hard-delete ${recordName(detail.record)}?`,
      "This permanently deletes the SQL record and its revision history. Effective Caplets supplied by files or overlays are not removed.",
      phrase,
    );
    if (!confirmed) return;

    setBusyAction("delete-record");
    setMutationError(undefined);
    try {
      const intent = createDashboardMutationIntent();
      await action(`Deleted stored Caplet ${id}`, async () => {
        try {
          const result = await adminV2DeleteCapletRecord(id, detail.etag, intent);
          replaceRecordPage(await fetchStoredCaplets());
          setSelectedId(undefined);
          return result;
        } catch (error) {
          return mutationFailure(error);
        }
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function returnToList() {
    if (dirty) {
      const confirmed = await confirmAction(
        "Discard unsaved Markdown?",
        "Your edits have not been saved to the SQL record.",
      );
      if (!confirmed) return;
    }
    setSelectedId(undefined);
  }

  async function copyDocument() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.document);
      toast.success("CAPLET.md copied");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not copy CAPLET.md");
    }
  }

  function downloadDocument() {
    if (!detail) return;
    const blob = new Blob([detail.document], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${detail.record.id}-CAPLET.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("CAPLET.md downloaded");
  }

  if (selectedId) {
    return (
      <StoredCapletDetailView
        id={selectedId}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        editing={editing}
        draft={draft}
        dirty={dirty}
        busyAction={busyAction}
        mutationError={mutationError}
        revisionLoadingMore={revisionLoadingMore}
        revisionPaginationError={revisionPaginationError}
        onBack={() => void returnToList()}
        onRetry={() => void loadDetail(selectedId)}
        onEdit={() => setEditing(true)}
        onCancelEdit={() => {
          setDraft(detail?.document ?? "");
          setEditing(false);
          setMutationError(undefined);
        }}
        onDraftChange={setDraft}
        onSave={() => void saveDocument()}
        onCopy={() => void copyDocument()}
        onDownload={downloadDocument}
        onRestore={(revision) => void restoreRevision(revision)}
        onDeleteRevision={(revision) => void deleteRevision(revision)}
        onDeleteRecord={() => void deleteRecord()}
        onLoadMoreRevisions={() => void loadMoreRevisions()}
      />
    );
  }

  return (
    <main className="flex flex-col gap-4" aria-labelledby="stored-caplets-title">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 id="stored-caplets-title" className="text-2xl font-semibold">
            Stored Caplets
          </h1>
          <p className="max-w-[70ch] text-muted-foreground">
            Import and maintain versioned Caplet Records in the Current Host SQL store.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setImportOpen((open) => !open);
            setImportError(undefined);
          }}
          aria-expanded={importOpen}
          aria-controls="stored-caplet-import"
        >
          <UploadIcon data-icon="inline-start" />
          Import CAPLET.md
        </Button>
      </header>

      <Alert>
        <DatabaseIcon />
        <AlertTitle>SQL records are a separate source</AlertTitle>
        <AlertDescription>
          This inventory shows stored SQL records and their revisions. The effective Caplets view
          can also include filesystem or overlay sources. Vault values and stored asset contents are
          never shown here.
        </AlertDescription>
      </Alert>

      {importOpen ? (
        <Card id="stored-caplet-import">
          <CardHeader>
            <CardTitle>Import a stored Caplet</CardTitle>
            <CardDescription>
              Supply the record id and exact CAPLET.md document. History retention is optional and
              can only be set during import through the available dashboard API.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={(event) => void submitImport(event)}>
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field data-invalid={Boolean(importError && !importId.trim())}>
                    <FieldLabel htmlFor="stored-caplet-id">Record id</FieldLabel>
                    <Input
                      id="stored-caplet-id"
                      value={importId}
                      onChange={(event) => setImportId(event.target.value)}
                      placeholder="team-caplet"
                      autoComplete="off"
                      aria-invalid={Boolean(importError && !importId.trim())}
                      disabled={busyAction === "import"}
                    />
                    <FieldDescription>The stable SQL Caplet Record id.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="stored-caplet-history-limit">
                      History limit (optional)
                    </FieldLabel>
                    <Input
                      id="stored-caplet-history-limit"
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={importHistoryLimit}
                      onChange={(event) => setImportHistoryLimit(event.target.value)}
                      placeholder="Host default"
                      disabled={busyAction === "import"}
                    />
                    <FieldDescription>Leave empty to inherit the host default.</FieldDescription>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="stored-caplet-file">Markdown file (optional)</FieldLabel>
                  <Input
                    id="stored-caplet-file"
                    type="file"
                    accept=".md,text/markdown,text/plain"
                    onChange={(event) => void chooseMarkdown(event)}
                    disabled={busyAction === "import"}
                  />
                  <FieldDescription>
                    {importFileName
                      ? `${importFileName} loaded into the editor below.`
                      : "Choose CAPLET.md or paste its contents below."}
                  </FieldDescription>
                </Field>
                <Field data-invalid={Boolean(importError && !importDocument.trim())}>
                  <FieldLabel htmlFor="stored-caplet-document">CAPLET.md</FieldLabel>
                  <Textarea
                    id="stored-caplet-document"
                    className="min-h-64 font-mono leading-relaxed"
                    value={importDocument}
                    onChange={(event) => setImportDocument(event.target.value)}
                    placeholder="# Caplet name"
                    spellCheck={false}
                    aria-invalid={Boolean(importError && !importDocument.trim())}
                    disabled={busyAction === "import"}
                  />
                  <FieldDescription>
                    Only the Markdown document is imported; this form does not upload asset
                    contents.
                  </FieldDescription>
                  {importError ? <FieldError>{importError}</FieldError> : null}
                </Field>
              </FieldGroup>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busyAction === "import"}
                  onClick={() => {
                    resetImport();
                    setImportOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={busyAction === "import"}
                  aria-busy={busyAction === "import"}
                >
                  {busyAction === "import" ? (
                    <RefreshCwIcon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <UploadIcon data-icon="inline-start" />
                  )}
                  Import record
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>SQL record inventory</CardTitle>
          <CardDescription>
            {listLoading
              ? "Loading stored records…"
              : `${records.length} stored record${records.length === 1 ? "" : "s"}`}
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={listLoading}
              aria-label="Refresh stored Caplets"
              onClick={() => void loadRecords()}
            >
              <RefreshCwIcon
                data-icon="inline-start"
                className={listLoading ? "animate-spin" : undefined}
              />
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          {listLoading ? (
            <div
              className="flex flex-col gap-3 px-4 py-5"
              role="status"
              aria-label="Loading stored Caplets"
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : listError ? (
            <Alert variant="destructive" className="m-4">
              <AlertTriangleIcon />
              <AlertTitle>Stored Caplets unavailable</AlertTitle>
              <AlertDescription>{listError}</AlertDescription>
              <Button type="button" variant="outline" onClick={() => void loadRecords()}>
                <RefreshCwIcon data-icon="inline-start" />
                Retry
              </Button>
            </Alert>
          ) : sortedRecords.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <DatabaseIcon />
                </EmptyMedia>
                <EmptyTitle>No SQL Caplet Records yet</EmptyTitle>
                <EmptyDescription>
                  Import a CAPLET.md to create a versioned record. File and overlay Caplets remain
                  in the separate effective view.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" onClick={() => setImportOpen(true)}>
                  <UploadIcon data-icon="inline-start" />
                  Import the first record
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Table>
              <TableCaption className="sr-only">
                SQL-backed Caplet Records with generation and retention metadata
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Caplet Record</TableHead>
                  <TableHead>Storage</TableHead>
                  <TableHead>Generation</TableHead>
                  <TableHead>Retention</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRecords.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="max-w-80 whitespace-normal">
                      <div className="font-medium">{recordName(record)}</div>
                      <div className="font-mono text-xs text-muted-foreground">{record.id}</div>
                      {recordDescription(record) ? (
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {recordDescription(record)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        <DatabaseIcon data-icon="inline-start" />
                        {record.storageKind ?? "SQL record"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono">{generationOf(record)}</TableCell>
                    <TableCell>{retentionLabel(record.historyLimit)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedId(record.id)}
                      >
                        Inspect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {!listLoading && !listError && (listNextCursor || listPaginationError) ? (
            <IncrementalPageFooter
              countLabel={`${records.length} stored Caplets loaded`}
              buttonLabel="Load more stored Caplets"
              loading={listLoadingMore}
              error={listPaginationError}
              onLoadMore={() => void loadMoreRecords()}
            />
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

type StoredCapletDetailViewProps = {
  id: string;
  detail?: StoredCapletDetail;
  loading: boolean;
  error?: string;
  editing: boolean;
  draft: string;
  dirty: boolean;
  busyAction?: string;
  mutationError?: string;
  revisionLoadingMore: boolean;
  revisionPaginationError?: string;
  onBack: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDraftChange: (document: string) => void;
  onSave: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onRestore: (revision: StoredCapletRevision) => void;
  onDeleteRevision: (revision: StoredCapletRevision) => void;
  onDeleteRecord: () => void;
  onLoadMoreRevisions: () => void;
};

function StoredCapletDetailView({
  id,
  detail,
  loading,
  error,
  editing,
  draft,
  dirty,
  busyAction,
  mutationError,
  revisionLoadingMore,
  revisionPaginationError,
  onBack,
  onRetry,
  onEdit,
  onCancelEdit,
  onDraftChange,
  onSave,
  onCopy,
  onDownload,
  onRestore,
  onDeleteRevision,
  onDeleteRecord,
  onLoadMoreRevisions,
}: StoredCapletDetailViewProps) {
  if (loading) {
    return (
      <main className="flex flex-col gap-4" aria-label={`Loading stored Caplet ${id}`}>
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </main>
    );
  }

  if (error || !detail) {
    return (
      <main className="flex flex-col gap-4" aria-labelledby="stored-caplet-error-title">
        <Button type="button" variant="ghost" className="w-fit" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Stored Caplets
        </Button>
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle id="stored-caplet-error-title">Stored Caplet unavailable</AlertTitle>
          <AlertDescription>{error ?? `Could not load ${id}.`}</AlertDescription>
          <Button type="button" variant="outline" onClick={onRetry}>
            <RefreshCwIcon data-icon="inline-start" />
            Retry
          </Button>
        </Alert>
      </main>
    );
  }

  const { record, revisions } = detail;
  const currentKey = currentRevisionKey(record);
  const current = typeof record.currentRevision === "object" ? record.currentRevision : undefined;

  return (
    <main className="flex flex-col gap-4" aria-labelledby="stored-caplet-detail-title">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Button type="button" variant="ghost" className="w-fit" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            Stored Caplets
          </Button>
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                <DatabaseIcon data-icon="inline-start" />
                SQL record
              </Badge>
              <Badge variant="secondary">Generation {generationOf(record)}</Badge>
              {dirty ? <Badge variant="secondary">Unsaved changes</Badge> : null}
            </div>
            <h1 id="stored-caplet-detail-title" className="text-2xl font-semibold">
              {recordName(record)}
            </h1>
            <p className="font-mono text-sm text-muted-foreground">{record.id}</p>
          </div>
        </div>
        <Button
          type="button"
          variant="destructive"
          disabled={Boolean(busyAction)}
          aria-busy={busyAction === "delete-record"}
          onClick={onDeleteRecord}
        >
          <Trash2Icon data-icon="inline-start" />
          Hard-delete record
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Storage provenance</CardTitle>
          <CardDescription>
            Authoritative SQL metadata for this record. This does not describe effective file or
            overlay precedence.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetadataTerm label="Storage" value={record.storageKind ?? "SQL-backed record"} />
            <MetadataTerm label="Generation" value={String(generationOf(record))} mono />
            <MetadataTerm label="Current revision" value={currentKey ?? "Not reported"} mono />
            <MetadataTerm label="History retention" value={retentionLabel(record.historyLimit)} />
            {record.recordKey ? (
              <MetadataTerm label="Record key" value={record.recordKey} mono />
            ) : null}
            <MetadataTerm label="Updated" value={timestampLabel(record.updatedAt)} />
            {current?.sourceRevision ? (
              <MetadataTerm label="Source revision" value={current.sourceRevision} mono />
            ) : null}
            {current?.contentHash ? (
              <MetadataTerm label="Content hash" value={current.contentHash} mono />
            ) : null}
          </dl>
        </CardContent>
      </Card>

      {mutationError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangleIcon />
          <AlertTitle>Stored record changed</AlertTitle>
          <AlertDescription>
            {mutationError} Reload the record before retrying if its generation is stale.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="col-span-2 sm:col-span-1">Current CAPLET.md</CardTitle>
          <CardDescription className="col-span-2 sm:col-span-1">
            Saves use compare-and-swap generation {generationOf(record)}. Asset and Vault contents
            are not loaded into this editor.
          </CardDescription>
          <CardAction className="col-span-2 col-start-1 row-start-3 mt-2 flex flex-wrap justify-start gap-2 sm:col-span-1 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCopy}
              disabled={Boolean(busyAction)}
            >
              <ClipboardIcon data-icon="inline-start" />
              Copy
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDownload}
              disabled={Boolean(busyAction)}
            >
              <DownloadIcon data-icon="inline-start" />
              Download
            </Button>
            {!editing ? (
              <Button type="button" size="sm" onClick={onEdit} disabled={Boolean(busyAction)}>
                <FilePenLineIcon data-icon="inline-start" />
                Edit Markdown
              </Button>
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent>
          <Field data-invalid={editing && !draft.trim()}>
            <FieldLabel htmlFor="stored-caplet-editor" className="sr-only">
              Current CAPLET.md document
            </FieldLabel>
            <Textarea
              id="stored-caplet-editor"
              className="min-h-96 font-mono leading-relaxed"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              readOnly={!editing}
              aria-readonly={!editing}
              aria-invalid={editing && !draft.trim()}
              spellCheck={false}
            />
            {editing && !draft.trim() ? <FieldError>CAPLET.md cannot be empty.</FieldError> : null}
          </Field>
        </CardContent>
        {editing ? (
          <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={busyAction === "save"}
              onClick={onCancelEdit}
            >
              Cancel edits
            </Button>
            <Button
              type="button"
              disabled={!dirty || !draft.trim() || busyAction === "save"}
              aria-busy={busyAction === "save"}
              onClick={onSave}
            >
              {busyAction === "save" ? (
                <RefreshCwIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              Save new revision
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Revision history</CardTitle>
          <CardDescription>
            Restore a prior snapshot or permanently remove one SQL revision. Retention is reported
            here but no separate retention mutation is exposed by this dashboard API.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {revisions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HistoryIcon />
                </EmptyMedia>
                <EmptyTitle>No revisions reported</EmptyTitle>
                <EmptyDescription>
                  Save a document change to create history for this SQL record.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableCaption className="sr-only">Revision history for {record.id}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Revision</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {revisions.map((revision) => {
                  const currentRevision = revision.revisionKey === currentKey;
                  const restoring = busyAction === `restore:${revision.revisionKey}`;
                  const deleting = busyAction === `delete-revision:${revision.revisionKey}`;
                  return (
                    <TableRow key={revision.revisionKey}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono">{revision.sequence ?? "—"}</span>
                          {currentRevision ? <Badge variant="secondary">Current</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell>{revision.name ?? recordName(record)}</TableCell>
                      <TableCell
                        className="max-w-64 truncate font-mono text-xs"
                        title={revision.revisionKey}
                      >
                        {revision.revisionKey}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={Boolean(busyAction) || currentRevision}
                            aria-busy={restoring}
                            aria-label={`Restore revision ${revision.sequence ?? revision.revisionKey}`}
                            onClick={() => onRestore(revision)}
                          >
                            {restoring ? (
                              <RefreshCwIcon className="animate-spin" />
                            ) : (
                              <HistoryIcon />
                            )}
                            Restore
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={Boolean(busyAction)}
                            aria-busy={deleting}
                            aria-label={`Delete revision ${revision.sequence ?? revision.revisionKey}`}
                            onClick={() => onDeleteRevision(revision)}
                          >
                            {deleting ? <RefreshCwIcon className="animate-spin" /> : <Trash2Icon />}
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {detail.revisionNextCursor || revisionPaginationError ? (
            <IncrementalPageFooter
              countLabel={`${revisions.length} revisions loaded`}
              buttonLabel="Load more revisions"
              loading={revisionLoadingMore}
              error={revisionPaginationError}
              onLoadMore={onLoadMoreRevisions}
            />
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

function IncrementalPageFooter({
  countLabel,
  buttonLabel,
  loading,
  error,
  onLoadMore,
}: {
  countLabel: string;
  buttonLabel: string;
  loading: boolean;
  error?: string;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-muted-foreground" aria-live="polite">
        {countLabel}
        {error ? (
          <p className="mt-1 text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={loading}
        aria-busy={loading}
        onClick={onLoadMore}
      >
        <RefreshCwIcon
          data-icon="inline-start"
          className={loading ? "animate-spin motion-reduce:animate-none" : undefined}
        />
        {buttonLabel}
      </Button>
    </div>
  );
}

function MetadataTerm({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={mono ? "truncate font-mono text-sm" : "text-sm"} title={value}>
        {value}
      </dd>
    </div>
  );
}
