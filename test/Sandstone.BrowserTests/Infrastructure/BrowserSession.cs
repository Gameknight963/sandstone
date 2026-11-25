using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Sandstone.BrowserTests.Infrastructure;

internal sealed class BrowserSession : IAsyncDisposable
{
    public IBrowserContext Context { get; }
    public IPage Page { get; }
    public bool Proxied { get; }
    public BrowserSurface Surface => new(Page, Proxied ? Page.FrameLocator("iframe[frame-id]") : null);
    public ConcurrentQueue<string> Errors { get; } = new();
    public ConcurrentQueue<string> Diagnostics { get; } = new();
    public ConcurrentQueue<string> DirectHttp { get; } = new();
    private readonly ConcurrentDictionary<string, byte> seenErrors = new(), seenDiagnostics = new(), seenDirect = new();
    private BrowserSession(IBrowserContext context, IPage page, bool proxied)
    {
        Context = context; Page = page; Proxied = proxied;
        context.SetDefaultTimeout(15000); context.SetDefaultNavigationTimeout(20000);
        page.PageError += (_, error) => Record(Errors, seenErrors, error.Split('\n', 2)[0]);
        page.Console += (_, message) => { if (message.Type == "error") Record(Diagnostics, seenDiagnostics, message.Text); };
    }
    public static async Task<BrowserSession> CreateAsync(IBrowser browser, bool proxied, string? relay = null,
        bool deniedStorage = false, string? artifact = null)
    {
        var context = await browser.NewContextAsync(new() { AcceptDownloads = true, ViewportSize = new() { Width = 1280, Height = 720 }, DeviceScaleFactor = 1 });
        try
        {
            if (deniedStorage) await context.AddInitScriptAsync("""
                for (const name of ['localStorage','indexedDB','caches'])
                  Object.defineProperty(window,name,{configurable:true,get(){throw new DOMException('Storage denied','SecurityError');}});
                """);
            var page = await context.NewPageAsync();
            var session = new BrowserSession(context, page, proxied);
            if (proxied)
            {
                artifact ??= Repository.Artifact;
                page.Request += (_, request) =>
                {
                    if (IsHttp(request.Url) && request.Url != artifact) Record(session.DirectHttp, session.seenDirect, request.Url);
                };
                await page.RouteAsync("**/*", route => IsHttp(route.Request.Url) && route.Request.Url != artifact
                    ? route.AbortAsync("blockedbyclient") : route.ContinueAsync());
                await page.GotoAsync(artifact);
                await session.ReadyAsync();
                if (relay != null) await page.EvaluateAsync("relay => sandstone.network.set_websocket(relay)", relay);
                await page.EvaluateAsync("""
                    () => {
                      const session=sandstone.network.session,fetch=session.fetch;
                      globalThis.workflowRequests=[];
                      session.fetch=function(url,...args){
                        const row={url:String(url),phase:'waiting for headers'};workflowRequests.push(row);
                        return fetch.call(this,url,...args).then(response=>{row.phase='headers received';row.status=response.status;return response;},error=>{row.phase='failed';row.error=String(error);throw error;});
                      };
                    }
                    """);
            }
            return session;
        }
        catch { await context.CloseAsync(); throw; }
    }
    public Task ReadyAsync() => Page.WaitForFunctionAsync("() => globalThis.main_frame && sandstone.libcurl.ready && !main_frame.is_navigating");
    public async Task NavigateAsync(string url, int timeout = 25000)
    {
        if (!Proxied)
        {
            var response = await Page.GotoAsync(url, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = timeout });
            if (response?.Ok != true) throw new HttpRequestException($"Native page returned {response?.Status}: {url}");
        }
        else
        {
            await Page.EvaluateAsync("url => main_frame.navigate_to(url)", url).WaitAsync(TimeSpan.FromMilliseconds(timeout));
            await Page.WaitForFunctionAsync("() => !main_frame.is_navigating", null, new() { Timeout = timeout });
        }
    }
    public Task<string?> EvaluateAsync(string source) => Page.EvaluateAsync<string?>(Proxied
        ? "source => main_frame.eval_js(source)" : "source => (0,eval)(source)", source);
    public Task ExecuteAsync(string source) => Page.EvaluateAsync(Proxied
        ? "source => main_frame.eval_js(source)" : "source => (0,eval)(source)", source);
    public async Task<JsonNode?> ReadAsync(string expression)
    {
        var json = await EvaluateAsync("JSON.stringify(" + expression + ")");
        return json == null ? null : JsonNode.Parse(json);
    }
    public async Task<T> ReadAsync<T>(string expression) => (await ReadAsync(expression))!.Deserialize<T>()!;
    public async Task WaitAsync(string expression, int timeout = 15000)
    {
        var clock = Stopwatch.StartNew(); Exception? last = null;
        while (clock.ElapsedMilliseconds < timeout)
        {
            try
            {
                if ((!Proxied || !await Page.EvaluateAsync<bool>("() => main_frame.is_navigating")) &&
                    await ReadAsync<bool>("!!(" + expression + ")").WaitAsync(TimeSpan.FromMilliseconds(Math.Max(1, Math.Min(2000, timeout - clock.ElapsedMilliseconds))))) return;
            }
            catch (Exception error) when (error is PlaywrightException or TimeoutException) { last = error; }
            await Task.Delay(100);
        }
        throw new TimeoutException($"Condition timed out: {expression}\n{last?.Message}");
    }
    public async Task ReloadAsync()
    {
        if (!Proxied) { await Page.ReloadAsync(new() { WaitUntil = WaitUntilState.DOMContentLoaded }); return; }
        var previous = await Page.EvaluateAsync<long>("() => main_frame.navigation_id");
        await ExecuteAsync("setTimeout(()=>location.reload(),0);true");
        await Page.WaitForFunctionAsync("previous => main_frame.navigation_id>previous && !main_frame.is_navigating", previous);
    }
    public ValueTask DisposeAsync() => new(Context.CloseAsync());
    private static void Record(ConcurrentQueue<string> queue, ConcurrentDictionary<string, byte> seen, string message)
    {
        if (message.Length > 2000) message = message[..2000];
        if (queue.Count < 100 && seen.TryAdd(message, 0)) queue.Enqueue(message);
    }
    private static bool IsHttp(string url) => url.StartsWith("http:") || url.StartsWith("https:");
}
