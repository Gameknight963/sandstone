// Experimental port of src/frame/css.mjs. Not used by the production bundle.
// UTF-16 keeps JS offsets and even unpaired surrogates intact. No DOM/JS calls.
#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

using Text = std::u16string;
using View = std::u16string_view;
using U = uint32_t;
struct Ref {
  U start, end;
  Text url;
  bool imported = false, quoted = false, font = false;
  U ending = 0; // quote, parenthesis, string, unquoted
  Text trailing, condition;
  U condition_start = 0, condition_end = 0;
  bool has_condition = false;
};
struct Edit { U start, end; Text value; };
static std::vector<char16_t> input;
static std::vector<U> records, edits, markers;
static Text arena, css;
static U header[10];
static char16_t at(View s, size_t i) { return i < s.size() ? s[i] : 0; }
static bool space(char16_t c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'; }
static bool hex(char16_t c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
static U digit(char16_t c) { return c <= '9' ? c - '0' : (c | 32) - 'a' + 10; }
static bool name(char16_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c >= 0x80; }
static size_t escape_end(View s, size_t i) {
  ++i;
  if (hex(at(s, i))) {
    int count = 0;
    while (count++ < 6 && hex(at(s, i))) ++i;
    if (at(s, i) == '\r' && at(s, i + 1) == '\n') return i + 2;
    return i + space(at(s, i));
  }
  return i + (at(s, i) == '\r' && at(s, i + 1) == '\n' ? 2 : 1);
}
static View slice(View s, size_t a, size_t b) {
  a = std::min(a, s.size()); b = std::min(b, s.size());
  return s.substr(a, b > a ? b - a : 0);
}
static Text decode(View s) {
  Text out; out.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    if (s[i] != '\\' || i + 1 == s.size()) { out += s[i++]; continue; }
    ++i;
    if (hex(s[i])) {
      U code = 0; int count = 0;
      while (i < s.size() && count++ < 6 && hex(s[i])) code = code * 16 + digit(s[i++]);
      if (at(s, i) == '\r' && at(s, i + 1) == '\n') i += 2;
      else if (space(at(s, i))) ++i;
      if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) out += u'\ufffd';
      else if (code <= 0xffff) out += char16_t(code);
      else { code -= 0x10000; out += char16_t(0xd800 + (code >> 10)); out += char16_t(0xdc00 + (code & 1023)); }
    } else if (s[i] == '\r' && at(s, i + 1) == '\n') i += 2;
    else if (s[i] == '\n' || s[i] == '\r' || s[i] == '\f') ++i;
    else out += s[i++];
  }
  return out;
}
static Text lower(Text text) { for (auto &c : text) if (c >= 'A' && c <= 'Z') c += 32; return text; }
static size_t string_end(View s, size_t i) {
  auto quote = s[i++];
  while (i < s.size()) {
    if (s[i] == quote) return i + 1;
    if (s[i] == '\n' || s[i] == '\r' || s[i] == '\f') return i;
    i = s[i] == '\\' ? escape_end(s, i) : i + 1;
  }
  return std::min(i, s.size());
}
static size_t skip_space(View s, size_t i) {
  while (i < s.size()) {
    if (space(s[i])) ++i;
    else if (s[i] == '/' && at(s, i + 1) == '*') {
      auto end = s.find(u"*/", i + 2); i = end == View::npos ? s.size() : end + 2;
    } else break;
  }
  return i;
}
static void supports(View s, size_t i, Ref &ref) {
  while (i < s.size()) {
    i = skip_space(s, i); auto start = i;
    while (name(at(s, i)) || at(s, i) == '\\') i = at(s, i) == '\\' ? escape_end(s, i) : i + 1;
    auto word = lower(decode(slice(s, start, i)));
    if (word != u"layer" && word != u"supports") return;
    if (at(s, i) != '(') { if (word == u"layer") continue; return; }
    auto content = ++i; int depth = 1;
    while (i < s.size() && depth) {
      auto next = skip_space(s, i);
      if (next != i) { i = next; continue; }
      if (s[i] == '"' || s[i] == '\'') { i = string_end(s, i); continue; }
      if (s[i] == '\\') { i = escape_end(s, i); continue; }
      if (s[i] == '(') ++depth;
      if (s[i] == ')') --depth;
      ++i;
    }
    if (depth) return;
    if (word == u"supports") {
      ref.has_condition = true; ref.condition = slice(s, content, i - 1);
      ref.condition_start = start; ref.condition_end = i; return;
    }
  }
}
static std::vector<Ref> scan(View s) {
  std::vector<Ref> refs;
  std::vector<Text> functions;
  std::vector<bool> blocks;
  bool font_block = false, imported = false, ns = false;
  Text descriptor;
  size_t i = 0;
  while (i < s.size()) {
    auto start = i; i = skip_space(s, i); if (i != start) continue;
    auto c = s[i];
    if (c == '"' || c == '\'') {
      auto end = string_end(s, i);
      bool image = !functions.empty() && (functions.back() == u"image-set" || functions.back() == u"-webkit-image-set");
      bool closed = at(s, end - 1) == c;
      if ((imported || image) && (closed || end == s.size())) {
        Ref ref{U(i), U(end), decode(slice(s, i + 1, closed ? end - 1 : end))};
        ref.imported = imported; ref.quoted = true; if (!closed) ref.ending = 1;
        if (imported) supports(s, end, ref);
        refs.push_back(std::move(ref));
      }
      imported = false; i = end; continue;
    }
    if (c == '@' || name(c) || c == '\\') {
      bool is_at = c == '@'; if (is_at) ++i; auto begin = i;
      while (name(at(s, i)) || at(s, i) == '\\') i = at(s, i) == '\\' ? escape_end(s, i) : i + 1;
      auto word = lower(decode(slice(s, begin, i)));
      if (is_at) { imported = word == u"import"; ns = word == u"namespace"; font_block = word == u"font-face"; continue; }
      if (!blocks.empty() && blocks.back() && at(s, skip_space(s, i)) == ':') descriptor = word;
      if (at(s, i) != '(') { imported = false; continue; }
      if (word != u"url") { functions.push_back(std::move(word)); ++i; imported = false; continue; }
      auto url_start = skip_space(s, i + 1), end = url_start;
      Text url, trailing; bool valid = false; U ending = 0;
      if (at(s, end) == '"' || at(s, end) == '\'') {
        auto string_start = end; end = string_end(s, end);
        bool closed = at(s, end - 1) == at(s, string_start);
        if (closed || end == s.size()) { url = decode(slice(s, string_start + 1, closed ? end - 1 : end)); valid = true; }
        end = skip_space(s, end);
        if (end == s.size()) ending = closed ? 2 : 3;
      } else {
        while (end < s.size() && s[end] != ')' && !space(s[end])) {
          if (s[end] == '\\') end = escape_end(s, end);
          else if (s[end] == '"' || s[end] == '\'' || s[end] == '(') break;
          else ++end;
        }
        url = decode(slice(s, url_start, end)); valid = true;
        auto token_end = end; end = skip_space(s, end);
        if (end >= s.size()) { ending = 4; trailing = slice(s, token_end, end); }
      }
      if (!ns && (at(s, end) == ')' || ending) && valid) {
        Ref ref{U(start), U(std::min(end + 1, s.size())), std::move(url)};
        ref.imported = imported; ref.font = !blocks.empty() && blocks.back() && descriptor == u"src";
        ref.ending = ending; ref.trailing = std::move(trailing);
        if (imported) supports(s, end + 1, ref);
        refs.push_back(std::move(ref));
      }
      imported = false; i = end + (at(s, end) == ')'); continue;
    }
    if (c == '(') functions.emplace_back();
    if (c == ')' && !functions.empty()) functions.pop_back();
    if (c == '{') { blocks.push_back(font_block); font_block = false; descriptor.clear(); }
    if (c == '}') { if (!blocks.empty()) blocks.pop_back(); font_block = false; descriptor.clear(); }
    if (c == ';') { ns = false; font_block = false; descriptor.clear(); }
    imported = false; ++i;
  }
  // Keep this separate, just like the JS scanner: nested URLs in supports()
  // are feature queries, not resource references.
  std::vector<std::pair<U, U>> conditions;
  for (auto &ref : refs) if (!ref.condition.empty()) conditions.emplace_back(ref.condition_start, ref.condition_end);
  std::erase_if(refs, [&](const Ref &ref) {
    return std::any_of(conditions.begin(), conditions.end(), [&](auto condition) { return ref.start >= condition.first && ref.end <= condition.second; });
  });
  return refs;
}
static void store(std::vector<U> &out, View value) {
  out.push_back(arena.size()); out.push_back(value.size()); arena.append(value);
}
static U ptr(const void *p) { return static_cast<U>(reinterpret_cast<uintptr_t>(p)); }
static U *finish() {
  header[0] = ptr(records.data()); header[1] = records.size() / 11;
  header[2] = ptr(arena.data()); header[3] = arena.size();
  header[4] = ptr(edits.data()); header[5] = edits.size() / 4;
  header[6] = ptr(css.data()); header[7] = css.size();
  header[8] = ptr(markers.data()); header[9] = markers.size() / 4;
  return header;
}
static void reset() { records.clear(); edits.clear(); markers.clear(); arena.clear(); css.clear(); }
static Text number(U value, U radix = 10) {
  Text out;
  do { out += u"0123456789abcdef"[value % radix]; value /= radix; } while (value);
  std::reverse(out.begin(), out.end()); return out;
}
static Text quote(View s) {
  Text out = u"\"";
  for (size_t i = 0; i < s.size(); ++i) {
    U c = s[i];
    if (c == '"' || c == '\\') { out += '\\'; out += char16_t(c); }
    else if (c == '\b') out += u"\\b";
    else if (c == '\t') out += u"\\t";
    else if (c == '\n') out += u"\\n";
    else if (c == '\f') out += u"\\f";
    else if (c == '\r') out += u"\\r";
    else if (c < 32 || (c >= 0xd800 && c <= 0xdbff && !(at(s, i + 1) >= 0xdc00 && at(s, i + 1) <= 0xdfff)) ||
             (c >= 0xdc00 && c <= 0xdfff && !(i && s[i - 1] >= 0xd800 && s[i - 1] <= 0xdbff))) {
      auto hex = number(c, 16); out += u"\\u"; out.append(4 - hex.size(), '0'); out += hex;
    } else out += char16_t(c);
  }
  out += '"'; return out;
}
static bool js_space(char16_t c) { return space(c) || c == '\v' || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff; }
static Text resource_token(const Ref &ref, const Text &url) {
  auto value = quote(url);
  if (ref.quoted) { if (ref.ending == 1) value.pop_back(); return value; }
  if (ref.ending == 4) {
    Text out = u"url(";
    for (auto c : url) if (js_space(c) || c == '"' || c == '\'' || c == '(' || c == ')' || c == '\\') { out += '\\'; out += number(c, 16); out += ' '; } else out += c;
    return out + ref.trailing;
  }
  if (ref.ending == 3) value.pop_back();
  return u"url(" + value + (ref.ending == 2 || ref.ending == 3 ? u"" : u")");
}
extern "C" {
U reserve_input(U units) { input.resize(units); return ptr(input.data()); }
U *scan_css(U length) {
  reset();
  for (auto &ref : scan(View(input.data(), length))) {
    records.push_back(ref.start); records.push_back(ref.end); store(records, ref.url);
    records.push_back(U(ref.imported) | U(ref.quoted) << 1 | U(ref.font) << 2 | ref.ending << 3 | U(ref.has_condition) << 6);
    records.push_back(ref.condition_start); records.push_back(ref.condition_end);
    store(records, ref.condition); store(records, ref.trailing);
  }
  return finish();
}
U *prepare_css(U length, U prefix_length) {
  reset(); View source(input.data(), length), prefix(input.data() + length, prefix_length);
  std::vector<Edit> replacements;
  for (auto &ref : scan(source)) {
    auto lower_url = lower(ref.url);
    if (ref.url.empty() || ref.url[0] == '#' || (!ref.imported && (lower_url.starts_with(u"data:") || lower_url.starts_with(u"blob:")))) continue;
    Text url = ref.imported ? u"data:text/css,/*" : u"data:application/octet-stream,";
    url += prefix; url += number(markers.size() / 4); if (ref.imported) url += u"*/";
    store(markers, url); store(markers, ref.url);
    replacements.push_back({ref.start, ref.end, resource_token(ref, url)});
  }
  if (replacements.empty()) return finish(); // The bridge reuses the original JS string.
  // JS returns descending edits. Build the output once instead of concatenating
  // the entire stylesheet for every edit; benchmark a JS version of that too.
  std::stable_sort(replacements.begin(), replacements.end(), [](auto &a, auto &b) { return a.start > b.start; });
  for (auto &edit : replacements) { edits.push_back(edit.start); edits.push_back(edit.end); store(edits, edit.value); }
  size_t cursor = 0;
  for (auto it = replacements.rbegin(); it != replacements.rend(); ++it) {
    css += slice(source, cursor, it->start); css += it->value; cursor = it->end;
  }
  css += slice(source, cursor, source.size());
  return finish();
}
}
