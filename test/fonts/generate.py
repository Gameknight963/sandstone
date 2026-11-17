"""Regenerate fixture.ttf with fontTools; this original test font has square glyphs."""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

font = FontBuilder(1000, isTTF=True)
font.setupGlyphOrder(['.notdef', 'space', 'square'])
font.setupCharacterMap({code: 'space' if code == 32 else 'square' for code in range(32, 127)})
glyphs = {}
for name in ['.notdef', 'space', 'square']:
    pen = TTGlyphPen(None)
    if name != 'space':
        pen.moveTo((0, 0))
        pen.lineTo((800, 0))
        pen.lineTo((800, 800))
        pen.lineTo((0, 800))
        pen.closePath()
    glyphs[name] = pen.glyph()
font.setupGlyf(glyphs)
font.setupHorizontalMetrics({name: (1000, 0) for name in glyphs})
font.setupHorizontalHeader(ascent=800, descent=-200)
font.setupNameTable({'familyName':'Sandstone Test', 'styleName':'Regular',
                    'uniqueFontIdentifier':'SandstoneTest-Regular',
                    'fullName':'Sandstone Test Regular', 'psName':'SandstoneTest-Regular'})
font.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
font.setupPost()
font.setupMaxp()
font.font['head'].created = font.font['head'].modified = 2082844800
font.font.recalcTimestamp = False
font.save(Path(__file__).with_name('fixture.ttf'))
