using System.Buffers;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const int ProtocolVersion = 1;

    public static async Task<int> Main(string[] args)
    {
        if (args.Length != 1 || args[0] != "--stdio" || !OperatingSystem.IsWindows()) return 2;
        Lease? lease = null;
        HeldPathChain? securePath = null;
        try
        {
            string? line;
            while ((line = await Console.In.ReadLineAsync()) is not null)
            {
                string? id = null;
                try
                {
                    using var document = JsonDocument.Parse(line, new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = 16,
                    });
                    var root = document.RootElement;
                    id = RequiredString(root, "id");
                    if (RequiredInt(root, "version") != ProtocolVersion) throw new RefusalException();
                    var action = RequiredString(root, "action");
                    var payload = root.GetProperty("payload");
                    object result = action switch
                    {
                        "acquire" when lease is null && securePath is null => (lease = Lease.Acquire(payload)).Describe(),
                        "resume" when lease is null && securePath is null => (lease = Lease.Resume(payload)).Describe(),
                        "verify" when lease is not null && securePath is null => lease.Verify(),
                        "rollback" when lease is not null && securePath is null => Rollback(ref lease),
                        "complete" when lease is not null && securePath is null => Complete(ref lease, payload),
                        "current-sid" when lease is null && securePath is null => SecureFilesystem.CurrentSid(),
                        "verify-dacl" when lease is null && securePath is null => SecureFilesystem.VerifyDacl(payload),
                        "create-directory" when lease is null && securePath is null => SecureFilesystem.CreateDirectory(payload),
                        "hold-path" when lease is null && securePath is null => (securePath = SecureFilesystem.HoldPath(payload)).Describe(),
                        "release-path" when lease is null && securePath is not null => ReleaseSecurePath(ref securePath),
                        _ => throw new RefusalException(),
                    };
                    await WriteResponse(id, true, result);
                }
                catch (Exception)
                {
                    await WriteResponse(id ?? "invalid", false, new { code = "exclusion_refused" });
                }
            }
            return lease is null && securePath is null ? 0 : 3;
        }
        finally
        {
            lease?.Dispose();
            securePath?.Dispose();
        }
    }

    private static object ReleaseSecurePath(ref HeldPathChain? path)
    {
        path!.VerifyIdentityAndLinkCount();
        path.Dispose();
        path = null;
        return new { state = "released" };
    }

    private static object Rollback(ref Lease? lease)
    {
        lease!.Rollback();
        lease.Dispose();
        lease = null;
        return new { state = "rolled-back" };
    }

    private static object Complete(ref Lease? lease, JsonElement payload)
    {
        if (!payload.TryGetProperty("protectedRecoveryDurable", out var durable) || durable.ValueKind != JsonValueKind.True)
            throw new RefusalException();
        lease!.Complete();
        lease.Dispose();
        lease = null;
        return new { state = "activated" };
    }

    private static async Task WriteResponse(string id, bool ok, object result)
    {
        var json = JsonSerializer.Serialize(new { version = ProtocolVersion, id, ok, result });
        await Console.Out.WriteLineAsync(json);
        await Console.Out.FlushAsync();
    }

    internal static string RequiredString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            throw new RefusalException();
        return value.GetString()!;
    }

    internal static int RequiredInt(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || !value.TryGetInt32(out var result))
            throw new RefusalException();
        return result;
    }
}

internal sealed class Lease : IDisposable
{
    private const int MoveFileWriteThrough = 0x00000008;
    private const int MoveFileReplaceExisting = 0x00000001;
    private readonly string _sourceBoundaryPath;
    private readonly string _cleanupId;
    private readonly string _sealedSourcePath;
    private readonly string[] _tombstonePaths;
    private readonly string _journalPath;
    private readonly List<HeldPath> _heldPaths;
    private readonly List<HeldPath> _heldTombstones;
    private readonly MutablePath[] _mutablePaths;
    private readonly string _manifestSha256;
    private readonly int _scannedProcesses;
    private readonly SecurityIdentifier _owner;
    private readonly bool _cleanupPrepared;
    private bool _completed;

    private Lease(
        string cleanupId,
        string sourceBoundaryPath,
        string sealedSourcePath,
        string[] tombstonePaths,
        string journalPath,
        List<HeldPath> heldPaths,
        List<HeldPath> heldTombstones,
        MutablePath[] mutablePaths,
        SecurityIdentifier owner,
        string manifestSha256,
        int scannedProcesses,
        bool cleanupPrepared = false)
    {
        _cleanupId = cleanupId;
        _sourceBoundaryPath = sourceBoundaryPath;
        _sealedSourcePath = sealedSourcePath;
        _tombstonePaths = tombstonePaths;
        _journalPath = journalPath;
        _heldPaths = heldPaths;
        _heldTombstones = heldTombstones;
        _mutablePaths = mutablePaths;
        _manifestSha256 = manifestSha256;
        _owner = owner;
        _scannedProcesses = scannedProcesses;
        _cleanupPrepared = cleanupPrepared;
    }

