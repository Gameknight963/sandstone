using System.Text.Json.Nodes;

namespace Sandstone.BrowserTests.Infrastructure;

internal static class BrowserJson
{
    // Keep ordinary JSON separate from Playwright's richer value transport
    // (object aliases, undefined, handles, etc.). No eval or Node bridge needed.
    public static async Task<JsonNode> EvaluateJsonAsync(this IPage page, string expression, object? argument = null)
    {
        var json = await page.EvaluateAsync<string>("async argument => JSON.stringify(await (" + expression + ")(argument))", argument);
        return JsonNode.Parse(json)!;
    }
}
