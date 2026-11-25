using System.Text;
using Microsoft.Playwright.Xunit.v3;
using Sandstone.BrowserTests.Infrastructure;

namespace Sandstone.BrowserTests;

public sealed class BrowserWorkflowTests : BrowserTest
{
    private static async Task InstallAsync(BrowserSession session, string html)
    {
        await session.Page.EvaluateAsync("html=>{main_frame.on_load=()=>{};sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html'}});}", html);
        await session.NavigateAsync("https://browser-workflow.test/");
    }
    [Fact]
    public async Task ClicksAndClientNavigationPreservePageState()
    {
        await using var session = await BrowserSession.CreateAsync(Browser, true);
        await InstallAsync(session, """
            <!doctype html><title>Interactive fixture</title><button id="add">Add</button><output id="count">0</output>
            <a id="next" href="/next">Next</a><script>
            let count=0;document.getElementById('add').onclick=()=>document.getElementById('count').textContent=String(++count);
            document.getElementById('next').onclick=event=>{event.preventDefault();history.pushState({count},'',event.currentTarget.href)};
            </script>
            """);
        await session.ExecuteAsync("window.marker='retained';true");
        await session.Surface.GetByRole(AriaRole.Button, new() { Name = "Add", Exact = true }).ClickAsync();
        await session.Surface.GetByRole(AriaRole.Button, new() { Name = "Add", Exact = true }).ClickAsync();
        Assert.Equal("2", await session.Surface.Locator("#count").TextContentAsync());
        await session.Surface.GetByRole(AriaRole.Link, new() { Name = "Next", Exact = true }).ClickAsync();
        await session.WaitAsync("location.pathname==='/next'");
        Assert.Equal("retained", await session.ReadAsync<string>("marker")); Assert.Equal(2, await session.ReadAsync<int>("history.state.count"));
        await session.ExecuteAsync("history.back();true"); await session.WaitAsync("location.pathname==='/'");
        Assert.Equal("2", await session.Surface.Locator("#count").TextContentAsync()); Assert.Empty(session.DirectHttp); Assert.Empty(session.Errors);
    }
    [Fact]
    public async Task UploadedFileCanBeDownloadedWithoutChangingBytes()
    {
        await using var session = await BrowserSession.CreateAsync(Browser, true);
        await InstallAsync(session, """
            <!doctype html><title>File workflow</title><input type="file" aria-label="Open file"><a id="save" hidden>Download</a>
            <script>document.querySelector('input').onchange=async event=>{const file=event.target.files[0],save=document.getElementById('save');save.href=URL.createObjectURL(new Blob([await file.arrayBuffer()],{type:file.type}));save.download=file.name;save.hidden=false;};</script>
            """);
        var expected = Encoding.UTF8.GetBytes("Sandstone upload/download: caf\u00e9 \u20ac\n");
        await session.Surface.GetByLabel("Open file").SetInputFilesAsync(new FilePayload { Name = "roundtrip.txt", MimeType = "text/plain", Buffer = expected });
        var download = await session.Page.RunAndWaitForDownloadAsync(() => session.Surface.GetByRole(AriaRole.Link, new() { Name = "Download", Exact = true }).ClickAsync());
        Assert.Equal("roundtrip.txt", download.SuggestedFilename); Assert.Null(await download.FailureAsync());
        await using var stream = await download.CreateReadStreamAsync(); Assert.NotNull(stream);
        using var bytes = new MemoryStream(); await stream.CopyToAsync(bytes, TestContext.Current.CancellationToken);
        Assert.Equal(expected, bytes.ToArray()); Assert.Empty(session.DirectHttp); Assert.Empty(session.Errors);
    }
}
