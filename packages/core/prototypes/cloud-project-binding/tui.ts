import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  attachWorkspace,
  bindNewWorkspace,
  copyReceipt,
  createPrototypeState,
  reconcileSession,
  replaceLocalManifest,
  restartRuntime,
  retryRecovery,
  summarizeState,
  stageAttach,
  transferAuthority,
  type Manifest,
  type PrototypeResult,
} from "./model";

let state = createPrototypeState();

function apply(result: PrototypeResult): void {
  state = result.state;
  console.log(`\n${result.message}`);
  console.log(JSON.stringify(summarizeState(state), null, 2));
}

function parseManifest(value: string | undefined): Manifest {
  if (!value) {
    throw new Error('Manifest is required as JSON, for example: {"caplets/a.md":"v1"}');
  }
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.values(parsed).some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Manifest must be a JSON object whose values are content markers.");
  }
  return parsed as Manifest;
}

function manifestArgument(parts: string[], offset: number): Manifest {
  return parseManifest(parts.slice(offset).join(" "));
}

function required(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function runCommand(line: string): boolean {
  const parts = line.trim().split(/\s+/u);
  const command = parts[0]?.toLowerCase();
  if (!command) {
    return true;
  }

  switch (command) {
    case "bind":
      apply(
        bindNewWorkspace(state, {
          clientFingerprint: required(parts[1], "client"),
          projectFingerprint: required(parts[2], "project"),
          localManifest: manifestArgument(parts, 3),
        }),
      );
      return true;
    case "stage":
      apply(
        stageAttach(state, {
          clientFingerprint: required(parts[1], "client"),
          projectFingerprint: required(parts[2], "project"),
          attemptId: required(parts[3], "attempt"),
        }),
      );
      return true;
    case "attach":
    case "attach-lost":
      apply(
        attachWorkspace(state, {
          clientFingerprint: required(parts[1], "client"),
          projectFingerprint: required(parts[2], "project"),
          workspaceId: required(parts[3], "workspace"),
          attemptId: required(parts[4], "attempt"),
          localManifest: manifestArgument(parts, 5),
          loseResponse: command === "attach-lost",
        }),
      );
      return true;
    case "reconcile":
      apply(
        reconcileSession(state, required(parts[1], "session"), {
          interruptBeforeCommit: parts[2] === "interrupt",
        }),
      );
      return true;
    case "retry":
      apply(retryRecovery(state, required(parts[1], "session")));
      return true;
    case "local":
      apply(replaceLocalManifest(state, required(parts[1], "session"), manifestArgument(parts, 2)));
      return true;
    case "restart":
      apply(restartRuntime(state));
      return true;
    case "copy":
      apply(
        copyReceipt(state, {
          fromClientFingerprint: required(parts[1], "source client"),
          toClientFingerprint: required(parts[2], "target client"),
          projectFingerprint: required(parts[3], "project"),
        }),
      );
      return true;
    case "transfer":
      apply(
        transferAuthority(state, {
          clientFingerprint: required(parts[1], "client"),
          projectFingerprint: required(parts[2], "project"),
          workspaceId: required(parts[3], "workspace"),
          localManifest: manifestArgument(parts, 4),
        }),
      );
      return true;
    case "status":
      console.log(JSON.stringify(summarizeState(state), null, 2));
      return true;
    case "help":
      printHelp();
      return true;
    case "quit":
    case "exit":
      return false;
    default:
      throw new Error(`Unknown command: ${command}. Run help for the command list.`);
  }
}

function printHelp(): void {
  console.log(`
Commands:
  bind <client> <project> <manifest-json>
  copy <source-client> <target-client> <project>
  stage <client> <project> <attempt>
  attach <client> <project> <workspace> <attempt> <manifest-json>
  attach-lost <client> <project> <workspace> <attempt> <manifest-json>
  local <session> <manifest-json>
  reconcile <session> [interrupt]
  retry <session>
  restart
  transfer <client> <project> <workspace> <manifest-json>
  status
  help
  quit

The manifest JSON maps relative project paths to short content markers. The prototype
prints durable workspaces, ephemeral transports, and local receipts after every action.`);
}

function runDemo(): void {
  console.log("Project Binding prototype demo: restart, stale clone, fencing, and recovery.");
  apply(
    bindNewWorkspace(state, {
      clientFingerprint: "client-a",
      projectFingerprint: "project-x",
      localManifest: { "caplets/a.md": "v1" },
    }),
  );
  apply(
    copyReceipt(state, {
      fromClientFingerprint: "client-a",
      toClientFingerprint: "client-b",
      projectFingerprint: "project-x",
    }),
  );
  apply(
    replaceLocalManifest(state, "transport-1", {
      "caplets/a.md": "v2-local-a",
    }),
  );
  apply(reconcileSession(state, "transport-1"));
  apply(restartRuntime(state));
  apply(
    stageAttach(state, {
      clientFingerprint: "client-a",
      projectFingerprint: "project-x",
      attemptId: "attempt-a-2",
    }),
  );
  apply(
    attachWorkspace(state, {
      clientFingerprint: "client-a",
      projectFingerprint: "project-x",
      workspaceId: "ws-1",
      attemptId: "attempt-a-2",
      localManifest: { "caplets/a.md": "v3-offline-a" },
      loseResponse: true,
    }),
  );
  apply(
    attachWorkspace(state, {
      clientFingerprint: "client-a",
      projectFingerprint: "project-x",
      workspaceId: "ws-1",
      attemptId: "attempt-a-2",
      localManifest: { "caplets/a.md": "v3-offline-a" },
    }),
  );
  apply(reconcileSession(state, "transport-2"));
  apply(
    stageAttach(state, {
      clientFingerprint: "client-b",
      projectFingerprint: "project-x",
      attemptId: "attempt-b-1",
    }),
  );
  apply(
    attachWorkspace(state, {
      clientFingerprint: "client-b",
      projectFingerprint: "project-x",
      workspaceId: "ws-1",
      attemptId: "attempt-b-1",
      localManifest: { "caplets/a.md": "v2-divergent-b" },
    }),
  );
  apply(
    transferAuthority(state, {
      clientFingerprint: "client-b",
      projectFingerprint: "project-x",
      workspaceId: "ws-1",
      localManifest: { "caplets/a.md": "v4-explicit-transfer-b" },
    }),
  );
  apply(reconcileSession(state, "transport-4"));
  apply(
    replaceLocalManifest(state, "transport-4", {
      "caplets/a.md": "v5-interrupted-b",
    }),
  );
  apply(reconcileSession(state, "transport-4", { interruptBeforeCommit: true }));
  apply(retryRecovery(state, "transport-4"));
}

if (process.argv.includes("--demo")) {
  runDemo();
} else {
  console.log("PROTOTYPE: cloud Project Binding state model. Run help for commands.");
  printHelp();
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (runCommand(await terminal.question("binding> "))) {
      // Keep accepting commands until the operator exits.
    }
  } finally {
    terminal.close();
  }
}