    internal static Lease Acquire(JsonElement payload)
    {
        var source = Path.GetFullPath(Program.RequiredString(payload, "sourceBoundaryPath"));
        var expectedOwnerSid = Program.RequiredString(payload, "expectedOwnerSid");
        var mode = Program.RequiredString(payload, "mode");
        if (mode != "automatic" && mode != "offline") throw new RefusalException();
        if (!payload.TryGetProperty("allReplicasStopped", out var replicasStopped) ||
            replicasStopped.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            (mode == "offline") != (replicasStopped.ValueKind == JsonValueKind.True))
            throw new RefusalException();
        var currentSid = WindowsIdentity.GetCurrent().User?.Value;
        if (currentSid is null || !StringComparer.Ordinal.Equals(currentSid, expectedOwnerSid))
            throw new RefusalException();
        if (Path.GetPathRoot(source) == source) throw new RefusalException();
        ValidateOwnerPrivate(
            Directory.GetParent(source)?.FullName ?? throw new RefusalException(),
            true,
            new SecurityIdentifier(expectedOwnerSid));
        var journalPath = JournalPath(source);
        ReconcileJournal(source, journalPath);
        if (!Directory.Exists(source)) throw new RefusalException();

        ValidateExpectedServices(payload.GetProperty("expectedServices"));
        var mutable = ParseMutablePaths(payload.GetProperty("mutablePaths"));
        ValidateDedicatedBoundary(source, mutable, new SecurityIdentifier(expectedOwnerSid));
        var paths = EnumerateReviewedPaths(source);
        var firstProcesses = RestartManager.Inspect(paths.Where(path => path.Kind == "file").Select(path => path.AbsolutePath));
        ValidateRestartManagerOwners(firstProcesses, payload.GetProperty("expectedServices"));
        if (firstProcesses.Any(process => process.ProcessId != Environment.ProcessId)) throw new RefusalException();
        var originalIdentities = paths.ToDictionary(
            path => path.RelativePath,
            HeldPath.InspectShared,
            StringComparer.Ordinal);

        var held = new List<HeldPath>();
        string? sealedPath = null;
        var heldTombstones = new List<HeldPath>();
        try
        {
            var secondProcesses = RestartManager.Inspect(paths.Where(path => path.Kind == "file").Select(path => path.AbsolutePath));
            ValidateRestartManagerOwners(secondProcesses, payload.GetProperty("expectedServices"));
            if (secondProcesses.Any(process => process.ProcessId != Environment.ProcessId)) throw new RefusalException();

            var parent = Directory.GetParent(source)?.FullName ?? throw new RefusalException();
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var cleanupId = $"u7-cleanup-{nonce}";
            sealedPath = Path.Combine(parent, $".caplets-sealed-{nonce}");
            var tombstoneStaging = Path.Combine(parent, $".caplets-tombstones-{nonce}");
            WriteJournal(journalPath, new ExclusionJournal(1, "prepared", cleanupId, source, sealedPath, tombstoneStaging, mutable.ToArray(), null));
            MoveDirectoryDurably(source, sealedPath);
            WriteJournal(journalPath, new ExclusionJournal(1, "relocated", cleanupId, source, sealedPath, tombstoneStaging, mutable.ToArray(), null));

            var relocatedPaths = EnumerateReviewedPaths(sealedPath);
            if (paths.Count != relocatedPaths.Count ||
                paths.Zip(relocatedPaths).Any(pair =>
                    pair.First.RelativePath != pair.Second.RelativePath ||
                    pair.First.Kind != pair.Second.Kind))
                throw new RefusalException();
            held = relocatedPaths.Select(path => HeldPath.OpenNoShare(path, originalIdentities[path.RelativePath])).ToList();

            try
            {
                CreateOwnerPrivateDirectory(tombstoneStaging, new SecurityIdentifier(expectedOwnerSid));
                foreach (var item in mutable)
                {
                    var target = Path.Combine(tombstoneStaging, item.RelativePath);
                    if (item.Kind == "file") CreateOwnerPrivateDirectory(target, new SecurityIdentifier(expectedOwnerSid));
                    else CreateDurableTombstoneFile(target, new SecurityIdentifier(expectedOwnerSid));
                }
                MoveDirectoryDurably(tombstoneStaging, source);
            }
            catch
            {
                if (Directory.Exists(tombstoneStaging)) Directory.Delete(tombstoneStaging, true);
                throw;
            }
            WriteJournal(journalPath, new ExclusionJournal(1, "tombstones-published", cleanupId, source, sealedPath, tombstoneStaging, mutable.ToArray(), null));
            var tombstoneReviewedPaths = EnumerateReviewedPaths(source);
            ValidateTombstoneShape(tombstoneReviewedPaths, mutable);
            var tombstoneIdentities = tombstoneReviewedPaths.ToDictionary(
                path => path.RelativePath,
                HeldPath.InspectShared,
                StringComparer.Ordinal);
            heldTombstones = tombstoneReviewedPaths
                .Select(path => HeldPath.OpenNoShare(path, tombstoneIdentities[path.RelativePath]))
                .ToList();

            var manifest = ManifestHash(held);
            WriteJournal(journalPath, new ExclusionJournal(1, "exclusion-durable", cleanupId, source, sealedPath, tombstoneStaging, mutable.ToArray(), manifest));
            return new Lease(
                cleanupId,
                source,
                sealedPath,
                mutable.Select(item => Path.Combine(source, item.RelativePath)).ToArray(),
                journalPath,
                held,
                heldTombstones,
                mutable.ToArray(),
                new SecurityIdentifier(expectedOwnerSid),
                manifest,
                secondProcesses.Count);
        }
        catch
        {
            foreach (var item in held) item.Dispose();
            foreach (var item in heldTombstones) item.Dispose();
            if (sealedPath is not null && Directory.Exists(sealedPath))
                RestoreBoundary(source, sealedPath);
            DeleteJournal(journalPath);
            throw;
        }
    }

