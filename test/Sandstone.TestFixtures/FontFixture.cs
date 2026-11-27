using System.Buffers.Binary;
using System.Text;

namespace Sandstone.TestFixtures;

// A deliberately tiny TrueType font: printable ASCII has a one-em advance;
// every non-space character is the same 800-unit square. No files or packages.
// Table layout/checksums: https://learn.microsoft.com/typography/opentype/spec/otff
public sealed class FontFixture
{
    public ReadOnlyMemory<byte> Bytes { get; } = Create();

    private static byte[] Create()
    {
        var square = new BigEndian().U16(1).U16(0).U16(0).U16(800).U16(800)
            .U16(3).U16(0).Bytes([1, 1, 1, 1]); // contour end, no hints, on-curve points
        foreach (var delta in new[] { 0, 800, 0, -800, 0, 0, 800, 0 }) square.U16(delta);
        var glyph = square.ToArray();
        var metrics = new BigEndian();
        for (var i = 0; i < 3; i++) metrics.U16(1000).U16(0);
        var profile = new BigEndian().U32(0x00010000).U16(3);
        foreach (var value in new[] { 4, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0 }) profile.U16(value);

        var tables = new SortedDictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["OS/2"] = Os2(),
            ["cmap"] = CharacterMap(),
            ["glyf"] = new BigEndian().Bytes(glyph).Bytes(glyph).ToArray(),
            ["head"] = new BigEndian().U32(0x00010000).U32(0x00010000).U32(0).U32(0x5f0f3cf5)
                .U16(3).U16(1000).U32(0).U32(2082844800).U32(0).U32(2082844800)
                .U16(0).U16(0).U16(800).U16(800).U16(0).U16(3).U16(2).U16(0).U16(0).ToArray(),
            ["hhea"] = new BigEndian().U32(0x00010000).U16(800).U16(-200).U16(0)
                .U16(1000).U16(0).U16(200).U16(800).U16(1).U16(0).U16(0)
                .U16(0).U16(0).U16(0).U16(0).U16(0).U16(3).ToArray(),
            ["hmtx"] = metrics.ToArray(),
            ["loca"] = new BigEndian().U16(0).U16(glyph.Length / 2).U16(glyph.Length / 2).U16(glyph.Length).ToArray(),
            ["maxp"] = profile.ToArray(),
            ["name"] = Names(),
            ["post"] = new BigEndian().U32(0x00030000).U32(0).U16(-100).U16(50)
                .U32(1).U32(0).U32(0).U32(0).U32(0).ToArray()
        };
        var offset = 12 + tables.Count * 16;
        var directory = new BigEndian().U32(0x00010000).U16(tables.Count).U16(128).U16(3).U16(32);
        var locations = new Dictionary<string, int>();
        foreach (var (tag, data) in tables)
        {
            locations[tag] = offset;
            directory.Bytes(Encoding.ASCII.GetBytes(tag)).U32(Checksum(data)).U32((uint)offset).U32((uint)data.Length);
            offset += (data.Length + 3) & ~3;
        }
        var font = new byte[offset];
        directory.ToArray().CopyTo(font, 0);
        foreach (var (tag, data) in tables) data.CopyTo(font, locations[tag]);
        // Directory checksum for head uses zero adjustment; the full font sums
        // to the OpenType constant after this final write.
        BinaryPrimitives.WriteUInt32BigEndian(font.AsSpan(locations["head"] + 8), unchecked(0xb1b0afba - Checksum(font)));
        return font;
    }

    private static byte[] CharacterMap()
    {
        // Format 4: space -> glyph 1, ASCII 33..126 -> glyph 2, sentinel -> 0.
        var map = new BigEndian().U16(4).U16(228).U16(0).U16(6).U16(4).U16(1).U16(2)
            .U16(32).U16(126).U16(0xffff).U16(0)
            .U16(32).U16(33).U16(0xffff)
            .U16(-31).U16(0).U16(1)
            .U16(0).U16(4).U16(0);
        for (var code = 33; code <= 126; code++) map.U16(2);
        return new BigEndian().U16(0).U16(1).U16(3).U16(1).U32(12).Bytes(map.ToArray()).ToArray();
    }

    private static byte[] Os2() => new BigEndian().U16(0).U16(1000).U16(400).U16(5).U16(0)
        .U16(650).U16(600).U16(0).U16(75).U16(650).U16(600).U16(0).U16(350)
        .U16(50).U16(300).U16(0).Bytes(new byte[10]).U32(1).U32(0).U32(0).U32(0)
        .Bytes("SAND"u8).U16(0x40).U16(32).U16(126).U16(800).U16(-200).U16(0).U16(800).U16(200).ToArray();

    private static byte[] Names()
    {
        string[] names = ["Sandstone Test", "Regular", "SandstoneTest-Regular", "Sandstone Test Regular", "Version 1.0", "SandstoneTest-Regular"];
        var directory = new BigEndian().U16(0).U16(names.Length).U16(6 + names.Length * 12);
        var strings = new BigEndian(); var offset = 0;
        for (var i = 0; i < names.Length; i++)
        {
            var value = Encoding.BigEndianUnicode.GetBytes(names[i]);
            directory.U16(3).U16(1).U16(0x409).U16(i + 1).U16(value.Length).U16(offset);
            strings.Bytes(value); offset += value.Length;
        }
        return directory.Bytes(strings.ToArray()).ToArray();
    }

    private static uint Checksum(ReadOnlySpan<byte> data)
    {
        uint sum = 0;
        for (var i = 0; i < data.Length; i += 4)
        {
            uint word = 0;
            for (var j = 0; j < 4; j++) word = (word << 8) | (i + j < data.Length ? data[i + j] : 0u);
            sum = unchecked(sum + word);
        }
        return sum;
    }

    private sealed class BigEndian
    {
        private readonly List<byte> data = [];
        public BigEndian U16(int value) { data.Add(unchecked((byte)(value >> 8))); data.Add(unchecked((byte)value)); return this; }
        public BigEndian U32(uint value) { U16((int)(value >> 16)); U16((int)(value & 0xffff)); return this; }
        public BigEndian Bytes(ReadOnlySpan<byte> value) { foreach (var item in value) data.Add(item); return this; }
        public byte[] ToArray() => data.ToArray();
    }
}
