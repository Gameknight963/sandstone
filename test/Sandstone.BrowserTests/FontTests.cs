using Microsoft.Playwright.Xunit.v3;
using Sandstone.TestFixtures;
using System.Text.Json.Nodes;

namespace Sandstone.BrowserTests;

public sealed class FontTests(FontFixture font) : BrowserTest, IClassFixture<FontFixture>
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task GeneratedFontHasSquareGlyphsAndPredictableAdvances(bool proxied)
    {
        await using var session = await BrowserSession.CreateAsync(Browser, proxied);
        var bytes = font.Bytes.ToArray().Select(value => (int)value).ToArray();
        if (proxied)
        {
            await session.Page.EvaluateAsync("""
                bytes=>{
                  const previous=sandstone.network.session.fetch;
                  sandstone.network.session.fetch=async(url,...args)=>String(url)==='https://font-fixture.test/font.ttf'
                    ?new Response(new Uint8Array(bytes),{headers:{'content-type':'font/ttf'}}):previous.call(sandstone.network.session,url,...args);
                  main_frame.special_pages['https://font-fixture.test/']='<!doctype html><style>@font-face{font-family:FixtureFont;src:url(font.ttf)}</style><body>Generated font';
                }
                """, bytes);
            await session.NavigateAsync("https://font-fixture.test/");
        }
        else
        {
            await session.Page.GotoAsync("about:blank");
            await session.Page.EvaluateAsync("""
                async bytes=>{const face=new FontFace('FixtureFont',new Uint8Array(bytes));await face.load();document.fonts.add(face);}
                """, bytes);
        }
        var json = await session.EvaluateAsync("""
            (async()=>{
              const faces=await document.fonts.load('20px FixtureFont','AAA');
              const canvas=document.createElement('canvas');canvas.width=100;canvas.height=30;
              const context=canvas.getContext('2d');context.font='20px FixtureFont';
              const widths=['AAA','III','   '].map(text=>context.measureText(text).width);
              const ink=text=>{context.clearRect(0,0,100,30);context.fillText(text,0,20);return context.getImageData(0,0,100,30).data.some((value,index)=>index%4===3&&value!==0);};
              return JSON.stringify({count:faces.length,status:faces[0]?.status,widths,square:ink('A'),space:ink(' ')});
            })()
            """);
        var result = JsonNode.Parse(json!);
        Assert.Equal(1, result!["count"]!.GetValue<int>());
        Assert.Equal("loaded", result["status"]!.GetValue<string>());
        foreach (var width in result["widths"]!.AsArray()) Assert.InRange(Math.Abs(width!.GetValue<double>() - 60), 0, 0.001);
        Assert.True(result["square"]!.GetValue<bool>());
        Assert.False(result["space"]!.GetValue<bool>());
        Assert.Empty(session.DirectHttp); Assert.Empty(session.Errors);
    }
}
