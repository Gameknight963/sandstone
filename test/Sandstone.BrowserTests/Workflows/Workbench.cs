using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests.Workflows;

internal sealed partial class SiteWorkflows
{
    private async Task<JsonNode> VsCodeAsync()
    {
        await Wait("!!document.querySelector('.monaco-workbench')"); var input = Surface.Locator(".quick-input-box input");
        Task Choose(string label) => Surface.Locator(".quick-input-list .label-name").Filter(new() { HasTextRegex = new Regex("^" + Regex.Escape(label) + "$") }).ClickAsync();
        async Task Command(string label) { await Page.Keyboard.PressAsync("Control+Shift+p"); await input.FillAsync(">" + label); await Choose(label); }
        await Command("File: New Untitled Text File"); await Wait("!!document.querySelector('.monaco-editor[data-uri^=untitled]')");
        await Command("Change Language Mode"); await input.FillAsync("JSON"); await Choose("JSON");
        await Page.Keyboard.PressAsync("Escape"); await Page.Mouse.MoveAsync(0, 0);
        var sample = Json(new { answer = 42, items = new[] { 1, 2, 3 } }); var compact = sample.ToJsonString(); await Page.Keyboard.TypeAsync(compact);
        const string text = "Array.from(document.querySelectorAll('.monaco-editor .view-lines')).at(-1)?.innerText.replace(/\\u00a0/g,' ')||''";
        await Wait("(" + text + ")===" + Js(compact));
        var formattedExpression = "(" + text + ").includes('\\n')"; const string missing = "document.body.innerText.includes('There is no formatter')";
        var clock = Stopwatch.StartNew(); var ready = false;
        while (clock.ElapsedMilliseconds < 60000)
        {
            await Page.Keyboard.PressAsync("Shift+Alt+f"); await Wait(formattedExpression + "||" + missing);
            if (await Read<bool>(formattedExpression)) { ready = true; break; }
            await Role(AriaRole.Button, "Cancel").ClickAsync(); await Task.Delay(300);
        }
        if (!ready) throw new TimeoutException("VS Code JSON formatter never became available: " + await Read<string>("document.body.innerText.slice(-7000)"));
        var formatted = await Read<string>(text); EqualJson(sample, JsonNode.Parse(formatted));
        await Page.Keyboard.PressAsync("Control+z"); await Wait("(" + text + ")===" + Js(compact));
        await Page.Keyboard.PressAsync("Control+Shift+z"); await Wait("(" + text + ")===" + Js(formatted));
        await Wait("!document.title.includes(" + Js(compact) + ")");
        return Json(new { created = true, edited = true, formatted = true, undo = true, redo = true, value = sample });
    }
    private async Task<JsonNode> FlemsAsync()
    {
        const string html = "<h1 id=\"marker\">Sandstone preview</h1><button id=\"increment\">Add</button><output id=\"value\">0</output>";
        const string javascript = "let count=0;document.getElementById(\"increment\").onclick=()=>{document.getElementById(\"value\").textContent=String(++count);};";
        const string css = "#marker{color:rgb(17,34,51)}";
        await Surface.GetByText(new Regex("^disable auto reload$", RegexOptions.IgnoreCase)).Locator("..").ClickAsync();
        async Task Edit(string name, string source, string mode)
        {
            await Surface.GetByText(name, new() { Exact = true }).ClickAsync(); await Wait("document.querySelector('.CodeMirror')?.CodeMirror.getMode().name===" + Js(mode));
            await Surface.Locator(".CodeMirror").ClickAsync(); await Page.Keyboard.PressAsync("Control+a"); await Page.Keyboard.InsertTextAsync(source);
            await Wait("document.querySelector('.CodeMirror')?.CodeMirror.getValue()===" + Js(source));
        }
        await Edit(".html", html, "htmlmixed"); await Edit(".js", javascript, "javascript"); await Edit(".css", css, "css");
        await Surface.GetByText(new Regex("^refresh$", RegexOptions.IgnoreCase)).Locator("..").ClickAsync();
        var preview = Surface.FrameLocator("iframe");
        async Task Ready()
        {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < 8000)
            {
                try
                {
                    await preview.Locator("#marker").WaitForAsync(new() { Timeout = 1000 });
                    if (await preview.Locator("#marker").EvaluateAsync<bool>("node=>getComputedStyle(node).color==='rgb(17, 34, 51)'&&typeof document.getElementById('increment')?.onclick==='function'")) return;
                }
                catch (PlaywrightException) { }
                await Task.Delay(50);
            }
            throw new TimeoutException("Flems did not apply HTML, CSS and JavaScript to its preview.");
        }
        await Ready();
        await preview.GetByRole(AriaRole.Button, new() { Name = "Add", Exact = true }).ClickAsync();
        await preview.GetByRole(AriaRole.Button, new() { Name = "Add", Exact = true }).ClickAsync();
        await preview.Locator("#value").Filter(new() { HasTextRegex = new Regex("^2$") }).WaitForAsync();
        Assert.Equal("rgb(17, 34, 51)", await preview.Locator("#marker").EvaluateAsync<string>("node=>getComputedStyle(node).color"));
        // The compressed URL is decoded by the existing JS library in the test
        // service; assertions about all three saved files remain in C#.
        using var client = new HttpClient(); var saved = false; var deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < 8000)
        {
            try
            {
                var hash = await Read<string>("location.hash");
                var state = JsonNode.Parse(await client.GetStringAsync(serviceOrigin + "/decode-flems?hash=" + Uri.EscapeDataString(hash)));
                var files = state?["files"]?.AsArray();
                saved = files != null && new[] { (".html", html), (".js", javascript), (".css", css) }.All(expected => files.Any(file => file?["name"]?.GetValue<string>() == expected.Item1 && file?["content"]?.GetValue<string>() == expected.Item2));
                if (saved) break;
            }
            catch (Exception error) when (error is HttpRequestException or System.Text.Json.JsonException) { }
            await Task.Delay(50);
        }
        Assert.True(saved, "Flems did not save all three edited files in its URL.");
        Assert.Equal(css, await Read<string>("document.querySelector('.CodeMirror').CodeMirror.getValue()"));
        await session.ReloadAsync(); await Ready();
        await preview.GetByRole(AriaRole.Button, new() { Name = "Add", Exact = true }).ClickAsync();
        await preview.Locator("#value").Filter(new() { HasTextRegex = new Regex("^1$") }).WaitForAsync();
        Assert.Equal("Sandstone preview", await preview.Locator("#marker").InnerTextAsync());
        Assert.Equal("rgb(17, 34, 51)", await preview.Locator("#marker").EvaluateAsync<string>("node=>getComputedStyle(node).color"));
        return Json(new { html = true, javascript = true, css = true, interactive = true, reloaded = true });
    }
}
