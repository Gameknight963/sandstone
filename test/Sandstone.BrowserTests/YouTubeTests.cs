using System.Diagnostics;
using System.Text.Json.Nodes;
using Microsoft.Playwright.Xunit.v3;
using Sandstone.BrowserTests.Infrastructure;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests;

[Collection(RelayCollection.Name)]
[Trait("Category", "YouTube")]
[Trait("Category", "Live")]
public sealed class YouTubeTests(RelayServer relay, ITestOutputHelper output) : BrowserTest
{
    private const string VideoId = "aqz-KE-bpKQ";
    private const string State = """
        (()=>{const v=document.querySelector('video');return {url:location.href,title:document.title,text:document.body?.innerText.slice(0,500),video:v&&{time:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,paused:v.paused,ready:v.readyState,width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames,error:v.error&&{code:v.error.code,message:v.error.message}}};})()
        """;

    [LiveFact]
    public async Task PlaybackSupportsSearchPauseSeekAndResume()
    {
        var native = Environment.GetEnvironmentVariable("YOUTUBE_NATIVE") == "1";
        var usePublic = Environment.GetEnvironmentVariable("YOUTUBE_PUBLIC") == "1";
        var watchOnly = Environment.GetEnvironmentVariable("YOUTUBE_WATCH_ONLY") == "1";
        var timeout = int.Parse(Environment.GetEnvironmentVariable("YOUTUBE_TIMEOUT_MS") ?? "180000");
        var seek = double.Parse(Environment.GetEnvironmentVariable("YOUTUBE_SEEK_SECONDS") ?? "5", System.Globalization.CultureInfo.InvariantCulture);
        var transport = Environment.GetEnvironmentVariable("YOUTUBE_RELAY") ?? (usePublic ? "wss://wisp.mercurywork.shop/" : relay.Relay);
        var start = watchOnly ? "https://www.youtube.com/watch?v=" + VideoId : "https://www.youtube.com/results?search_query=Big+Buck+Bunny+60fps+4K+Blender";
        await using var session = await BrowserSession.CreateAsync(Browser, !native, native ? null : transport);
        var stage = "opening";
        var result = new JsonObject { ["engine"] = BrowserName, ["native"] = native, ["relay"] = native ? null : usePublic ? "public" : "configured/local" };
        async Task Phase(string name, Func<Task> action)
        {
            stage = name; output.WriteLine(name);
            await action().WaitAsync(TimeSpan.FromMilliseconds(timeout), TestContext.Current.CancellationToken);
        }
        async Task Until(Func<Task<bool>> predicate)
        {
            var progress = Stopwatch.StartNew();
            while (!await predicate())
            {
                if (progress.ElapsedMilliseconds > 15000)
                {
                    output.WriteLine(new JsonObject { ["stage"] = stage, ["waiting"] = true, ["state"] = await session.ReadAsync(State) }.ToJsonString()); progress.Restart();
                }
                await Task.Delay(300, TestContext.Current.CancellationToken);
            }
        }
        try
        {
            await Phase("opening", () => session.NavigateAsync(start, timeout));
            if (!watchOnly)
            {
                await Phase("search result navigation", async () =>
                {
                    await session.Surface.Locator("a[href*='/watch?v=" + VideoId + "']:visible").First.ClickAsync(new() { Timeout = timeout });
                    await Until(() => session.ReadAsync<bool>("location.pathname==='/watch'&&new URLSearchParams(location.search).get('v')===" + Js(VideoId)));
                });
            }
            await Phase("starting playback", async () =>
            {
                await session.Surface.Locator("video").WaitForAsync(new() { State = WaitForSelectorState.Attached, Timeout = timeout });
                await session.ExecuteAsync("document.querySelector('video').muted=true;true");
                await Until(async () =>
                {
                    var state = await session.ReadAsync(State);
                    if (state?["video"]?["error"] is { } error) throw new InvalidOperationException("Media error: " + error);
                    if (state?["text"]?.GetValue<string>().Contains("Sign in to confirm") == true)
                    {
                        result["status"] = "blocked"; Assert.Skip("YouTube requires sign-in through this relay.");
                    }
                    if (state?["video"] is { } video && video["time"]!.GetValue<double>() > .25 && !video["paused"]!.GetValue<bool>() && video["width"]!.GetValue<int>() > 0 && video["frames"]!.GetValue<int>() > 0) return true;
                    var button = session.Surface.Locator(".ytp-play-button");
                    var label = await button.GetAttributeAsync("aria-label") ?? await button.GetAttributeAsync("title") ?? "";
                    if (System.Text.RegularExpressions.Regex.IsMatch(label, @"^Play\b")) await button.ClickAsync(new() { Timeout = timeout });
                    return false;
                });
            });
            var playing = await session.ReadAsync(State);
            await Phase("pausing", async () =>
            {
                await session.Surface.Locator(".ytp-play-button").ClickAsync(new() { Timeout = timeout });
                await Until(() => session.ReadAsync<bool>("document.querySelector('video').paused"));
            });
            var target = Math.Min(seek, playing!["video"]!["duration"]!.GetValue<double>() / 2);
            await Phase("seeking and resuming", async () =>
            {
                await session.ExecuteAsync("document.querySelector('video').currentTime=" + Js(target) + ";true");
                await session.Surface.Locator(".ytp-play-button").ClickAsync(new() { Timeout = timeout });
                await Until(async () =>
                {
                    var state = await session.ReadAsync(State); var video = state!["video"]!;
                    if (video["error"] is { } error) throw new InvalidOperationException("Media error: " + error);
                    return video["time"]!.GetValue<double>() > target + .25 && !video["paused"]!.GetValue<bool>() && video["frames"]!.GetValue<int>() > 0;
                });
            });
            Assert.Empty(session.DirectHttp);
            result["status"] = "passed"; result["searched"] = !watchOnly; result["played"] = true; result["paused"] = true;
            result["seekTarget"] = target; result["seeked"] = true; result["resumed"] = true; result["video"] = (await session.ReadAsync(State))!["video"]!.DeepClone();
        }
        catch (Exception error)
        {
            result["status"] ??= "failed"; result["stage"] = stage; result["error"] = error.Message;
            try { result["state"] = await session.ReadAsync(State).WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
            throw;
        }
        finally
        {
            result["scriptErrors"] = Json(session.Errors.ToArray()); result["directHTTP"] = Json(session.DirectHttp.ToArray());
            if (!native) try { result["requests"] = await session.Page.EvaluateJsonAsync("() => workflowRequests").WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
            var directory = Path.Combine(Root, ".temp", "browser-results", BrowserName); Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(Path.Combine(directory, "youtube-" + (native ? "native" : usePublic ? "public" : "local") + ".json"), result.ToJsonString(new() { WriteIndented = true }));
            output.WriteLine(result.ToJsonString());
        }
    }
}
