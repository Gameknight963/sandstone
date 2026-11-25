using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Playwright.Xunit.v3;
using Sandstone.BrowserTests.Infrastructure;
using Sandstone.BrowserTests.Workflows;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests;

[Collection(RelayCollection.Name)]
[Trait("Category", "Live")]
public sealed class LiveSiteTests(RelayServer relay, ITestOutputHelper output) : BrowserTest
{
    public sealed record Site(string Id, string Url, bool Editor = false, int Timeout = 25000);
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };
    internal static readonly Site[] Catalog = JsonSerializer.Deserialize<Site[]>(File.ReadAllText(Path.Combine(Root, "test", "Sandstone.BrowserTests", "live-sites.json")), Options)!;
    public static TheoryData<string> Sites
    {
        get
        {
            var selected = Environment.GetEnvironmentVariable("LIVE_SITES")?.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            if (selected != null)
                foreach (var id in selected) if (!Catalog.Any(site => site.Id == id)) throw new ArgumentException("Unknown live site: " + id);
            var data = new TheoryData<string>();
            foreach (var site in Catalog.Where(site => selected == null || selected.Contains(site.Id))) data.Add(site.Id);
            return data;
        }
    }

    [LiveTheory]
    [MemberData(nameof(Sites))]
    public async Task InteractionMatchesNativeBrowser(string id)
    {
        var site = Catalog.Single(site => site.Id == id);
        if (id == "react") site = site with { Timeout = 40000 };
        var report = new JsonObject { ["site"] = id, ["url"] = site.Url, ["engine"] = BrowserName, ["storageDenied"] = DeniedStorage, ["isolated"] = Isolated };
        var nativeUnavailable = false;
        try
        {
            JsonNode nativeInteraction; JsonNode? nativeSummary;
            await using (var native = await BrowserSession.CreateAsync(Browser, false))
            {
                try
                {
                    await native.NavigateAsync(site.Url, site.Timeout);
                    await Task.Delay(1000, TestContext.Current.CancellationToken);
                    output.WriteLine("Native interaction: " + id);
                    nativeInteraction = await new SiteWorkflows(native, relay.Origin).RunAsync(id).WaitAsync(TimeSpan.FromMilliseconds(site.Timeout));
                    nativeSummary = await SummaryAsync(native);
                    report["native"] = new JsonObject { ["document"] = nativeSummary?.DeepClone(), ["interaction"] = nativeInteraction.DeepClone() };
                }
                catch (Exception error) when (error is TimeoutException or HttpRequestException or Xunit.Sdk.XunitException || error is PlaywrightException &&
                    (error.Message.Contains("Timeout") || error.Message.Contains("net::") || error.Message.Contains("NS_ERROR")))
                {
                    nativeUnavailable = true;
                    report["error"] = error.Message;
                    report["nativeDiagnostics"] = Json(native.Diagnostics.ToArray());
                    Assert.Skip("Native baseline unavailable: " + error.Message);
                    throw;
                }
            }
            var artifact = Isolated ? relay.Origin + "/host" : Artifact;
            await using var proxy = await BrowserSession.CreateAsync(Browser, true, relay.Relay, DeniedStorage, artifact);
            try
            {
                await proxy.NavigateAsync(site.Url, site.Timeout);
                await Task.Delay(1000, TestContext.Current.CancellationToken);
                output.WriteLine("Proxied interaction: " + id);
                var actual = await new SiteWorkflows(proxy, relay.Origin).RunAsync(id).WaitAsync(TimeSpan.FromMilliseconds(site.Timeout));
                var summary = await SummaryAsync(proxy);
                report["proxy"] = new JsonObject { ["document"] = summary?.DeepClone(), ["interaction"] = actual.DeepClone() };
                Assert.Equal(nativeSummary!["title"]!.GetValue<string>(), summary!["title"]!.GetValue<string>());
                if (!site.Editor) Assert.True(summary["links"]!.GetValue<int>() > 0, "No proxied links rendered.");
                EqualJson(nativeInteraction, actual);
                Assert.Empty(proxy.DirectHttp); Assert.Empty(proxy.Errors);
                report["status"] = proxy.Diagnostics.IsEmpty ? "passed" : "passed-with-diagnostics";
            }
            finally
            {
                report["scriptErrors"] = Json(proxy.Errors.ToArray());
                report["consoleDiagnostics"] = Json(proxy.Diagnostics.ToArray());
                report["directHTTP"] = Json(proxy.DirectHttp.ToArray());
                try { report["requests"] = await proxy.Page.EvaluateJsonAsync("() => workflowRequests.slice(-30)").WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
            }
        }
        catch (Exception error)
        {
            report["status"] = nativeUnavailable ? "baseline-unavailable" : "failed";
            report["error"] ??= error.Message;
            throw;
        }
        finally
        {
            var directory = Path.Combine(Root, ".temp", "browser-results", BrowserName, Isolated ? "isolated" : "file", DeniedStorage ? "denied" : "normal");
            Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(Path.Combine(directory, id + ".json"), report.ToJsonString(new() { WriteIndented = true }));
            output.WriteLine(report.ToJsonString());
        }
    }
    private static Task<JsonNode?> SummaryAsync(BrowserSession session) => session.ReadAsync("({title:document.title,heading:document.querySelector('h1')?.textContent.trim()||'',links:document.links.length})");
}
