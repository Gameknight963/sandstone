using Sandstone.TestFixtures;

if (args is not ["--font"])
{
    Console.Error.WriteLine("Usage: Sandstone.TestFixtures --font (writes TrueType bytes to stdout)");
    return 2;
}
Console.OpenStandardOutput().Write(new FontFixture().Bytes.Span);
return 0;