    internal static Lease Resume(JsonElement payload)
    {
        var source = Path.GetFullPath(Program.RequiredString(payload, "sourceBoundaryPath"));
        var cleanupId = Program.RequiredString(payload, "cleanupId");
        var expectedOwnerSid = Program.RequiredString(payload, "expectedOwnerSid");
        var mode = Program.RequiredString(payload, "mode");
        if (mode != "automatic" && mode != "offline") throw new RefusalException();
        if (!payload.TryGetProperty("allReplicasStopped", out var replicasStopped) ||
            replicasStopped.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            (mode == "offline") != (replicasStopped.ValueKind == JsonValueKind.True) ||
            !Regex.IsMatch(cleanupId, "^u7-cleanup-[a-f0-9]{48}$", RegexOptions.CultureInvariant))
            throw new RefusalException();
        var currentSid = WindowsIdentity.GetCurrent().User?.Value;
        if (currentSid is null || !StringComparer.Ordinal.Equals(currentSid, expectedOwnerSid))
            throw new RefusalException();
        var owner = new SecurityIdentifier(expectedOwnerSid);
        var parent = Directory.GetParent(source)?.FullName ?? throw new RefusalException();
        ValidateOwnerPrivate(parent, true, owner);
        ValidateExpectedServices(payload.GetProperty("expectedServices"));
        var mutable = ParseMutablePaths(payload.GetProperty("mutablePaths")).ToArray();
        var suffix = cleanupId["u7-cleanup-".Length..];
        var expectedSealedPath = Path.Combine(parent, $".caplets-sealed-{suffix}");
        var expectedStagingPath = Path.Combine(parent, $".caplets-tombstones-{suffix}");
        var journalPath = JournalPath(source);
        var tombstonePaths = mutable.Select(item => Path.Combine(source, item.RelativePath)).ToArray();

        if (!File.Exists(journalPath))
        {
            if (Directory.Exists(expectedSealedPath)) throw new RefusalException();
            ValidateResumedTombstones(source, mutable, owner);
            return new Lease(
                cleanupId,
                source,
                expectedSealedPath,
                tombstonePaths,
                journalPath,
                new List<HeldPath>(),
                new List<HeldPath>(),
                mutable,
                owner,
                new string('0', 64),
                0,
                cleanupPrepared: true);
        }

        ExclusionJournal journal;
        try
        {
            journal = JsonSerializer.Deserialize<ExclusionJournal>(File.ReadAllText(journalPath))
                ?? throw new RefusalException();
        }
        catch
        {
            throw new RefusalException();
        }
        if (
            journal.Version != 1 ||
            journal.CleanupId != cleanupId ||
            journal.SourceBoundaryPath != source ||
            journal.SealedSourcePath != expectedSealedPath ||
            (journal.TombstoneStagingPath.Length > 0 &&
             journal.TombstoneStagingPath != expectedStagingPath) ||
            journal.MutablePaths.Length != mutable.Length ||
            journal.MutablePaths.Zip(mutable).Any(pair =>
                pair.First.RelativePath != pair.Second.RelativePath ||
                pair.First.Kind != pair.Second.Kind))
            throw new RefusalException();

        ValidateResumedTombstones(source, mutable, owner);
        if (journal.Phase == "activation-cleanup")
        {
            if (Directory.Exists(expectedSealedPath)) Directory.Delete(expectedSealedPath, true);
            DeleteJournal(journalPath);
            return new Lease(
                cleanupId,
                source,
                expectedSealedPath,
                tombstonePaths,
                journalPath,
                new List<HeldPath>(),
                new List<HeldPath>(),
                mutable,
                owner,
                ValidManifestOrZero(journal.ManifestSha256),
                0,
                cleanupPrepared: true);
        }
        if (
            journal.Phase != "exclusion-durable" ||
            journal.ManifestSha256 is null ||
            !Regex.IsMatch(journal.ManifestSha256, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant) ||
            !Directory.Exists(expectedSealedPath))
            throw new RefusalException();

        var reviewed = EnumerateReviewedPaths(expectedSealedPath);
        foreach (var path in reviewed) ValidateOwnerPrivate(path.AbsolutePath, path.Kind == "directory", owner);
        var firstProcesses = RestartManager.Inspect(
            reviewed.Where(path => path.Kind == "file").Select(path => path.AbsolutePath));
        ValidateRestartManagerOwners(firstProcesses, payload.GetProperty("expectedServices"));
        if (firstProcesses.Any(process => process.ProcessId != Environment.ProcessId))
            throw new RefusalException();
        var identities = reviewed.ToDictionary(
            path => path.RelativePath,
            HeldPath.InspectShared,
            StringComparer.Ordinal);
        var held = new List<HeldPath>();
        var heldTombstones = new List<HeldPath>();
        try
        {
            held = reviewed.Select(path => HeldPath.OpenNoShare(path, identities[path.RelativePath])).ToList();
            var tombstones = EnumerateReviewedPaths(source);
            var tombstoneIdentities = tombstones.ToDictionary(
                path => path.RelativePath,
                HeldPath.InspectShared,
                StringComparer.Ordinal);
            heldTombstones = tombstones
                .Select(path => HeldPath.OpenNoShare(path, tombstoneIdentities[path.RelativePath]))
                .ToList();
            var finalProcesses = RestartManager.Inspect(
                held.Where(path => path.Kind == "file").Select(path => path.AbsolutePath));
            ValidateRestartManagerOwners(finalProcesses, payload.GetProperty("expectedServices"));
            if (finalProcesses.Any(process => process.ProcessId != Environment.ProcessId))
                throw new RefusalException();
            var manifest = ManifestHash(held);
            if (!CryptographicOperations.FixedTimeEquals(
                    Convert.FromHexString(manifest),
                    Convert.FromHexString(journal.ManifestSha256)))
                throw new RefusalException();
            return new Lease(
                cleanupId,
                source,
                expectedSealedPath,
                tombstonePaths,
                journalPath,
                held,
                heldTombstones,
                mutable,
                owner,
                manifest,
                finalProcesses.Count);
        }
        catch
        {
            foreach (var path in held) path.Dispose();
            foreach (var path in heldTombstones) path.Dispose();
            throw;
        }
    }

    private static void ValidateResumedTombstones(
        string source,
        IReadOnlyCollection<MutablePath> mutable,
        SecurityIdentifier owner)
    {
        var paths = EnumerateReviewedPaths(source);
        ValidateTombstoneShape(paths, mutable);
        foreach (var path in paths) ValidateOwnerPrivate(path.AbsolutePath, path.Kind == "directory", owner);
    }

