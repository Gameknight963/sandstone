using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Playwright.Xunit.v3;
using Sandstone.BrowserTests.Infrastructure;
using static Sandstone.BrowserTests.Infrastructure.Repository;

namespace Sandstone.BrowserTests;

[Trait("Category", "WebRTC")]
public sealed class WebRtcTests : BrowserTest
{
    private const string Url = "https://webrtc-setting.test/page";
    private static string Child(string id) => "<!doctype html><script>parent.postMessage({rtcChild:" + Js(id) + ",type:typeof RTCPeerConnection},'*');</script>";
    private static readonly string Html = """
        <!doctype html><title>WebRTC setting</title><script>
        globalThis.rtcChildren={};addEventListener('message',event=>{if(event.data?.rtcChild)rtcChildren[event.data.rtcChild]=event.data.type;});
        </script><iframe src="/child"></iframe><iframe src="https://webrtc-child.test/child"></iframe>
        """ + "<iframe srcdoc=\"" + WebUtility.HtmlEncode(Child("srcdoc")) + "\"></iframe><iframe id=\"blank\"></iframe>";

    private static async Task InstallAsync(BrowserSession session)
    {
        await session.Page.EvaluateAsync("""
            ({html,same,cross})=>{
              sandstone.network.session.fetch=async input=>new Response(new URL(input).pathname==='/page'?html:new URL(input).hostname==='webrtc-setting.test'?same:cross,{headers:{'content-type':'text/html'}});
              main_frame.on_load=()=>{};
            }
            """, new { html = Html, same = Child("same"), cross = Child("cross") });
        await session.NavigateAsync(Url);
    }
    private static async Task InspectAsync(BrowserSession session, bool allowed)
    {
        await session.WaitAsync("Object.keys(globalThis.rtcChildren||{}).length===3");
        var type = allowed ? "function" : "undefined";
        var actual = await session.ReadAsync("({type:typeof RTCPeerConnection,self:typeof self.RTCPeerConnection,window:typeof window.RTCPeerConnection,children:rtcChildren,blank:typeof document.getElementById('blank').contentWindow.RTCPeerConnection,other:typeof WebTransport})");
        EqualJson(Json(new { type, self = type, window = type, children = new { same = type, cross = type, srcdoc = type }, blank = type, other = "undefined" }), actual);
    }
    private static async Task ToggleAsync(BrowserSession session, bool allowed)
    {
        var previous = await session.Page.EvaluateAsync<string>("() => main_frame.document_context");
        await session.Page.Locator("#allow_webrtc_input").SetCheckedAsync(allowed);
        await session.Page.WaitForFunctionAsync("previous => main_frame.document_context!==previous && !main_frame.is_navigating", previous);
        await InspectAsync(session, allowed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OptInSupportsDataChannelsAndCanBeDisabled(bool storageDenied)
    {
        await using var session = await BrowserSession.CreateAsync(Browser, true, deniedStorage: storageDenied);
        Assert.False(await session.Page.Locator("#allow_webrtc_input").IsCheckedAsync());
        await InstallAsync(session); await InspectAsync(session, false);
        await session.Page.Locator("#options_button").ClickAsync();
        await ToggleAsync(session, true);
        var exchange = await File.ReadAllTextAsync(Path.Combine(Root, "test", "fixtures", "webrtc-exchange.js"), TestContext.Current.CancellationToken);
        await using var native = await BrowserSession.CreateAsync(Browser, false);
        var expected = JsonNode.Parse((await native.EvaluateAsync(exchange))!);
        EqualJson(Json(new { data = "pong", typed = true, open = true }), expected);
        EqualJson(expected, JsonNode.Parse((await session.EvaluateAsync(exchange))!));
        await ToggleAsync(session, false);
        Assert.Empty(session.DirectHttp);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PreferenceSurvivesReloadWhenStorageIsAvailable(bool storageDenied)
    {
        await using var session = await BrowserSession.CreateAsync(Browser, true, deniedStorage: storageDenied);
        await InstallAsync(session);
        await session.Page.Locator("#options_button").ClickAsync(); await ToggleAsync(session, true);
        await session.Page.ReloadAsync(); await session.ReadyAsync();
        Assert.Equal(!storageDenied, await session.Page.Locator("#allow_webrtc_input").IsCheckedAsync());
        await InstallAsync(session); await InspectAsync(session, !storageDenied);
        Assert.Empty(session.DirectHttp);
    }

    [Fact]
    public async Task PerSiteBlockAppliesToNestedFrames()
    {
        await using var session = await BrowserSession.CreateAsync(Browser, true);
        await session.Page.EvaluateAsync("() => {main_frame.default_settings.allow_webrtc=true;main_frame.site_settings=[{hostname:/^webrtc-setting\\.test$/,allow_webrtc:false}];}");
        await InstallAsync(session); await InspectAsync(session, false);
        await session.Page.EvaluateAsync("() => {main_frame.site_settings=[];}");
        await session.NavigateAsync(Url); await InspectAsync(session, true);
        Assert.Empty(session.DirectHttp);
    }
}
