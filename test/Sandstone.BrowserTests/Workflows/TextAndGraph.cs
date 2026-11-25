using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests.Workflows;

internal sealed partial class SiteWorkflows
{
    private async Task<JsonNode> MarkdownAsync()
    {
        const string markdown = "# Sandstone\n\nA **working** Markdown preview with [a link](https://example.com/).\n\n- [x] saved\n- [ ] pending\n\n| value | answer |\n| --- | --- |\n| caf\u00e9 | 42 |\n\n```js\nconst answer = 42;\n```\n\nUnicode: caf\u00e9 \u20ac\n";
        const string preview = "Array.from(document.querySelectorAll('h1')).some(n=>n.textContent==='Sandstone')&&Array.from(document.querySelectorAll('strong')).some(n=>n.textContent==='working')&&Array.from(document.querySelectorAll('pre code')).some(n=>n.textContent.includes('const answer = 42'))";
        await Surface.Locator(".monaco-editor").First.WaitForAsync(); await Role(AriaRole.Button, "Open settings").ClickAsync();
        var autosave = Surface.Locator("#auto-save"); if (await autosave.GetAttributeAsync("aria-checked") != "true") await autosave.ClickAsync();
        await Role(AriaRole.Button, "Close settings").ClickAsync();
        await Surface.Locator(".monaco-editor").First.ClickAsync(new() { Position = new() { X = 80, Y = 40 } });
        await Page.Keyboard.PressAsync("Control+a"); await Page.Keyboard.InsertTextAsync(markdown); await Wait(preview);
        await Role(AriaRole.Button, "Save Session").ClickAsync();
        await Wait("Object.values(localStorage).some(v=>v.includes('# Sandstone')&&v.includes('const answer = 42'))");
        await session.ReloadAsync(); await Surface.Locator(".monaco-editor").First.WaitForAsync(); await Wait(preview);
        var exports = new JsonArray();
        foreach (var format in new[] { "Markdown", "HTML", "Styled HTML" })
        {
            await Role(AriaRole.Button, "Export document").ClickAsync(); var file = await Download(() => Role(AriaRole.Menuitem, format).ClickAsync());
            var text = Encoding.UTF8.GetString(file.Bytes); var row = new JsonObject { ["format"] = format, ["name"] = file.Name };
            if (format == "Markdown") { Assert.Equal(markdown.TrimEnd(), text.TrimEnd()); row["sha256"] = Hash(file.Bytes); }
            else
            {
                var content = await Page.EvaluateJsonAsync("""
                    text=>{const doc=new DOMParser().parseFromString(text,'text/html');return {heading:doc.querySelector('h1')?.textContent,strong:doc.querySelector('strong')?.textContent,code:doc.querySelector('pre code')?.textContent.trim(),link:doc.querySelector('a[href="https://example.com/"]')?.getAttribute('href'),checks:[...doc.querySelectorAll('li input[type=checkbox]')].map(n=>n.checked),unicode:doc.body.textContent.includes('caf\u00e9 \u20ac')};}
                    """, text);
                EqualJson(Json(new { heading = "Sandstone", strong = "working", code = "const answer = 42;", link = "https://example.com/", checks = new[] { true, false }, unicode = true }), content);
                row["content"] = content;
            }
            Assert.EndsWith(format == "Markdown" ? ".md" : ".html", file.Name); exports.Add(row);
        }
        return Json(new { edited = true, preview = true, saved = true, reloaded = true, exports });
    }
    private async Task<JsonNode> JsonCrackAsync()
    {
        var sample = Json(new { project = "Sandstone", ready = true, items = new[] { new { name = "alpha", value = 42 }, new { name = "beta", value = 7 } }, notes = "caf\u00e9 \u20ac" });
        await Surface.Locator("input[type=file]").SetInputFilesAsync(new FilePayload { Name = "sandstone.json", MimeType = "application/json", Buffer = Encoding.UTF8.GetBytes(sample.ToJsonString(new() { WriteIndented = true })) });
        await Wait("!!document.querySelector('foreignObject [data-key=\"value: 42\"]')");
        await Surface.Locator(".view-line").Filter(new() { HasTextRegex = new Regex("\"value\":\\s*42") }).First.ClickAsync();
        await Page.Keyboard.PressAsync("End"); await Page.Keyboard.PressAsync("Backspace"); await Page.Keyboard.PressAsync("Backspace"); await Page.Keyboard.TypeAsync("43");
        await Wait("!!document.querySelector('foreignObject [data-key=\"value: 43\"]')");
        const string graph = "document.querySelector('foreignObject [data-key=\"project: Sandstone\"]')?.closest('svg')";
        ILocator Toggle() => Surface.Locator("foreignObject [data-collapse-path]").Filter(new() { HasTextRegex = new Regex("^[\u2212+]$") }).First;
        await Toggle().ClickAsync(); await Wait("(" + graph + ")?.querySelectorAll('foreignObject[data-id]').length===1");
        await Toggle().ClickAsync(); await Wait("(" + graph + ")?.querySelectorAll('foreignObject[data-id]').length===3");
        Assert.True(await Read<bool>("!!document.querySelector('foreignObject [data-key=\"value: 43\"]')"));
        var exports = new JsonArray();
        foreach (var format in new[] { "SVG", "PNG" })
        {
            await Role(AriaRole.Button, "export").ClickAsync(); var dialog = Surface.GetByRole(AriaRole.Dialog); await dialog.WaitForAsync();
            await dialog.GetByLabel("File Name", new() { Exact = true }).FillAsync("sandstone-graph"); await dialog.GetByText(format, new() { Exact = true }).ClickAsync();
            var file = await Download(() => dialog.GetByRole(AriaRole.Button, new() { Name = "Download", Exact = true }).ClickAsync());
            Assert.EndsWith("." + format.ToLowerInvariant(), file.Name); JsonNode image;
            if (format == "SVG")
            {
                image = await Page.EvaluateJsonAsync("text=>{const doc=new DOMParser().parseFromString(text,'image/svg+xml'),root=doc.documentElement;return {svg:root.localName==='svg',width:Number.parseFloat(root.getAttribute('width')),height:Number.parseFloat(root.getAttribute('height')),labels:[...doc.querySelectorAll('[data-key]')].map(n=>n.getAttribute('data-key')).sort()};}", Encoding.UTF8.GetString(file.Bytes));
                Assert.True(image["svg"]!.GetValue<bool>());
                foreach (var label in new[] { "project: Sandstone", "ready: true", "name: alpha", "value: 43", "name: beta", "value: 7", "notes: caf\u00e9 \u20ac" }) Assert.Contains(image["labels"]!.AsArray(), node => node!.GetValue<string>() == label);
            }
            else
            {
                Assert.StartsWith("89504e470d0a1a0a", Convert.ToHexString(file.Bytes).ToLowerInvariant());
                image = await Page.EvaluateJsonAsync("""
                    async bytes=>{const b=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'})),c=new OffscreenCanvas(b.width,b.height),ctx=c.getContext('2d');ctx.drawImage(b,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;let ink=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]&&Math.min(pixels[i],pixels[i+1],pixels[i+2])<220)ink++;b.close();const digest=await crypto.subtle.digest('SHA-256',pixels);return {width:c.width,height:c.height,drawn:ink>100,pixels:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')};}
                    """, file.Bytes.Select(b => (int)b).ToArray());
                Assert.True(image["drawn"]!.GetValue<bool>());
            }
            Assert.True(image["width"]!.GetValue<float>() > 0 && image["height"]!.GetValue<float>() > 0);
            exports.Add(Json(new { format, name = file.Name, image }));
            if (await dialog.IsVisibleAsync()) await Page.Keyboard.PressAsync("Escape"); await dialog.WaitForAsync(new() { State = WaitForSelectorState.Hidden });
        }
        return Json(new { imported = true, edited = 43, collapsed = true, expanded = true, exports });
    }
}