    private static string ValidManifestOrZero(string? manifest)
    {
        return manifest is not null &&
               Regex.IsMatch(manifest, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)
            ? manifest
            : new string('0', 64);
    }

    private static void RestoreBoundary(string source, string sealedPath)
    {
        var parent = Directory.GetParent(source)?.FullName ?? throw new RefusalException();
        string? stash = null;
        if (Directory.Exists(source))
        {
            stash = Path.Combine(parent, $".caplets-rollback-tombstones-{Guid.NewGuid():N}");
            MoveDirectoryDurably(source, stash);
        }
        try
        {
            MoveDirectoryDurably(sealedPath, source);
        }
        catch
        {
            if (stash is not null && Directory.Exists(stash)) MoveDirectoryDurably(stash, source);
            throw;
        }
        if (stash is not null) Directory.Delete(stash, true);
    }


    internal object Describe() => new
    {
        cleanupId = _cleanupId,
        sealedSourcePath = _sealedSourcePath,
        tombstonePaths = _tombstonePaths,
        manifestSha256 = _manifestSha256,
        identities = _heldPaths.Select(path => new
        {
            relativePath = path.RelativePath,
            kind = path.Kind,
            device = path.Device,
            inode = path.Inode,
        }),
        scannedProcesses = _scannedProcesses,
    };

