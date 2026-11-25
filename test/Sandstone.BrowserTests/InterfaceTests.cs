using Microsoft.Playwright.Xunit.v3;
using Sandstone.BrowserTests.Infrastructure;

namespace Sandstone.BrowserTests;

public sealed class InterfaceTests : BrowserTest
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task StoredSiteDataCanBeClearedFromOptions(bool storageDenied)
    {
        await using var session = await BrowserSession.CreateAsync(Browser, true, deniedStorage: storageDenied);
        var page = session.Page;
        await page.EvaluateAsync("""
            async()=>{
              main_frame.on_load=()=>{};
              main_frame.special_pages['https://inactive.test/']='<!doctype html><body>Site data fixture';
              await main_frame.navigate_to('https://inactive.test/');
            }
            """);
        await session.ExecuteAsync("""
            new Promise((resolve,reject)=>{const request=indexedDB.open('discard');request.onupgradeneeded=()=>request.result.createObjectStore('items');request.onsuccess=()=>{request.result.close();resolve(true)};request.onerror=()=>reject(request.error);})
            """);
        await page.EvaluateAsync("""
            async()=>{
              const data=sandstone.controller.site_data;
              data.setCookie('https://inactive.test/','saved=1; Path=/');data.setLocal('https://inactive.test',[['key','value']]);
              main_frame.special_pages['https://elsewhere.test/']='<!doctype html><body>Different site';
              await main_frame.navigate_to('https://elsewhere.test/');
            }
            """);
        await page.GetByRole(AriaRole.Button, new() { Name = "Options", Exact = true }).ClickAsync();
        await page.Locator("#site_data_details summary").ClickAsync();
        var row = page.Locator(".site_data_row").Filter(new() { HasText = "inactive.test" });
        await row.GetByRole(AriaRole.Button, new() { Name = "Clear IndexedDB", Exact = true }).ClickAsync();
        await page.WaitForFunctionAsync("() => sandstone.controller.site_data.list().find(site=>site.hostname==='inactive.test')?.indexedDB===0");
        Assert.Equal(0, await page.EvaluateAsync<int>("() => sandstone.controller.indexed_db.databases('https://inactive.test').length"));
        await row.GetByRole(AriaRole.Button, new() { Name = "Clear all", Exact = true }).ClickAsync();
        await page.WaitForFunctionAsync("() => !sandstone.controller.site_data.list().some(site=>site.hostname==='inactive.test')");
        Assert.Empty(session.Errors); Assert.Empty(session.DirectHttp);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ThemeAndControlsWorkWithoutPersistentStorage(bool storageDenied)
    {
        await using var session = await BrowserSession.CreateAsync(Browser, true, deniedStorage: storageDenied);
        var page = session.Page;
        await page.Locator("#options_button").ClickAsync();
        await page.Locator("#theme_select").SelectOptionAsync("dark");
        Assert.Equal("dark", await page.Locator("html").GetAttributeAsync("data-theme"));
        await page.Locator("#close_options_button").ClickAsync();
        await page.Locator("#hide_ui_button").ClickAsync();
        Assert.False(await page.Locator("#address_bar").IsVisibleAsync());
        Assert.True(await page.Locator("#show_ui_button").IsVisibleAsync());
        await page.Locator("#show_ui_button").ClickAsync();
        Assert.True(await page.Locator("#address_bar").IsVisibleAsync());
        await page.ReloadAsync(); await session.ReadyAsync();
        Assert.Equal(storageDenied ? null : "dark", await page.Locator("html").GetAttributeAsync("data-theme"));
        Assert.Empty(session.Errors); Assert.Empty(session.DirectHttp);
    }
}
