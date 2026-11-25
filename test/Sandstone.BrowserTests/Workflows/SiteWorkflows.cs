using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Sandstone.BrowserTests.Infrastructure;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests.Workflows;

internal sealed partial class SiteWorkflows(BrowserSession session, string serviceOrigin)
{
    private IPage Page => session.Page;
    private BrowserSurface Surface => session.Surface;
    private Task Wait(string expression, int timeout = 15000) => session.WaitAsync(expression, timeout);
    private Task<JsonNode?> Read(string expression) => session.ReadAsync(expression);
    private Task<T> Read<T>(string expression) => session.ReadAsync<T>(expression);
    private ILocator Role(AriaRole role, string name) => Surface.GetByRole(role, new() { Name = name, Exact = true });
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static byte[] Bytes(int[] values) => values.Select(value => checked((byte)value)).ToArray();
    private async Task<(string Name, byte[] Bytes)> Download(Func<Task> action)
    {
        var file = await Page.RunAndWaitForDownloadAsync(action);
        Assert.Null(await file.FailureAsync());
        await using var stream = await file.CreateReadStreamAsync(); Assert.NotNull(stream);
        using var bytes = new MemoryStream(); await stream.CopyToAsync(bytes);
        return (file.SuggestedFilename, bytes.ToArray());
    }
    public Task<JsonNode> RunAsync(string id) => id switch
    {
        "discord" => DiscordAsync(), "hls" or "hls-aes" => HlsAsync(id == "hls-aes"),
        "photopea" => PhotopeaAsync(), "geogebra" => GeoGebraAsync(), "desmos" => DesmosAsync(),
        "jspaint" => JsPaintAsync(), "mermaid" => MermaidAsync(), "diagrams" => DiagramsAsync(),
        "excalidraw" => ExcalidrawAsync(), "openstreetmap" => OpenStreetMapAsync(),
        "mastodon" => MastodonAsync(), "react" => ReactAsync(), "angular" => AngularAsync(),
        "svelte" => SvelteAsync(), "vue" => VueAsync(), "github" => GitHubAsync(),
        "hn" => HackerNewsAsync(), "discourse" => DiscourseAsync(), "mdn" => MdnAsync(),
        "wikipedia" => WikipediaAsync(), "wikipedia-search" => WikipediaSearchAsync(),
        "pdfjs" => PdfAsync(), "cyberchef" or "cyberchef-hash" => CyberChefAsync(id == "cyberchef-hash"),
        "xtype" => XtypeAsync(), "swooop" => SwooopAsync(), "scratch" => ScratchAsync(),
        "jspaint-files" => PaintFilesAsync(), "dillinger" => MarkdownAsync(), "jsoncrack" => JsonCrackAsync(),
        "vscode" => VsCodeAsync(), "flems" => FlemsAsync(), "squoosh" => SquooshAsync(), "sqlime" => SqlimeAsync(),
        _ => throw new ArgumentException("Unknown workflow: " + id)
    };
}