    internal object Verify()
    {
        if (_completed) throw new RefusalException();
        if (_cleanupPrepared) return new { manifestSha256 = _manifestSha256 };
        var processes = RestartManager.Inspect(_heldPaths.Where(path => path.Kind == "file").Select(path => path.AbsolutePath));
        if (processes.Any(process => process.ProcessId != Environment.ProcessId)) throw new RefusalException();
        foreach (var path in _heldPaths) path.VerifyIdentityAndLinkCount();
        foreach (var path in _heldTombstones) path.VerifyIdentityAndLinkCount();
        foreach (var path in _heldPaths)
            ValidateOwnerPrivate(path.AbsolutePath, path.Kind == "directory", _owner);
        foreach (var path in _heldTombstones)
            ValidateOwnerPrivate(path.AbsolutePath, path.Kind == "directory", _owner);
        var manifest = ManifestHash(_heldPaths);
        if (!CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(manifest),
                Convert.FromHexString(_manifestSha256)))
            throw new RefusalException();
        return new { manifestSha256 = manifest };
    }

    internal void Rollback()
    {
        if (_completed) return;
        if (_cleanupPrepared) throw new RefusalException();
        Verify();
        foreach (var path in _heldTombstones) path.Dispose();
        foreach (var path in _heldPaths) path.Dispose();
        RestoreBoundary(_sourceBoundaryPath, _sealedSourcePath);
        DeleteJournal(_journalPath);
        _completed = true;
    }

    internal void Complete()
    {
        if (_completed) throw new RefusalException();
        Verify();
        if (_cleanupPrepared)
        {
            DeleteJournal(_journalPath);
            _completed = true;
            return;
        }
        WriteJournal(
            _journalPath,
            new ExclusionJournal(1, "activation-cleanup", _cleanupId, _sourceBoundaryPath, _sealedSourcePath, "", _mutablePaths, _manifestSha256));
        foreach (var path in _heldTombstones) path.Dispose();
        foreach (var path in _heldPaths) path.Dispose();
        if (Directory.Exists(_sealedSourcePath)) Directory.Delete(_sealedSourcePath, true);
        DeleteJournal(_journalPath);
        _completed = true;
    }

    public void Dispose()
    {
        foreach (var path in _heldPaths) path.Dispose();
        foreach (var path in _heldTombstones) path.Dispose();
    }

    private static string JournalPath(string source)
    {
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source))).ToLowerInvariant();
        var parent = Directory.GetParent(source)?.FullName ?? throw new RefusalException();
        return Path.Combine(parent, $".caplets-exclusion-{digest[..32]}.journal");
    }

    private static void ReconcileJournal(string source, string journalPath)
    {
        if (!File.Exists(journalPath)) return;
        ExclusionJournal journal;
        try
        {
            journal = JsonSerializer.Deserialize<ExclusionJournal>(File.ReadAllText(journalPath))
                ?? throw new RefusalException();
        }
        catch
        {
            throw new RefusalException();
        }
        var parent = Directory.GetParent(source)?.FullName ?? throw new RefusalException();
        var sealedName = Path.GetFileName(journal.SealedSourcePath);
        var stagingName = Path.GetFileName(journal.TombstoneStagingPath);
        if (
            journal.Version != 1 ||
            !Regex.IsMatch(journal.CleanupId, "^u7-cleanup-[a-f0-9]{48}$", RegexOptions.CultureInvariant) ||
            journal.SourceBoundaryPath != source ||
            Directory.GetParent(journal.SealedSourcePath)?.FullName != parent ||
            !sealedName.StartsWith(".caplets-sealed-", StringComparison.Ordinal) ||
            sealedName.Length != ".caplets-sealed-".Length + 48 ||
            (journal.TombstoneStagingPath.Length > 0 &&
                (Directory.GetParent(journal.TombstoneStagingPath)?.FullName != parent ||
                 !stagingName.StartsWith(".caplets-tombstones-", StringComparison.Ordinal) ||
                 stagingName.Length != ".caplets-tombstones-".Length + 48)))
            throw new RefusalException();

        if (journal.Phase == "activation-cleanup")
        {
            ValidateTombstoneShape(EnumerateReviewedPaths(source), journal.MutablePaths);
            if (Directory.Exists(journal.SealedSourcePath)) Directory.Delete(journal.SealedSourcePath, true);
            DeleteJournal(journalPath);
            throw new RefusalException();
        }
        if (journal.Phase is not ("prepared" or "relocated" or "tombstones-published" or "exclusion-durable"))
            throw new RefusalException();
        if (Directory.Exists(journal.SealedSourcePath))
            RestoreBoundary(source, journal.SealedSourcePath);
        else if (!Directory.Exists(source) || journal.Phase != "prepared")
            throw new RefusalException();
        if (journal.TombstoneStagingPath.Length > 0 && Directory.Exists(journal.TombstoneStagingPath))
            Directory.Delete(journal.TombstoneStagingPath, true);
        DeleteJournal(journalPath);
    }

    private static void WriteJournal(string journalPath, ExclusionJournal journal)
    {
        var temporaryPath = $"{journalPath}.{Guid.NewGuid():N}.tmp";
        var bytes = JsonSerializer.SerializeToUtf8Bytes(journal);
        using (var stream = new FileStream(
            temporaryPath,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.WriteThrough))
        {
            stream.Write(bytes);
            stream.Flush(true);
        }
        if (!MoveFileExW(temporaryPath, journalPath, MoveFileWriteThrough | MoveFileReplaceExisting))
        {
            File.Delete(temporaryPath);
            throw new RefusalException();
        }
    }

    private static void DeleteJournal(string journalPath)
    {
        if (!File.Exists(journalPath)) return;
        var completedPath = $"{journalPath}.{Guid.NewGuid():N}.complete";
        if (!MoveFileExW(journalPath, completedPath, MoveFileWriteThrough))
            throw new RefusalException();
        File.Delete(completedPath);
    }

    private sealed record ExclusionJournal(
        int Version,
        string Phase,
        string CleanupId,
        string SourceBoundaryPath,
        string SealedSourcePath,
        string TombstoneStagingPath,
        MutablePath[] MutablePaths,
        string? ManifestSha256);

    private static void MoveDirectoryDurably(string source, string target)
    {
        if (!MoveFileExW(source, target, MoveFileWriteThrough)) throw new RefusalException();
    }

    private static void CreateDurableTombstoneFile(string path, SecurityIdentifier owner)
    {
        File.WriteAllText(path, "caplets legacy migration tombstone\n", new UTF8Encoding(false));
        var security = new FileSecurity();
        security.SetOwner(owner);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(
            owner,
            FileSystemRights.FullControl,
            AccessControlType.Allow));
        FileSystemAclExtensions.SetAccessControl(new FileInfo(path), security);
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.ReadWrite,
            FileShare.Read,
            4096,
            FileOptions.WriteThrough);
        stream.Flush(true);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(string existingPath, string newPath, int flags);

    private static string ManifestHash(IEnumerable<HeldPath> paths)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var path in paths.OrderBy(path => path.RelativePath, StringComparer.Ordinal))
        {
            var contentHash = path.Kind == "file" ? path.ContentSha256() : "";
            hash.AppendData(Encoding.UTF8.GetBytes(
                $"{path.RelativePath}\0{path.Kind}\0{path.Device}\0{path.Inode}\0{contentHash}\0"));
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static List<MutablePath> ParseMutablePaths(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array) throw new RefusalException();
        var paths = new List<MutablePath>();
        foreach (var element in value.EnumerateArray())
        {
            var relativePath = Program.RequiredString(element, "relativePath");
            var kind = Program.RequiredString(element, "kind");
            if (relativePath != Path.GetFileName(relativePath) || relativePath is "." or ".." ||
                kind is not ("file" or "directory") || paths.Any(path => path.RelativePath == relativePath))
                throw new RefusalException();
            paths.Add(new MutablePath(relativePath, kind));
        }
        if (paths.Count == 0) throw new RefusalException();
        return paths;
    }

    private static void ValidateDedicatedBoundary(string source, IReadOnlyCollection<MutablePath> mutable, SecurityIdentifier owner)
    {
        var entries = Directory.EnumerateFileSystemEntries(source).ToArray();
        if (entries.Length != mutable.Count || entries.Any(entry => !mutable.Any(item => item.RelativePath == Path.GetFileName(entry))))
            throw new RefusalException();
        foreach (var item in mutable)
        {
            var path = Path.Combine(source, item.RelativePath);
            if (item.Kind == "file" ? !File.Exists(path) : !Directory.Exists(path)) throw new RefusalException();
        }
        foreach (var path in EnumerateReviewedPaths(source)) ValidateOwnerPrivate(path.AbsolutePath, path.Kind == "directory", owner);
    }

    private static void ValidateTombstoneShape(
        IReadOnlyCollection<ReviewedPath> paths,
        IReadOnlyCollection<MutablePath> mutable)
    {
        if (paths.Count != mutable.Count + 1) throw new RefusalException();
        foreach (var item in mutable)
        {
            var expectedKind = item.Kind == "file" ? "directory" : "file";
            if (!paths.Any(path => path.RelativePath == item.RelativePath && path.Kind == expectedKind))
                throw new RefusalException();
        }
    }

    private static List<ReviewedPath> EnumerateReviewedPaths(string source)
    {
        var paths = new List<ReviewedPath> { new(source, ".", "directory") };
        var pending = new Stack<string>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(source)) pending.Push(entry);
        while (pending.Count > 0)
        {
            var path = pending.Pop();
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new RefusalException();
            var directory = (attributes & FileAttributes.Directory) != 0;
            paths.Add(new ReviewedPath(path, Path.GetRelativePath(source, path).Replace('\\', '/'), directory ? "directory" : "file"));
            if (directory)
            {
                foreach (var entry in Directory.EnumerateFileSystemEntries(path)) pending.Push(entry);
            }
        }
        return paths.OrderBy(path => path.RelativePath, StringComparer.Ordinal).ToList();
    }

    internal static void ValidateOwnerPrivate(
        string path,
        bool directory,
        SecurityIdentifier owner,
        bool requireProtected = true)
    {
        var attributes = File.GetAttributes(path);
        if (
            (attributes & FileAttributes.ReparsePoint) != 0 ||
            ((attributes & FileAttributes.Directory) != 0) != directory)
            throw new RefusalException();
        FileSystemSecurity security = directory
            ? FileSystemAclExtensions.GetAccessControl(new DirectoryInfo(path), AccessControlSections.Owner | AccessControlSections.Access)
            : FileSystemAclExtensions.GetAccessControl(new FileInfo(path), AccessControlSections.Owner | AccessControlSections.Access);
        if (requireProtected && directory && !security.AreAccessRulesProtected) throw new RefusalException();
        if (!owner.Equals(security.GetOwner(typeof(SecurityIdentifier)))) throw new RefusalException();
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType == AccessControlType.Allow &&
                !owner.Equals(rule.IdentityReference) && !system.Equals(rule.IdentityReference) && !administrators.Equals(rule.IdentityReference))
                throw new RefusalException();
        }
    }

    internal static void CreateOwnerPrivateDirectory(string path, SecurityIdentifier owner)
    {
        Directory.CreateDirectory(path);
        var security = new DirectorySecurity();
        security.SetOwner(owner);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(
            owner,
            FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        FileSystemAclExtensions.SetAccessControl(new DirectoryInfo(path), security);
    }

    private static void ValidateExpectedServices(JsonElement services)
    {
        if (services.ValueKind != JsonValueKind.Array) throw new RefusalException();
        foreach (var service in services.EnumerateArray())
        {
            var name = Program.RequiredString(service, "name");
            var sid = Program.RequiredString(service, "sid");
            if (!StringComparer.Ordinal.Equals(ServiceOwner.LookupSid(name), sid) ||
                !ServiceOwner.IsStopped(name))
                throw new RefusalException();
        }
    }

    private static void ValidateRestartManagerOwners(IEnumerable<RestartManager.ProcessInfo> processes, JsonElement services)
    {
        var expected = services.EnumerateArray().ToDictionary(
            service => Program.RequiredString(service, "name"),
            service => Program.RequiredString(service, "sid"),
            StringComparer.OrdinalIgnoreCase);
        foreach (var process in processes)
        {
            if (string.IsNullOrEmpty(process.ServiceName)) continue;
            if (!expected.TryGetValue(process.ServiceName, out var sid) ||
                !StringComparer.Ordinal.Equals(ServiceOwner.LookupSid(process.ServiceName), sid))
                throw new RefusalException();
        }
    }

    private sealed record MutablePath(string RelativePath, string Kind);
    internal sealed record ReviewedPath(string AbsolutePath, string RelativePath, string Kind);
}

