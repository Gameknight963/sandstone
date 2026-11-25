using System.IO.Compression;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests.Workflows;

internal sealed partial class SiteWorkflows
{
    private async Task<JsonNode> ScratchAsync()
    {
        await Surface.GetByText("Costumes", new() { Exact = true }).WaitForAsync(new() { Timeout = 60000 });
        var name = Surface.GetByPlaceholder("Name", new() { Exact = true }); var x = Surface.GetByPlaceholder("x", new() { Exact = true });
        await name.FillAsync("Sandstone"); await name.PressAsync("Enter"); await x.FillAsync("42"); await x.PressAsync("Enter");
        await Wait("document.querySelector('input[placeholder=x]').value==='42'");
        var block = Surface.Locator(".blocklyFlyout g.blocklyDraggable").Filter(new() { HasTextRegex = new Regex("move.*steps", RegexOptions.Singleline) }).First;
        var start = await block.BoundingBoxAsync(); var workspace = await Surface.Locator(".blocklyMainBackground").First.BoundingBoxAsync();
        Assert.NotNull(start); Assert.NotNull(workspace);
        await Page.Mouse.MoveAsync(start.X + 12, start.Y + 12); await Page.Mouse.DownAsync();
        await Page.Mouse.MoveAsync(workspace.X + workspace.Width * .7f, workspace.Y + workspace.Height * .35f, new() { Steps = 15 }); await Page.Mouse.UpAsync();
        var placed = Surface.Locator(".blocklySvg > g.blocklyWorkspace > g.blocklyBlockCanvas > g.blocklyDraggable").Filter(new() { HasTextRegex = new Regex("move.*steps", RegexOptions.Singleline) }).First;
        await Task.Delay(300); await placed.ClickAsync(new() { Position = new() { X = 12, Y = 12 } });
        await Wait("document.querySelector('input[placeholder=x]').value==='52'");
        await Surface.GetByText("File", new() { Exact = true }).ClickAsync();
        var file = await Download(() => Surface.GetByText("Save to your computer", new() { Exact = true }).ClickAsync());
        Assert.EndsWith(".sb3", file.Name);
        using var archive = new ZipArchive(new MemoryStream(file.Bytes), ZipArchiveMode.Read);
        var entry = archive.GetEntry("project.json"); Assert.NotNull(entry);
        using var reader = new StreamReader(entry.Open()); var project = JsonNode.Parse(await reader.ReadToEndAsync())!;
        var targets = project["targets"]!.AsArray().Where(target => !target!["isStage"]!.GetValue<bool>()).ToArray();
        var sprites = targets.Select(target => new { name = target!["name"]!.GetValue<string>(), x = target["x"]!.GetValue<int>(), y = target["y"]!.GetValue<int>(), costumes = target["costumes"]!.AsArray().Count }).ToArray();
        EqualJson(Json(new[] { new { name = "Sandstone", x = 52, y = 0, costumes = 2 } }), Json(sprites));
        Assert.Contains(targets[0]!["blocks"]!.AsObject(), pair => pair.Value?["opcode"]?.GetValue<string>() == "motion_movesteps");
        await name.FillAsync("Discarded"); await name.PressAsync("Enter"); await x.FillAsync("-50"); await x.PressAsync("Enter");
        EventHandler<IDialog> accept = async (_, dialog) => await dialog.AcceptAsync(); Page.Dialog += accept;
        try
        {
            await Surface.GetByText("File", new() { Exact = true }).ClickAsync();
            var chooser = await Page.RunAndWaitForFileChooserAsync(() => Surface.GetByText("Load from your computer", new() { Exact = true }).ClickAsync());
            await chooser.SetFilesAsync(new FilePayload { Name = "sandstone.sb3", MimeType = "application/octet-stream", Buffer = file.Bytes });
            await Wait("document.querySelector('input[placeholder=Name]').value==='Sandstone'&&document.querySelector('input[placeholder=x]').value==='52'");
        }
        finally { Page.Dialog -= accept; }
        return Json(new { renamed = true, moved = true, executed = true, download = true, imported = true, sprites });
    }
    private async Task<JsonNode> PaintFilesAsync()
    {
        await Surface.Locator("canvas.main-canvas").WaitForAsync();
        var png = await Page.EvaluateAsync<string>("() => {const c=document.createElement('canvas');c.width=64;c.height=48;const ctx=c.getContext('2d');ctx.fillStyle='#2468ac';ctx.fillRect(0,0,32,48);ctx.fillStyle='#e0a040';ctx.fillRect(32,0,32,48);return c.toDataURL('image/png').split(',')[1];}");
        const string pixels = "Array.from(document.querySelector('canvas.main-canvas').getContext('2d').getImageData(0,0,64,48).data)";
        ILocator Menu(string pattern) => Surface.GetByRole(AriaRole.Menuitem, new() { NameRegex = new Regex(pattern) });
        async Task Open(string name, string mimeType, byte[] buffer, IEnumerable<byte> pixel)
        {
            await Menu("^File").ClickAsync(); var chooser = await Page.RunAndWaitForFileChooserAsync(() => Menu(@"^Open\b").ClickAsync());
            await chooser.SetFilesAsync(new FilePayload { Name = name, MimeType = mimeType, Buffer = buffer });
            await Wait("(()=>{const c=document.querySelector('canvas.main-canvas');return c?.width===64&&c?.height===48&&Array.from(c.getContext('2d').getImageData(0,0,1,1).data).join(',')===" + Js(string.Join(',', pixel)) + ";})()");
        }
        byte[] initialPixel = [36, 104, 172, 255];
        await Open("sandstone-source.png", "image/png", Convert.FromBase64String(png), initialPixel);
        var initial = Bytes(await Read<int[]>(pixels)); Assert.Equal(initialPixel, initial.Take(4));
        await Menu("^Image").ClickAsync(); await Menu("^Invert Colors").ClickAsync();
        await Wait("document.querySelector('canvas.main-canvas').getContext('2d').getImageData(0,0,1,1).data[0]===219");
        var painted = Bytes(await Read<int[]>(pixels)); Assert.Equal(initial.Select((value, i) => i % 4 == 3 ? value : (byte)(255 - value)), painted);
        var expectedPixels = Hash(painted); var exports = new JsonArray();
        foreach (var (extension, mimeType, label, signature) in new[] { ("png", "image/png", "PNG (*.png)", "89504e470d0a1a0a"), ("bmp", "image/bmp", "24-bit Bitmap (*.bmp;*.dib)", "424d") })
        {
            await Menu("^File").ClickAsync(); await Menu("^Save As").ClickAsync(); var name = "sandstone-roundtrip." + extension;
            await Surface.Locator("input.file-name").FillAsync(name); await Surface.GetByRole(AriaRole.Combobox).SelectOptionAsync(new SelectOptionValue { Label = label });
            var file = await Download(() => Role(AriaRole.Button, "Save").ClickAsync()); Assert.Equal(name, file.Name);
            Assert.StartsWith(signature, Convert.ToHexString(file.Bytes).ToLowerInvariant());
            var decoded = await Page.EvaluateJsonAsync("""
                async({bytes,mimeType})=>{const image=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:mimeType}));const c=new OffscreenCanvas(image.width,image.height),ctx=c.getContext('2d');ctx.drawImage(image,0,0);image.close();return {width:c.width,height:c.height,pixels:Array.from(ctx.getImageData(0,0,c.width,c.height).data)};}
                """, new { bytes = file.Bytes.Select(b => (int)b).ToArray(), mimeType });
            Assert.Equal(64, decoded["width"]!.GetValue<int>()); Assert.Equal(48, decoded["height"]!.GetValue<int>());
            Assert.Equal(expectedPixels, Hash(Bytes(decoded["pixels"]!.AsArray().Select(value => value!.GetValue<int>()).ToArray())));
            await Menu("^File").ClickAsync(); await Menu(@"^New\b").ClickAsync();
            await Wait("Array.from(document.querySelector('canvas.main-canvas').getContext('2d').getImageData(0,0,1,1).data).join(',')==='255,255,255,255'");
            await Open(name, mimeType, file.Bytes, painted.Take(4)); Assert.Equal(expectedPixels, Hash(Bytes(await Read<int[]>(pixels))));
            exports.Add(Json(new { name, width = 64, height = 48, pixels = expectedPixels, reopened = true }));
        }
        return Json(new { opened = true, inverted = true, exports });
    }
}
