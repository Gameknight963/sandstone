using System.Text.Json.Nodes;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests.Workflows;

internal sealed partial class SiteWorkflows
{
    private async Task<JsonNode> XtypeAsync()
    {
        await Wait("!!globalThis.ig?.system?.running&&ig.system.delegate===ig.game&&!!ig.game?.menu");
        var canvas = Surface.Locator("#canvas");
        async Task Menu(string text)
        {
            var item = await Read("(()=>{const m=ig.game.menu,index=m.items.findIndex(item=>item.getText()===" + Js(text) + ");return {index,x:ig.system.width/2,y:m.y+index*(m.font.height+20)+m.font.height/2,width:ig.system.width,height:ig.system.height};})()");
            Assert.True(item!["index"]!.GetValue<int>() >= 0, "Missing game menu item: " + text);
            var box = await canvas.BoundingBoxAsync(); Assert.NotNull(box);
            await canvas.ClickAsync(new() { Position = new() { X = item["x"]!.GetValue<float>() / item["width"]!.GetValue<float>() * box.Width, Y = item["y"]!.GetValue<float>() / item["height"]!.GetValue<float>() * box.Height } });
        }
        await Menu("Start Game!"); await Wait("ig.game.mode===1&&!ig.game.menu&&ig.game.player?.pos.y<ig.system.height-60");
        var before = await Read<double>("ig.game.player.pos.x");
        await Page.Keyboard.DownAsync("ArrowRight"); try { await Wait("ig.game.player.pos.x>" + Js(before + 15)); } finally { await Page.Keyboard.UpAsync("ArrowRight"); }
        var right = await Read<double>("ig.game.player.pos.x");
        await Page.Keyboard.DownAsync("ArrowLeft"); try { await Wait("ig.game.player.pos.x<" + Js(right - 15)); } finally { await Page.Keyboard.UpAsync("ArrowLeft"); }
        var box = await canvas.BoundingBoxAsync(); Assert.NotNull(box);
        await Page.Mouse.MoveAsync(box.X + box.Width / 2, box.Y + box.Height / 4); await Page.Mouse.DownAsync();
        try
        {
            await Wait("ig.game.entities.some(entity=>entity instanceof EntityPlasma)");
            await Wait("ig.game.player.soundShoot.currentClip&&!ig.game.player.soundShoot.currentClip.paused");
        }
        finally { await Page.Mouse.UpAsync(); }
        await Page.Keyboard.PressAsync("Escape"); await Wait("!!ig.game.menu"); var paused = await Read("({x:ig.game.player.pos.x,y:ig.game.player.pos.y})");
        await Page.Keyboard.DownAsync("ArrowRight");
        try { await Task.Delay(200); EqualJson(paused, await Read("({x:ig.game.player.pos.x,y:ig.game.player.pos.y})")); }
        finally { await Page.Keyboard.UpAsync("ArrowRight"); }
        await Menu("Resume"); await Wait("!ig.game.menu&&ig.game.mode===1");
        return Json(new { started = true, movedRight = true, movedLeft = true, shot = true, audioPlayed = true, paused = true, resumed = true });
    }
    private async Task<JsonNode> SwooopAsync()
    {
        await Surface.Locator("iframe").First.WaitForAsync(); var gameSurface = Surface.FrameLocator("iframe");
        static string Child(string source) => "document.querySelector('iframe').contentWindow.eval(" + Js(source) + ")";
        const string game = "pc.Application.getApplication().root.findByName('Game').script.game";
        await Wait(Child("!!globalThis.pc?.Application?.getApplication()?.root.findByName('Game')?.script?.game?.player"));
        await gameSurface.Locator("#application-canvas").ClickAsync(new() { Position = new() { X = 20, Y = 20 } });
        await Page.Keyboard.PressAsync("Enter", new() { Delay = 100 });
        await Wait(Child(game + ".paused===false&&" + game + ".player.entity.enabled===true"));
        var initial = await Read(Child("(()=>{const game=" + game + ";return {fuel:game.fuel,position:Array.from(game.player.entity.getPosition().data)};})()"));
        await Page.Keyboard.DownAsync("Space");
        try
        {
            await Wait(Child(game + ".player.fly===true&&" + game + ".fuel<" + initial!["fuel"]));
            await Wait(Child("Array.from(" + game + ".player.entity.getPosition().data).some((value,index)=>Math.abs(value-" + initial!["position"]!.ToJsonString() + "[index])>0.1)"));
        }
        finally { await Page.Keyboard.UpAsync("Space"); }
        await Wait(Child(game + ".player.fly===false"));
        var webgl = await Read<bool>(Child("(()=>{const gl=pc.Application.getApplication().graphicsDevice.gl;return !!gl&&!gl.isContextLost()&&gl.drawingBufferWidth>0&&gl.drawingBufferHeight>0;})()"));
        Assert.True(webgl); return Json(new { started = true, flightInput = true, moved = true, consumedFuel = true, released = true, webgl });
    }
}
