using System.Text;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests.Workflows;

internal sealed partial class SiteWorkflows
{
    private async Task<JsonNode> HlsAsync(bool encrypted)
    {
        await Wait("!!document.querySelector('video')");
        if (encrypted) await Surface.Locator("#streamSelect").SelectOptionAsync("oceansAES");
        await Read("(document.querySelector('video').muted=true)"); await Role(AriaRole.Button, "Play").ClickAsync();
        await Wait("(()=>{const v=document.querySelector('video');return v.currentTime>.2&&v.videoWidth>0&&v.getVideoPlaybackQuality().totalVideoFrames>0})()");
        if (encrypted) await Wait("hls.levels.some(level=>level.details?.fragments.some(fragment=>fragment.decryptdata?.method==='AES-128'))");
        await Surface.Locator("#seek_pos").FillAsync("12"); await Role(AriaRole.Button, "Seek to").ClickAsync(); await Wait("document.querySelector('video').currentTime>=12");
        await Role(AriaRole.Button, "Pause").ClickAsync(); await Wait("document.querySelector('video').paused");
        var paused = await Read<double>("document.querySelector('video').currentTime");
        await Role(AriaRole.Button, "Play").ClickAsync(); await Wait("document.querySelector('video').currentTime>" + Js(paused + .2));
        return Json(new { played = true, decoded = true, seeked = true, paused = true, resumed = true });
    }
    private async Task<JsonNode> PdfAsync()
    {
        await Wait("document.querySelector(\".page[data-page-number='1'] .textLayer\")?.textContent.includes('Trace-based')");
        await Surface.Locator("#pageNumber").FillAsync("2"); await Surface.Locator("#pageNumber").PressAsync("Enter");
        await Wait("document.querySelector(\".page[data-page-number='2'] canvas\")?.width>0&&document.querySelector('#pageNumber').value==='2'");
        await Surface.Locator("#scaleSelect").SelectOptionAsync("1.5"); await Surface.Locator("#viewFindButton").ClickAsync();
        await Surface.Locator("#findInput").FillAsync("JavaScript"); await Surface.Locator("#findInput").PressAsync("Enter");
        await Wait("document.querySelector('#findResultsCount')?.textContent.includes('of')");
        var result = (await Result("({pages:Number(document.querySelector('#pageNumber').max),zoom:document.querySelector('#scaleSelect').value,found:/of/.test(document.querySelector('#findResultsCount').textContent),rendered:!!document.querySelector('.page canvas')?.width})")).AsObject();
        EqualJson(Json(new { pages = 14, zoom = "1.5", found = true, rendered = true }), result);
        var file = await Download(() => Role(AriaRole.Button, "Save").ClickAsync());
        Assert.StartsWith("%PDF-", Encoding.ASCII.GetString(file.Bytes)); Assert.True(file.Bytes.Length > 100000);
        result["download"] = file.Name; result["pdf"] = true; result["sha256"] = Hash(file.Bytes); return result;
    }
    private async Task<JsonNode> CyberChefAsync(bool hashVariant)
    {
        await Surface.Locator("#loader-wrapper").WaitForAsync(new() { State = WaitForSelectorState.Detached, Timeout = 60000 });
        await Surface.Locator("#input-text [contenteditable=true]").FillAsync("c2FuZHN0b25l");
        async Task Operation(string name)
        {
            await Surface.Locator("#search").FillAsync(name); await Surface.Locator("#search").PressAsync("Enter");
            await Surface.Locator("li.operation:visible").Filter(new() { HasTextRegex = new Regex("^" + Regex.Escape(name) + "$") }).First.DblClickAsync();
        }
        await Operation("From Base64"); await Wait("document.querySelector('#output-text .cm-content')?.textContent.includes('sandstone')");
        Assert.Equal("sandstone", await Read<string>("document.querySelector('#output-text .cm-content').textContent"));
        if (!hashVariant && !Isolated) return Json(new { decoded = "sandstone" });
        await Operation("SHA2");
        static string Sha512(string value) => Convert.ToHexString(SHA512.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
        var hash = Sha512("sandstone"); await Wait("document.querySelector('#output-text .cm-content')?.textContent===" + Js(hash));
        await Surface.Locator("#input-text [contenteditable=true]").FillAsync("cHJveHk=");
        var changed = Sha512("proxy"); await Wait("document.querySelector('#output-text .cm-content')?.textContent===" + Js(changed));
        return Json(new { decoded = "sandstone", sha512 = hash, changed });
    }
    private async Task<JsonNode> SqlimeAsync()
    {
        var editor = Surface.Locator("#editor");
        await editor.FillAsync("create table numbers(value); insert into numbers values (6),(7); select sum(value) as answer from numbers;");
        await Role(AriaRole.Button, "run").ClickAsync(); await Wait("Array.from(document.querySelectorAll('td')).some(cell=>cell.textContent.trim()==='13')");
        await editor.FillAsync("select count(*) as rows, max(value) as largest from numbers;"); await Role(AriaRole.Button, "run").ClickAsync();
        await Wait("Array.from(document.querySelectorAll('th')).some(cell=>cell.textContent.trim()==='largest')");
        var values = await Read("Array.from(document.querySelectorAll('tbody td')).map(cell=>cell.textContent.trim())");
        EqualJson(Json(new[] { "2", "7" }), values); return Json(new { created = true, inserted = true, sum = 13, values });
    }
    private async Task<JsonNode> SquooshAsync()
    {
        var png = await Page.EvaluateAsync<string>("() => {const c=document.createElement('canvas');c.width=128;c.height=96;const ctx=c.getContext('2d');for(let y=0;y<96;y++){ctx.fillStyle='rgb('+y*2+',80,180)';ctx.fillRect(0,y,128,1);}return c.toDataURL().split(',')[1];}");
        await Surface.Locator("input[type=file]").SetInputFilesAsync(new FilePayload { Name = "sandstone.png", MimeType = "image/png", Buffer = Convert.FromBase64String(png) });
        const string jpeg = "a[download=\"sandstone.jpg\"][href^=\"blob:\"]", webp = "a[download=\"sandstone.webp\"][href^=\"blob:\"]";
        await Wait("!!document.querySelector(" + Js(jpeg) + ")"); var initial = await Read<string>("document.querySelector(" + Js(jpeg) + ").getAttribute('href')");
        await Surface.Locator("select").Last.SelectOptionAsync("webP"); await Wait("!!document.querySelector(" + Js(webp) + ")");
        var image = JsonNode.Parse((await session.EvaluateAsync("(async()=>{const link=document.querySelector(" + Js(webp) + "),r=await fetch(link.href),blob=await r.blob(),bytes=new Uint8Array(await blob.arrayBuffer()),b=await createImageBitmap(blob);const result={name:link.download,type:blob.type,width:b.width,height:b.height,signature:String.fromCharCode(...bytes.slice(0,4)),format:String.fromCharCode(...bytes.slice(8,12)),changed:link.href!==" + Js(initial) + "};b.close();return JSON.stringify(result);})()"))!)!.AsObject();
        EqualJson(Json(new { name = "sandstone.webp", type = "image/webp", width = 128, height = 96, signature = "RIFF", format = "WEBP", changed = true }), image);
        var file = await Download(() => Surface.Locator("a[download='sandstone.webp']").ClickAsync()); Assert.Equal("sandstone.webp", file.Name);
        image["downloaded"] = true; return image;
    }
}
