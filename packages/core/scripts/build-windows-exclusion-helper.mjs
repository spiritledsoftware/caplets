import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(SCRIPT_DIR, "..");
const SOURCE_ROOT = join(CORE_ROOT, "native", "windows-exclusion-helper");
const DEFAULT_ARTIFACT_ROOT = join(SOURCE_ROOT, "artifacts");
const DEFAULT_DIST_ROOT = join(CORE_ROOT, "dist", "native", "windows-exclusion-helper");
const ARCHITECTURES = [
  {
    id: "win32-x64",
    runtime: "win-x64",
    executable: "caplets-windows-exclusion-helper-win32-x64.exe",
  },
];
const TEST_PUBLISHER = "CN=Caplets Exclusion Test Publisher";

const options = parseArgs(process.argv.slice(2));
const action = options.action ?? "build";
try {
  if (action === "build") build(options);
  else if (action === "verify-publish") verifyPublish(options, false);
  else if (action === "verify-fixture") verifyPublish(options, true);
  else if (action === "verify-artifact") {
    verifyArtifactSet({
      artifactRoot: artifactRootFor(options),
      expectedPublisher: required(
        options.publisher ?? process.env.CAPLETS_WINDOWS_HELPER_PUBLISHER,
        "publisher",
      ),
      signatureInspector: undefined,
    });
  } else if (action === "copy-packaged") copyPackaged(options);
  else throw new Error("Unknown Windows exclusion helper build action.");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Windows exclusion helper gate failed."}\n`,
  );
  process.exitCode = 1;
}

