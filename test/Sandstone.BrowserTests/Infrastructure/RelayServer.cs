using System.Diagnostics;
using System.Text.Json;

namespace Sandstone.BrowserTests.Infrastructure;

[CollectionDefinition(Name)]
public sealed class RelayCollection : ICollectionFixture<RelayServer>
{
    public const string Name = "Local Wisp relay";
}

public sealed class RelayServer : IAsyncLifetime
{
    private Process? process;
    public string Origin { get; private set; } = "";
    public string Relay { get; private set; } = "";
    public async ValueTask InitializeAsync()
    {
        if (!Repository.LiveEnabled) return;
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = Repository.Root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.ArgumentList.Add(Path.Combine(Repository.Root, "test", "browser-services.mjs"));
        process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the test relay.");
        process.ErrorDataReceived += (_, _) => { }; // Drain stderr so a verbose relay cannot block.
        process.BeginErrorReadLine();
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            while (await process.StandardOutput.ReadLineAsync(timeout.Token) is { } line)
            {
                if (!line.StartsWith('{')) continue;
                using var ready = JsonDocument.Parse(line);
                if (!ready.RootElement.TryGetProperty("relay", out var relay)) continue;
                Relay = relay.GetString()!; Origin = ready.RootElement.GetProperty("origin").GetString()!;
                _ = process.StandardOutput.ReadToEndAsync();
                return;
            }
            throw new InvalidOperationException("The relay exited before reporting its address.");
        }
        catch { await DisposeAsync(); throw; }
    }
    public async ValueTask DisposeAsync()
    {
        if (process == null) return;
        if (!process.HasExited)
        {
            process.StandardInput.Close();
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (TimeoutException) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
        }
        process.Dispose(); process = null;
    }
}
