using System.Text.Json;
using System.Text.Json.Nodes;
using System.Runtime.CompilerServices;

namespace Sandstone.BrowserTests.Infrastructure;

internal static class Repository
{
    public static string Root { get; } = FindRoot();
    public static string Artifact => Environment.GetEnvironmentVariable("BROWSER_TEST_URL")
        ?? new Uri(Path.Combine(Root, "example", "bundled.html")).AbsoluteUri;
    public static bool DeniedStorage => Environment.GetEnvironmentVariable("LIVE_STORAGE_DENIED") == "1";
    public static bool Isolated => Environment.GetEnvironmentVariable("LIVE_ISOLATED") == "1";
    public static bool LiveEnabled => Environment.GetEnvironmentVariable("SANDSTONE_LIVE") == "1";
    public static string Js(object? value) => JsonSerializer.Serialize(value);
    public static JsonNode Json(object value) => JsonSerializer.SerializeToNode(value)!;
    public static void EqualJson(JsonNode? expected, JsonNode? actual) =>
        Assert.True(JsonNode.DeepEquals(expected, actual), $"Expected: {expected}\nActual: {actual}");
    private static string FindRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "package.json")) && Directory.Exists(Path.Combine(directory.FullName, "src", "host")))
                return directory.FullName;
        throw new DirectoryNotFoundException("Run the browser tests from a Sandstone checkout.");
    }
}

public sealed class LiveTheoryAttribute : TheoryAttribute
{
    public LiveTheoryAttribute([CallerFilePath] string? sourceFilePath = null, [CallerLineNumber] int sourceLineNumber = 0) : base(sourceFilePath, sourceLineNumber)
    {
        if (!Repository.LiveEnabled) Skip = "Public-site tests are opt-in: set SANDSTONE_LIVE=1.";
    }
}

public sealed class LiveFactAttribute : FactAttribute
{
    public LiveFactAttribute([CallerFilePath] string? sourceFilePath = null, [CallerLineNumber] int sourceLineNumber = 0) : base(sourceFilePath, sourceLineNumber)
    {
        if (!Repository.LiveEnabled) Skip = "Public-site tests are opt-in: set SANDSTONE_LIVE=1.";
    }
}