internal static class SecureFilesystem
{
    internal static object CurrentSid()
    {
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new RefusalException();
        return new { sid };
    }

    internal static object VerifyDacl(JsonElement payload)
    {
        var path = Path.GetFullPath(Program.RequiredString(payload, "path"));
        var expectedSid = Program.RequiredString(payload, "expectedServiceSid");
        var currentSid = WindowsIdentity.GetCurrent().User?.Value;
        if (currentSid is null || !StringComparer.Ordinal.Equals(currentSid, expectedSid))
            throw new RefusalException();
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new RefusalException();
        var directory = (attributes & FileAttributes.Directory) != 0;
        using var held = HeldPathChain.OpenDeleteDenied(path, directory ? "directory" : "file");
        Lease.ValidateOwnerPrivate(path, directory, new SecurityIdentifier(expectedSid));
        held.VerifyIdentityAndLinkCount();
        return new { restricted = true };
    }

    internal static object CreateDirectory(JsonElement payload)
    {
        var path = Path.GetFullPath(Program.RequiredString(payload, "path"));
        var expectedSid = Program.RequiredString(payload, "expectedServiceSid");
        var currentSid = WindowsIdentity.GetCurrent().User?.Value;
        if (currentSid is null || !StringComparer.Ordinal.Equals(currentSid, expectedSid))
            throw new RefusalException();
        var owner = new SecurityIdentifier(expectedSid);
        var parent = Directory.GetParent(path)?.FullName ?? throw new RefusalException();
        using var heldParent = HeldPathChain.OpenDeleteDenied(parent, "directory");
        Lease.ValidateOwnerPrivate(parent, true, owner, requireProtected: false);
        if (Directory.Exists(path))
        {
            Lease.ValidateOwnerPrivate(path, true, owner);
            return new { state = "exists" };
        }
        Lease.CreateOwnerPrivateDirectory(path, owner);
        Lease.ValidateOwnerPrivate(path, true, owner);
        heldParent.VerifyIdentityAndLinkCount();
        return new { state = "created" };
    }

    internal static HeldPathChain HoldPath(JsonElement payload)
    {
        var path = Path.GetFullPath(Program.RequiredString(payload, "path"));
        var kind = Program.RequiredString(payload, "kind");
        var expectedSid = Program.RequiredString(payload, "expectedServiceSid");
        var currentSid = WindowsIdentity.GetCurrent().User?.Value;
        if (currentSid is null || !StringComparer.Ordinal.Equals(currentSid, expectedSid))
            throw new RefusalException();
        if (kind is not ("file" or "directory")) throw new RefusalException();
        var held = HeldPathChain.OpenDeleteDenied(path, kind);
        try
        {
            Lease.ValidateOwnerPrivate(path, kind == "directory", new SecurityIdentifier(expectedSid));
            return held;
        }
        catch
        {
            held.Dispose();
            throw;
        }
    }
}

internal sealed class HeldPathChain : IDisposable
{
    private readonly List<HeldPath> _paths;

    private HeldPathChain(List<HeldPath> paths)
    {
        _paths = paths;
    }

