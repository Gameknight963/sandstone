using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests.Workflows;

internal sealed partial class SiteWorkflows
{
    private Task MarkNavigation() => session.ExecuteAsync("window.liveNavigationMarker='persisted';true");
    private Task Back() => session.ExecuteAsync("history.back();true");
    private Task Forward() => session.ExecuteAsync("history.forward();true");
    private async Task<JsonNode> Result(string expression) => (await Read(expression))!;
    private async Task CheckNavigation() => Assert.True(await Read<bool>("window.liveNavigationMarker==='persisted'"), "Client navigation replaced the document.");
    private async Task<JsonNode> DiscordAsync()
    {
        await Surface.Locator("input[name=email]").FillAsync("sandstone@example.invalid");
        await Surface.Locator("input[name=password]").FillAsync("sandstone test");
        EqualJson(Json(new { email = "sandstone@example.invalid", password = "sandstone test" }), await Read("({email:document.querySelector('input[name=email]').value,password:document.querySelector('input[name=password]').value})"));
        await MarkNavigation(); await Surface.GetByText("Register", new() { Exact = true }).ClickAsync();
        await Wait("location.pathname==='/register'&&!!document.querySelector('input[name=username]')");
        await Back(); await Wait("location.pathname==='/login'&&!!document.querySelector('input[name=email]')&&!document.querySelector('input[name=username]')&&document.querySelector('h1')?.textContent.trim()==='Welcome back!'");
        await CheckNavigation(); return Json(new { login = true, register = true, returned = true, clientNavigation = true });
    }
    private async Task<JsonNode> ExcalidrawAsync()
    {
        await Role(AriaRole.Button, "Rectangle").ClickAsync();
        var box = await Surface.Locator("canvas.interactive").BoundingBoxAsync(); Assert.NotNull(box);
        var x = box.X + box.Width * .55f; var y = box.Y + box.Height * .5f;
        await Page.Mouse.MoveAsync(x, y); await Page.Mouse.DownAsync(); await Page.Mouse.MoveAsync(x + 120, y + 80, new() { Steps = 8 }); await Page.Mouse.UpAsync();
        const string count = "JSON.parse(localStorage.getItem('excalidraw')||'[]').filter(shape=>shape.type==='rectangle'&&!shape.isDeleted).length";
        const string geometry = "JSON.parse(localStorage.getItem('excalidraw')).filter(shape=>!shape.isDeleted).map(shape=>({type:shape.type,width:shape.width,height:shape.height}))";
        await Wait(count + "===1"); var shapes = await Read(geometry);
        await Role(AriaRole.Button, "Undo").ClickAsync(); await Wait(count + "===0");
        await Role(AriaRole.Button, "Redo").ClickAsync(); await Wait(count + "===1");
        await session.ReloadAsync(); await Role(AriaRole.Button, "Rectangle").WaitForAsync(); await Wait(count + "===1");
        EqualJson(shapes, await Read(geometry)); return Json(new { shapes, undo = true, redo = true, reloaded = true });
    }
    private async Task<JsonNode> OpenStreetMapAsync()
    {
        await Wait("Array.from(document.querySelectorAll('img.leaflet-tile-loaded')).some(image=>image.complete&&image.naturalWidth>0)");
        var map = Surface.Locator(".leaflet-container"); await map.FocusAsync(); await map.PressAsync("Equal");
        await Wait("location.hash.startsWith('#map=6/')");
        return await Result("({zoom:location.hash.split('/')[0],tiles:Array.from(document.querySelectorAll('img.leaflet-tile-loaded')).some(image=>image.complete&&image.naturalWidth>0)})");
    }
    private async Task<JsonNode> MastodonAsync()
    {
        await Wait("document.querySelectorAll('article[data-variant=feed]').length>0"); await MarkNavigation();
        await Surface.Locator("a[href='/explore/tags']").ClickAsync();
        await Wait("location.pathname==='/explore/tags'&&Array.from(document.links).some(link=>link.getAttribute('href')?.startsWith('/tags/'))");
        await CheckNavigation(); await Back(); await Wait("location.pathname==='/explore'&&document.querySelectorAll('article[data-variant=feed]').length>0");
        return Json(new { feed = true, tags = true, returned = true, clientNavigation = true });
    }
    private async Task<JsonNode> DiscourseAsync()
    {
        await Wait("document.querySelectorAll('.topic-list-item a.title').length>0"); await MarkNavigation();
        await Surface.Locator(".topic-list-item a.title").First.ClickAsync();
        await Wait("location.pathname.startsWith('/t/')&&document.querySelectorAll('.topic-post').length>0"); await CheckNavigation();
        await Back(); await Wait("location.pathname==='/latest'&&document.querySelectorAll('.topic-list-item a.title').length>0");
        return Json(new { topic = true, returned = true, clientNavigation = true });
    }
    private async Task<JsonNode> AngularAsync()
    {
        await Surface.GetByRole(AriaRole.Button, new() { NameRegex = new Regex(@"^Change theme\. Current theme:") }).ClickAsync();
        await Role(AriaRole.Menuitemradio, "Set dark theme").ClickAsync();
        await Wait("document.querySelector('button[aria-label^=\"Change theme. Current theme:\"]')?.getAttribute('aria-label')==='Change theme. Current theme: dark'");
        await MarkNavigation(); await Surface.Locator("a[href='essentials/components']:visible").First.ClickAsync();
        await Wait("location.pathname==='/essentials/components'&&document.querySelector('h1')?.textContent.trim()==='Components'");
        await Back(); await Wait("location.pathname==='/overview'&&document.querySelector('h1')?.textContent.trim()==='What is Angular?'");
        await Forward(); await Wait("location.pathname==='/essentials/components'&&document.querySelector('h1')?.textContent.trim()==='Components'"); await CheckNavigation();
        return await Result("({path:location.pathname,heading:document.querySelector('h1').textContent.trim(),clientNavigation:window.liveNavigationMarker==='persisted',theme:document.querySelector('button[aria-label^=\"Change theme. Current theme:\"]').getAttribute('aria-label')})");
    }
    private async Task<JsonNode> SvelteAsync()
    {
        await Wait("(()=>{const b=document.querySelector('button[aria-label=\"Toggle dark mode\"]');return !!b&&Reflect.ownKeys(b).some(key=>typeof key==='symbol'&&typeof b[key]?.click==='function');})()");
        var button = Surface.Locator("button[aria-label='Toggle dark mode']:visible").First;
        var pressed = await button.GetAttributeAsync("aria-pressed"); await button.ClickAsync();
        await Wait("Array.from(document.querySelectorAll('button[aria-label=\"Toggle dark mode\"]')).some(b=>b.getAttribute('aria-pressed')!==" + Js(pressed) + ")");
        await MarkNavigation(); await Surface.Locator("a[href='/docs/svelte/getting-started']:visible").First.ClickAsync();
        await Wait("location.pathname==='/docs/svelte/getting-started'&&document.querySelector('h1')?.textContent.trim()==='Getting started'");
        await Surface.GetByPlaceholder("Search", new() { Exact = true }).FillAsync("onMount");
        await Surface.Locator("a[href='/docs/svelte/lifecycle-hooks#onMount']:visible").First.ClickAsync();
        const string arrived = "location.pathname==='/docs/svelte/lifecycle-hooks'&&location.hash==='#onMount'&&document.querySelector('h1')?.textContent.trim()==='Lifecycle hooks'";
        await Wait(arrived); await Back(); await Wait("location.pathname==='/docs/svelte/getting-started'&&document.querySelector('h1')?.textContent.trim()==='Getting started'");
        await Forward(); await Wait(arrived); await CheckNavigation();
        return await Result("({path:location.pathname,hash:location.hash,title:document.title,heading:document.querySelector('h1').textContent.trim(),clientNavigation:window.liveNavigationMarker==='persisted',theme:document.querySelector('button[aria-label=\"Toggle dark mode\"]').getAttribute('aria-pressed')})");
    }
    private async Task<JsonNode> VueAsync()
    {
        await Wait("!!document.getElementById('app')?.__vue_app__");
        await Role(AriaRole.Button, "Count is: 0").ClickAsync(); await Role(AriaRole.Button, "Count is: 1").WaitForAsync();
        var counter = (await Role(AriaRole.Button, "Count is: 1").TextContentAsync())!.Trim();
        var dark = await Read<bool>("document.documentElement.classList.contains('dark')");
        await Surface.Locator("button[aria-label='Toggle dark mode']:visible").First.ClickAsync();
        await Wait("document.documentElement.classList.contains('dark')===" + Js(!dark)); await MarkNavigation();
        await Surface.Locator("a[href='/guide/essentials/reactivity-fundamentals.html']:visible").First.ClickAsync();
        await Wait("location.pathname==='/guide/essentials/reactivity-fundamentals.html'&&document.querySelector('h1')?.textContent.includes('Reactivity Fundamentals')"); await CheckNavigation();
        var result = (await Result("({path:location.pathname,heading:document.querySelector('h1').textContent.trim(),dark:document.documentElement.classList.contains('dark'),font:getComputedStyle(document.querySelector('h1')).fontFamily,fontSize:getComputedStyle(document.querySelector('h1')).fontSize,clientNavigation:window.liveNavigationMarker==='persisted'})")).AsObject();
        result["counter"] = counter; return result;
    }
    private async Task<JsonNode> ReactAsync()
    {
        await Surface.Locator("iframe").Last.ScrollIntoViewIfNeededAsync();
        var counter = Surface.Locator("iframe").Last.ContentFrame;
        await counter.GetByRole(AriaRole.Button, new() { Name = "Clicked 0 times", Exact = true }).First.ClickAsync(new() { Timeout = 25000 });
        await counter.GetByRole(AriaRole.Button, new() { Name = "Clicked 1 times", Exact = true }).First.WaitForAsync();
        var counters = await counter.Locator("button").AllTextContentsAsync(); await MarkNavigation();
        await Surface.Locator("a[href='/learn/installation']:visible").First.ClickAsync();
        await Wait("location.pathname==='/learn/installation'&&document.title.includes('Installation')"); await CheckNavigation();
        var result = (await Result("({path:location.pathname,title:document.title,clientNavigation:window.liveNavigationMarker==='persisted'})")).AsObject();
        result["counters"] = Json(counters); return result;
    }
    private async Task<JsonNode> GitHubAsync()
    {
        await Surface.Locator("a[href='/octocat/Hello-World/blob/master/README']:visible").First.ClickAsync();
        await Wait("location.pathname==='/octocat/Hello-World/blob/master/README'&&Array.from(document.links).some(link=>link.textContent.trim()==='Raw')&&document.body.innerText.includes('Hello World!')");
        return await Result("({path:location.pathname,title:document.title,file:document.body.innerText.includes('Hello World!')})");
    }
    private async Task<JsonNode> HackerNewsAsync()
    {
        await Surface.Locator(".pagetop a[href=newest]").First.ClickAsync(); await Wait("location.pathname==='/newest'&&document.querySelectorAll('tr.athing').length>0");
        return await Result("({path:location.pathname,stories:document.querySelectorAll('tr.athing').length})");
    }
    private async Task<JsonNode> MdnAsync()
    {
        await Surface.Locator("mdn-search-button button:visible").First.ClickAsync(); await Role(AriaRole.Combobox, "Search").FillAsync("fetch");
        var link = Surface.GetByRole(AriaRole.Option).Locator("a[href^='/en-US/docs/']").First;
        await link.WaitForAsync(); await link.ClickAsync(); await Wait("location.pathname!=='/en-US/docs/Web/JavaScript'&&!!document.querySelector('h1')");
        return await Result("({path:location.pathname,heading:document.querySelector('h1').textContent.trim()})");
    }
    private async Task<JsonNode> WikipediaAsync()
    {
        await Surface.Locator("#skin-client-pref-skin-theme-value-night").CheckAsync(); await Wait("document.documentElement.classList.contains('skin-theme-clientpref-night')");
        return await Result("({dark:document.documentElement.classList.contains('skin-theme-clientpref-night'),checked:document.getElementById('skin-client-pref-skin-theme-value-night').checked})");
    }
    private async Task<JsonNode> WikipediaSearchAsync()
    {
        await Wait("document.activeElement?.id==='searchInput'"); await Page.Keyboard.TypeAsync("Proxy server");
        Assert.Equal("Proxy server", await Read<string>("document.getElementById('searchInput').value"));
        await Wait("Array.from(document.querySelectorAll('.suggestion-title')).some(title=>title.textContent.trim()==='Proxy server')");
        await Page.Keyboard.PressAsync("Enter"); await Wait("location.hostname==='en.wikipedia.org'&&document.querySelector('h1')?.textContent.includes('Proxy server')");
        return await Result("({autofocus:true,typed:true,suggested:true,heading:document.querySelector('h1').textContent.trim(),path:location.pathname})");
    }
}
