using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests.Workflows;

internal sealed partial class SiteWorkflows
{
    private async Task<JsonNode> PhotopeaAsync()
    {
        await Role(AriaRole.Button, "Start using Photopea").First.ClickAsync();
        await Surface.GetByText("New Project", new() { Exact = true }).ClickAsync();
        await Surface.GetByLabel("Name", new() { Exact = true }).FillAsync("Sandstone");
        await Surface.GetByLabel("Width", new() { Exact = true }).FillAsync("128");
        await Surface.GetByLabel("Height", new() { Exact = true }).FillAsync("128");
        await Surface.GetByText("Create", new() { Exact = true }).ClickAsync();
        await Surface.GetByTitle("Brush Tool (B)", new() { Exact = true }).ClickAsync();
        var sizes = (await Read("Array.from(document.querySelectorAll('canvas'),canvas=>({width:canvas.width,height:canvas.height}))"))!.AsArray();
        var index = Enumerable.Range(0, sizes.Count).MaxBy(i => sizes[i]!["width"]!.GetValue<int>() * sizes[i]!["height"]!.GetValue<int>());
        var box = await Surface.Locator("canvas").Nth(index).BoundingBoxAsync(); Assert.NotNull(box);
        var x = box.X + box.Width / 2; var y = box.Y + box.Height / 2;
        async Task<byte[]> Snapshot()
        {
            var png = await Page.ScreenshotAsync();
            // Use doubles in script arguments, matching JavaScript's numbers.
            var capture = await Page.EvaluateJsonAsync("""
                async({bytes,x,y})=>{const image=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'}));const width=image.width,height=image.height,crop=new OffscreenCanvas(96,64),ctx=crop.getContext('2d');ctx.drawImage(image,x-48,y-32,96,64,0,0,96,64);image.close();return {width,height,x,y,pixels:Array.from(ctx.getImageData(0,0,96,64).data)};}
                """, new { bytes = png.Select(b => (int)b).ToArray(), x = (double)x, y = (double)y });
            Assert.True(x >= 48 && y >= 32 && x + 48 <= capture["width"]!.GetValue<float>() && y + 32 <= capture["height"]!.GetValue<float>(), $"Drawing region is outside the screenshot: {x},{y} in {capture["width"]}x{capture["height"]}");
            return Bytes(capture["pixels"]!.AsArray().Select(value => value!.GetValue<int>()).ToArray());
        }
        await Page.Mouse.MoveAsync(box.X + 5, box.Y + 5); var before = await Snapshot();
        await Page.Mouse.MoveAsync(x - 25, y); await Page.Mouse.DownAsync(); await Page.Mouse.MoveAsync(x + 25, y, new() { Steps = 8 }); await Page.Mouse.UpAsync();
        await Page.Mouse.MoveAsync(box.X + 5, box.Y + 5);
        const string modified = "document.body.innerText.includes('Sandstone.psd *')";
        await Wait(modified); var drawn = await Snapshot(); Assert.NotEqual(before, drawn);
        await Page.Keyboard.PressAsync("Control+z"); await Wait("!(" + modified + ")"); Assert.Equal(before, await Snapshot());
        await Page.Keyboard.PressAsync("Control+Shift+z"); await Wait(modified); Assert.Equal(drawn, await Snapshot());
        return Json(new { created = true, drawn = true, undo = true, redo = true });
    }
    private async Task<JsonNode> GeoGebraAsync()
    {
        await Surface.Locator(".scrollableTextBox canvas").First.ClickAsync();
        await Page.Keyboard.TypeAsync("a=2+3"); await Page.Keyboard.PressAsync("Enter");
        await Wait("globalThis.ggbApplet?.getValue('a')===5");
        await Role(AriaRole.Button, "Undo").ClickAsync(); await Wait("!ggbApplet.exists('a')");
        await Role(AriaRole.Button, "Redo").ClickAsync(); await Wait("ggbApplet.getValue('a')===5");
        return Json(new { objects = await Read("ggbApplet.getAllObjectNames()"), value = 5, undo = true, redo = true });
    }
    private async Task<JsonNode> DesmosAsync()
    {
        await Surface.Locator(".dcg-mq-editable-field").First.ClickAsync();
        await Page.Keyboard.TypeAsync("y=x^2"); await Page.Keyboard.PressAsync("Enter");
        const string expressions = "Calc.getExpressions().map(expression=>expression.latex||'')";
        const string plotted = "(()=>{const canvas=document.querySelector('canvas.dcg-graph-inner');if(!canvas)return false;const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;for(let i=0;i<data.length;i+=4)if(data[i]>150&&data[i+1]<130&&data[i+2]<130&&data[i+3]>200)return true;return false;})()";
        await Wait(expressions + ".includes('y=x^{2}')"); await Wait(plotted);
        var after = await Read(expressions); var serialized = Js(after!.ToJsonString());
        await Role(AriaRole.Button, "Undo").ClickAsync(); await Wait("JSON.stringify(" + expressions + ")!==" + serialized);
        await Role(AriaRole.Button, "Redo").ClickAsync(); await Wait("JSON.stringify(" + expressions + ")===" + serialized); await Wait(plotted);
        return Json(new { expressions = after.AsArray().Select(x => x!.GetValue<string>()).Where(x => x.Length > 0), plotted = true, undo = true, redo = true });
    }
    private async Task<JsonNode> JsPaintAsync()
    {
        var canvas = Surface.Locator("canvas.main-canvas"); await canvas.WaitForAsync();
        await Surface.Locator(".tool[title=Pencil]").ClickAsync();
        const string ink = "(()=>{const c=document.querySelector('canvas.main-canvas'),d=c.getContext('2d').getImageData(10,10,110,110).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i+3]&&Math.min(d[i],d[i+1],d[i+2])<128)n++;return n;})()";
        var before = await Read<int>(ink); var box = await canvas.BoundingBoxAsync(); Assert.NotNull(box);
        var size = await Read("({width:document.querySelector('canvas.main-canvas').width,height:document.querySelector('canvas.main-canvas').height})");
        var width = size!["width"]!.GetValue<float>(); var height = size["height"]!.GetValue<float>();
        await Page.Mouse.MoveAsync(box.X + 30 * box.Width / width, box.Y + 30 * box.Height / height); await Page.Mouse.DownAsync();
        await Page.Mouse.MoveAsync(box.X + 90 * box.Width / width, box.Y + 70 * box.Height / height, new() { Steps = 12 }); await Page.Mouse.UpAsync();
        await Wait(ink + ">" + before); var drawn = await Read<int>(ink);
        await Page.Keyboard.PressAsync("Control+z"); await Wait(ink + "===" + before);
        await Page.Keyboard.PressAsync("Control+y"); await Wait(ink + "===" + drawn);
        return Json(new { drawn = true, undo = true, redo = true });
    }
    private async Task<JsonNode> MermaidAsync()
    {
        await Surface.Locator(".monaco-editor").First.WaitForAsync();
        var stay = Surface.GetByText("Stay in mermaid.live", new() { Exact = true });
        try { await stay.WaitForAsync(new() { Timeout = 4000 }); await stay.ClickAsync(); } catch (TimeoutException) { }
        await Surface.Locator("[data-dialog-overlay]").WaitForAsync(new() { State = WaitForSelectorState.Hidden });
        await Surface.Locator(".monaco-editor").First.ClickAsync(new() { Position = new() { X = 80, Y = 40 } });
        await Page.Keyboard.PressAsync("Control+a"); await Page.Keyboard.InsertTextAsync("flowchart LR\n A[Sandstone] --> B[Working]");
        await Wait("Array.from(document.querySelectorAll('svg')).some(svg=>svg.textContent.includes('Sandstone')&&svg.textContent.includes('Working')&&svg.querySelectorAll('.node').length===2)");
        return Json(new { edited = true, preview = true, nodes = 2 });
    }
    private async Task<JsonNode> DiagramsAsync()
    {
        var item = Surface.Locator(".geSidebarContainer .geItem").First; await item.WaitForAsync();
        const string count = "document.querySelectorAll('.geDiagramContainer svg rect').length";
        var before = await Read<int>(count); await item.ClickAsync(); await Wait(count + ">" + before);
        await Page.Keyboard.PressAsync("Control+z"); await Wait(count + "===" + before);
        await Page.Keyboard.PressAsync("Control+y"); await Wait(count + ">" + before);
        return Json(new { inserted = true, undo = true, redo = true });
    }
}