    internal static HeldPathChain OpenDeleteDenied(string path, string finalKind)
    {
        var absolutePath = Path.GetFullPath(path);
        var root = Path.GetPathRoot(absolutePath) ?? throw new RefusalException();
        var relative = Path.GetRelativePath(root, absolutePath);
        var components = relative == "."
            ? Array.Empty<string>()
            : relative.Split(
                new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                StringSplitOptions.RemoveEmptyEntries);
        var held = new List<HeldPath>();
        try
        {
            if (components.Length == 0)
            {
                held.Add(HeldPath.OpenDeleteDenied(root, finalKind));
            }
            else
            {
                var current = root;
                for (var index = 0; index < components.Length; index += 1)
                {
                    current = Path.Combine(current, components[index]);
                    held.Add(HeldPath.OpenDeleteDenied(
                        current,
                        index == components.Length - 1 ? finalKind : "directory"));
                }
            }
            return new HeldPathChain(held);
        }
        catch
        {
            foreach (var entry in held.AsEnumerable().Reverse()) entry.Dispose();
            throw;
        }
    }

    internal object Describe() => _paths[^1].Describe();

    internal void VerifyIdentityAndLinkCount()
    {
        foreach (var path in _paths) path.VerifyIdentityAndLinkCount();
    }

    public void Dispose()
    {
        foreach (var path in _paths.AsEnumerable().Reverse()) path.Dispose();
    }
}

internal sealed class HeldPath : IDisposable
{
    private const uint GenericRead = 0x80000000;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private readonly SafeFileHandle _handle;

    internal string AbsolutePath { get; }
    internal string RelativePath { get; }
    internal string Kind { get; }
    internal string Device { get; }
    internal string Inode { get; }
    internal uint LinkCount { get; }

    private HeldPath(SafeFileHandle handle, string absolutePath, string relativePath, string kind, string device, string inode, uint linkCount)
    {
        _handle = handle;
        AbsolutePath = absolutePath;
        RelativePath = relativePath;
        Kind = kind;
        Device = device;
        Inode = inode;
        LinkCount = linkCount;
    }

    internal sealed record PathIdentity(string Device, string Inode, uint LinkCount);

    internal static PathIdentity InspectShared(Lease.ReviewedPath path)
    {
        var flags = FileFlagOpenReparsePoint | (path.Kind == "directory" ? FileFlagBackupSemantics : 0u);
        using var handle = CreateFileW(
            path.AbsolutePath,
            GenericRead,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            flags,
            IntPtr.Zero);
        if (handle.IsInvalid) throw new RefusalException();
        ValidateHandleKind(handle, path.Kind);
        return Identity(handle);
    }

    internal static HeldPath OpenNoShare(Lease.ReviewedPath path, PathIdentity expected)
    {
        var flags = FileFlagOpenReparsePoint | (path.Kind == "directory" ? FileFlagBackupSemantics : 0u);
        var handle = CreateFileW(path.AbsolutePath, GenericRead, 0, IntPtr.Zero, OpenExisting, flags, IntPtr.Zero);
        if (handle.IsInvalid) throw new RefusalException();
        ValidateHandleKind(handle, path.Kind);
        var identity = Identity(handle);
        if (
            identity.Device != expected.Device ||
            identity.Inode != expected.Inode ||
            identity.LinkCount != expected.LinkCount ||
            (path.Kind == "file" && identity.LinkCount != 1))
        {
            handle.Dispose();
            throw new RefusalException();
        }
        return new HeldPath(
            handle,
            path.AbsolutePath,
            path.RelativePath,
            path.Kind,
            identity.Device,
            identity.Inode,
            identity.LinkCount);
    }

    internal static HeldPath OpenDeleteDenied(string absolutePath, string kind)
    {
        var attributes = File.GetAttributes(absolutePath);
        if ((attributes & FileAttributes.ReparsePoint) != 0 ||
            ((attributes & FileAttributes.Directory) != 0) != (kind == "directory"))
            throw new RefusalException();
        var path = new Lease.ReviewedPath(absolutePath, ".", kind);
        var expected = InspectShared(path);
        var flags = FileFlagOpenReparsePoint | (kind == "directory" ? FileFlagBackupSemantics : 0u);
        var handle = CreateFileW(
            absolutePath,
            GenericRead,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            flags,
            IntPtr.Zero);
        if (handle.IsInvalid) throw new RefusalException();
        ValidateHandleKind(handle, kind);
        var identity = Identity(handle);
        if (
            identity.Device != expected.Device ||
            identity.Inode != expected.Inode ||
            identity.LinkCount != expected.LinkCount ||
            (kind == "file" && identity.LinkCount != 1))
        {
            handle.Dispose();
            throw new RefusalException();
        }
        return new HeldPath(
            handle,
            absolutePath,
            ".",
            kind,
            identity.Device,
            identity.Inode,
            identity.LinkCount);
    }

    internal object Describe() => new
    {
        path = AbsolutePath,
        kind = Kind,
        device = Device,
        inode = Inode,
        linkCount = LinkCount,
    };

    internal void VerifyIdentityAndLinkCount()
    {
        var identity = Identity(_handle);
        if (identity.Device != Device || identity.Inode != Inode || identity.LinkCount != LinkCount)
            throw new RefusalException();
    }