function build(options) {
  if (process.platform !== "win32")
    throw new Error("Windows helper builds require a Windows runner.");
  const artifactRoot = artifactRootFor(options);
  const publisher = required(
    options.publisher ?? process.env.CAPLETS_WINDOWS_HELPER_PUBLISHER,
    "publisher",
  );
  const certificateThumbprint = required(
    options.certificateThumbprint ?? process.env.CAPLETS_WINDOWS_HELPER_CERT_THUMBPRINT,
    "certificate thumbprint",
  );
  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });
  const architectures = {};
  const signatureEvidence = {};
  for (const architecture of ARCHITECTURES) {
    const publishRoot = join(artifactRoot, `.publish-${architecture.id}`);
    execFileSync(
      "dotnet",
      [
        "publish",
        join(SOURCE_ROOT, "Caplets.WindowsExclusionHelper.csproj"),
        "--configuration",
        "Release",
        "--runtime",
        architecture.runtime,
        "--output",
        publishRoot,
        "--nologo",
      ],
      { stdio: "inherit", windowsHide: true },
    );
    const built = join(publishRoot, "Caplets.WindowsExclusionHelper.exe");
    const target = join(artifactRoot, architecture.executable);
    copyFileSync(built, target);
    signAuthenticode(target, certificateThumbprint);
    const signature = inspectAuthenticode(target);
    const digest = sha256(target);
    if (signature.status !== "Valid" || signature.publisher !== publisher) {
      throw new Error("Built Windows exclusion helper signature or publisher is invalid.");
    }
    architectures[architecture.id] = {
      file: architecture.executable,
      sha256: digest,
      publisher,
    };
    signatureEvidence[architecture.executable] = {
      status: signature.status,
      publisher: signature.publisher,
      sha256: digest,
    };
    rmSync(publishRoot, { recursive: true, force: true });
  }
  writeManifest(join(artifactRoot, "manifest.json"), architectures);
  writeFileSync(
    join(artifactRoot, "signature-evidence.json"),
    `${JSON.stringify(signatureEvidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  verifyArtifactSet({
    artifactRoot,
    expectedPublisher: publisher,
    signatureInspector: inspectAuthenticode,
  });
}

function verifyPublish(options, fixture) {
  const artifactRoot = artifactRootFor(options);
  const expectedPublisher = required(
    options.publisher ?? process.env.CAPLETS_WINDOWS_HELPER_PUBLISHER,
    "publisher",
  );
  let signatureInspector = inspectAuthenticode;
  const fixtureMode = fixture || process.env.CAPLETS_WINDOWS_HELPER_TEST_FIXTURE === "1";
  if (fixtureMode) {
    if (expectedPublisher !== TEST_PUBLISHER) throw new Error("Fixture publisher is not allowed.");
    signatureInspector = signatureEvidenceInspector(
      resolve(options.signatureEvidence ?? join(artifactRoot, "signature-evidence.json")),
    );
  } else if (process.platform !== "win32") {
    signatureInspector = signatureEvidenceInspector(join(artifactRoot, "signature-evidence.json"));
  }
  verifyArtifactSet({ artifactRoot, expectedPublisher, signatureInspector });
}

function copyPackaged(options) {
  const artifactRoot = artifactRootFor(options);
  const distRoot = resolve(options.distRoot ?? DEFAULT_DIST_ROOT);
  const requiredForPackage = process.env.CAPLETS_REQUIRE_WINDOWS_EXCLUSION_HELPER === "1";
  if (!existsSync(join(artifactRoot, "manifest.json"))) {
    if (requiredForPackage)
      throw new Error("Packaged Windows exclusion helper is required but absent.");
    return;
  }
  const manifest = verifyArtifactSet({
    artifactRoot,
    expectedPublisher: options.publisher ?? process.env.CAPLETS_WINDOWS_HELPER_PUBLISHER,
    signatureInspector: undefined,
  });
  rmSync(distRoot, { recursive: true, force: true });
  mkdirSync(distRoot, { recursive: true });
  copyFileSync(join(artifactRoot, "manifest.json"), join(distRoot, "manifest.json"));
  for (const architecture of ARCHITECTURES) {
    copyFileSync(
      join(artifactRoot, manifest.architectures[architecture.id].file),
      join(distRoot, manifest.architectures[architecture.id].file),
    );
  }
}

function verifyArtifactSet({ artifactRoot, expectedPublisher, signatureInspector }) {
  const manifestPath = join(artifactRoot, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("Windows exclusion helper manifest is absent.");
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  for (const architecture of ARCHITECTURES) {
    const artifact = manifest.architectures[architecture.id];
    const helperPath = join(artifactRoot, artifact.file);
    if (!existsSync(helperPath)) throw new Error("Windows exclusion helper is absent.");
    if (sha256(helperPath) !== artifact.sha256)
      throw new Error("Windows exclusion helper checksum is invalid.");
    if (expectedPublisher && artifact.publisher !== expectedPublisher) {
      throw new Error("Windows exclusion helper manifest publisher is invalid.");
    }
    if (signatureInspector) {
      const signature = signatureInspector(helperPath);
      if (signature.status !== "Valid")
        throw new Error("Windows exclusion helper is unsigned or invalid.");
      if (
        signature.publisher !== artifact.publisher ||
        (expectedPublisher && signature.publisher !== expectedPublisher)
      ) {
        throw new Error("Windows exclusion helper Authenticode publisher is invalid.");
      }
    }
  }
  return manifest;
}

function parseManifest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("Windows exclusion helper manifest is invalid.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.protocolVersion !== 1 ||
    Object.keys(value).sort().join(",") !== "architectures,protocolVersion,version" ||
    !value.architectures ||
    typeof value.architectures !== "object" ||
    Array.isArray(value.architectures) ||
    Object.keys(value.architectures).join(",") !== "win32-x64"
  ) {
    throw new Error("Windows exclusion helper manifest is invalid.");
  }
  for (const architecture of ARCHITECTURES) {
    const artifact = value.architectures[architecture.id];
    if (
      !artifact ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      Object.keys(artifact).sort().join(",") !== "file,publisher,sha256" ||
      artifact.file !== architecture.executable ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      typeof artifact.publisher !== "string" ||
      artifact.publisher.length === 0
    ) {
      throw new Error("Windows exclusion helper manifest is invalid.");
    }
  }
  return value;
}

function signAuthenticode(path, thumbprint) {
  const script =
    "$cert=Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\'+$args[1]);" +
    "$result=Set-AuthenticodeSignature -LiteralPath $args[0] -Certificate $cert -HashAlgorithm SHA256;" +
    "if($result.Status -ne 'Valid'){throw ('Signing failed: '+$result.Status)}";
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, path, thumbprint],
    {
      stdio: "inherit",
      windowsHide: true,
    },
  );
}

function inspectAuthenticode(path) {
  const script =
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0];" +
    "[Console]::Out.Write(($s | Select-Object @{n='Status';e={$_.Status.ToString()}},@{n='Publisher';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress))";
  const output = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, path],
    { encoding: "utf8", windowsHide: true },
  );
  const value = JSON.parse(output);
  return { status: value.Status, publisher: value.Publisher };
}

function signatureEvidenceInspector(evidencePath) {
  if (!existsSync(evidencePath)) {
    throw new Error("Windows exclusion helper signature evidence is absent.");
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("Windows exclusion helper signature evidence is invalid.");
  }
  return (path) => {
    const record = evidence[basename(path)];
    if (
      !record ||
      typeof record !== "object" ||
      record.sha256 !== sha256(path) ||
      typeof record.status !== "string" ||
      typeof record.publisher !== "string"
    ) {
      return { status: "UnknownError" };
    }
    return { status: record.status, publisher: record.publisher };
  };
}

function writeManifest(path, architectures) {
  const manifest = { version: 1, protocolVersion: 1, architectures };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifactRootFor(options) {
  return resolve(
    options.artifactRoot ??
      process.env.CAPLETS_WINDOWS_HELPER_ARTIFACT_ROOT ??
      DEFAULT_ARTIFACT_ROOT,
  );
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Windows helper ${name} is required.`);
  return value;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--build") parsed.action = "build";
    else if (argument === "--verify-publish") parsed.action = "verify-publish";
    else if (argument === "--verify-fixture") parsed.action = "verify-fixture";
    else if (argument === "--verify-artifact") parsed.action = "verify-artifact";
    else if (argument === "--copy-packaged") parsed.action = "copy-packaged";
    else if (argument === "--artifact-root") parsed.artifactRoot = args[++index];
    else if (argument === "--dist-root") parsed.distRoot = args[++index];
    else if (argument === "--publisher") parsed.publisher = args[++index];
    else if (argument === "--certificate-thumbprint") parsed.certificateThumbprint = args[++index];
    else if (argument === "--signature-evidence") parsed.signatureEvidence = args[++index];
    else throw new Error(`Unknown Windows helper option: ${argument}`);
  }
  return parsed;
}