    internal string ContentSha256()
    {
        if (Kind != "file") return "";
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(128 * 1024);
        try
        {
            long offset = 0;
            while (true)
            {
                var read = RandomAccess.Read(_handle, buffer, offset);
                if (read == 0) break;
                hash.AppendData(buffer.AsSpan(0, read));
                offset += read;
            }
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer);
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    public void Dispose() => _handle.Dispose();

    private static void ValidateHandleKind(SafeFileHandle handle, string kind)
    {
        if (!GetFileInformationByHandle(handle, out var info))
        {
            handle.Dispose();
            throw new RefusalException();
        }
        var attributes = (FileAttributes)info.FileAttributes;
        if (
            (attributes & FileAttributes.ReparsePoint) != 0 ||
            ((attributes & FileAttributes.Directory) != 0) != (kind == "directory"))
        {
            handle.Dispose();
            throw new RefusalException();
        }
    }

    private static PathIdentity Identity(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var info)) throw new RefusalException();
        return new PathIdentity(
            info.VolumeSerialNumber.ToString(),
            $"{info.FileIndexHigh:x8}{info.FileIndexLow:x8}",
            info.NumberOfLinks);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation information);

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }
}

internal static class RestartManager
{
    private const int ErrorMoreData = 234;

    internal sealed record ProcessInfo(int ProcessId, string ServiceName);

    internal static List<ProcessInfo> Inspect(IEnumerable<string> resources)
    {
        var files = resources.ToArray();
        if (files.Length == 0) return new List<ProcessInfo>();
        var key = Guid.NewGuid().ToString("N");
        var result = RmStartSession(out var session, 0, key);
        if (result != 0) throw new RefusalException();
        try
        {
            // Restart Manager accepts regular-file resources; directory exclusion is held below.
            result = RmRegisterResources(session, (uint)files.Length, files, 0, null, 0, null);
            if (result != 0) throw new RefusalException();
            uint needed = 0;
            uint count = 0;
            uint reasons = 0;
            result = RmGetList(session, out needed, ref count, null, ref reasons);
            if (result == 0) return new List<ProcessInfo>();
            if (result != ErrorMoreData || needed == 0) throw new RefusalException();
            var native = new NativeProcessInfo[needed];
            count = needed;
            result = RmGetList(session, out needed, ref count, native, ref reasons);
            if (result != 0) throw new RefusalException();
            return native.Take((int)count)
                .Select(info => new ProcessInfo(info.Process.ProcessId, info.ServiceShortName ?? ""))
                .ToList();
        }
        finally
        {
            RmEndSession(session);
        }
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint sessionHandle, int sessionFlags, string sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(
        uint sessionHandle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        UniqueProcess[]? applications,
        uint serviceCount,
        string[]? serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(
        uint sessionHandle,
        out uint processInfoNeeded,
        ref uint processInfo,
        [In, Out] NativeProcessInfo[]? affectedApplications,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint sessionHandle);

    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess
    {
        internal int ProcessId;
        internal System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    private enum ApplicationType
    {
        Unknown = 0,
        MainWindow = 1,
        OtherWindow = 2,
        Service = 3,
        Explorer = 4,
        Console = 5,
        Critical = 1000,
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeProcessInfo
    {
        internal UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] internal string ApplicationName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] internal string ServiceShortName;
        internal ApplicationType ApplicationType;
        internal uint ApplicationStatus;
        internal uint TerminalSessionId;
        [MarshalAs(UnmanagedType.Bool)] internal bool Restartable;
    }
}

internal static class ServiceOwner
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryConfig = 0x0001;
    private const uint ServiceQueryStatus = 0x0004;
    private const uint ServiceStopped = 0x00000001;

    internal static string LookupSid(string serviceName)
    {
        var manager = OpenSCManagerW(null, null, ScManagerConnect);
        if (manager == IntPtr.Zero) throw new RefusalException();
        try
        {
            var service = OpenServiceW(manager, serviceName, ServiceQueryConfig);
            if (service == IntPtr.Zero) throw new RefusalException();
            try
            {
                QueryServiceConfigW(service, IntPtr.Zero, 0, out var needed);
                if (needed == 0) throw new RefusalException();
                var buffer = Marshal.AllocHGlobal((int)needed);
                try
                {
                    if (!QueryServiceConfigW(service, buffer, needed, out _)) throw new RefusalException();
                    var config = Marshal.PtrToStructure<QueryServiceConfig>(buffer);
                    var account = Marshal.PtrToStringUni(config.ServiceStartName) ?? throw new RefusalException();
                    return ((SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier))).Value;
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }

    internal static bool IsStopped(string serviceName)
    {
        var manager = OpenSCManagerW(null, null, ScManagerConnect);
        if (manager == IntPtr.Zero) throw new RefusalException();
        try
        {
            var service = OpenServiceW(manager, serviceName, ServiceQueryStatus);
            if (service == IntPtr.Zero) throw new RefusalException();
            try
            {
                var size = (uint)Marshal.SizeOf<ServiceStatusProcess>();
                if (!QueryServiceStatusEx(service, 0, out var status, size, out _))
                    throw new RefusalException();
                return status.CurrentState == ServiceStopped;
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManagerW(string? machineName, string? databaseName, uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenServiceW(IntPtr manager, string serviceName, uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfigW(
        IntPtr service,
        IntPtr queryServiceConfig,
        uint bufferSize,
        out uint bytesNeeded);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(
        IntPtr service,
        int infoLevel,
        out ServiceStatusProcess status,
        uint bufferSize,
        out uint bytesNeeded);

    [DllImport("advapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct QueryServiceConfig
    {
        internal uint ServiceType;
        internal uint StartType;
        internal uint ErrorControl;
        internal IntPtr BinaryPathName;
        internal IntPtr LoadOrderGroup;
        internal uint TagId;
        internal IntPtr Dependencies;
        internal IntPtr ServiceStartName;
        internal IntPtr DisplayName;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        internal uint ServiceType;
        internal uint CurrentState;
        internal uint ControlsAccepted;
        internal uint Win32ExitCode;
        internal uint ServiceSpecificExitCode;
        internal uint CheckPoint;
        internal uint WaitHint;
        internal uint ProcessId;
        internal uint ServiceFlags;
    }

}

internal sealed class RefusalException : Exception { }
