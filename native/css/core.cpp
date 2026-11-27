// Pure CSS work only. Browser APIs, networking and small operations remain JS.
#include "css.cpp"
#include <unordered_map>

struct PackedEdit { U start, end, offset, length; double order; };
static_assert(sizeof(PackedEdit) == 24);
static std::vector<PackedEdit> supplied_edits;
static std::vector<U> supplied_parts;

struct SrcsetURL { U start, end; };
static std::vector<SrcsetURL> srcset_references(View source) {
  std::vector<SrcsetURL> urls; size_t position = 0;
  while (position < source.size()) {
    while (space(at(source, position)) || at(source, position) == ',') ++position;
    if (position >= source.size()) break;
    auto start = position;
    while (position < source.size() && !space(source[position])) ++position;
    auto end = position;
    while (end && source[end - 1] == ',') --end;
    if (end > start) urls.push_back({U(start), U(end)});
    if (end != position) continue;
    bool parens = false;
    while (position < source.size()) {
      auto c = source[position++];
      if (parens) { if (c == ')') parens = false; }
      else if (c == '(') parens = true;
      else if (c == ',') break;
    }
  }
  return urls;
}

extern "C" {
U reserve_edits(U count) { supplied_edits.resize(count); return ptr(supplied_edits.data()); }
U reserve_parts(U count) { supplied_parts.resize(count); return ptr(supplied_parts.data()); }

U *scan_srcset(U length) {
  reset(); View source(input.data(), length);
  for (auto &ref : srcset_references(source)) {
    records.push_back(ref.start); records.push_back(ref.end); store(records, source.substr(ref.start, ref.end - ref.start));
  }
  finish(); header[1] = records.size() / 4; return header;
}
U *apply_srcset_urls(U length, U count) {
  reset(); View source(input.data(), length); auto refs = srcset_references(source);
  if (refs.size() != count) return nullptr;
  size_t cursor = 0;
  for (U i = 0; i < count; ++i) {
    css += source.substr(cursor, refs[i].start - cursor);
    auto value = supplied_edits[i]; css.append(input.data() + value.offset, value.length);
    cursor = refs[i].end;
  }
  css += source.substr(cursor); return finish();
}

// Preserve each original CSS text node, including empty nodes and token edits
// that span several nodes. This is not equivalent to rewriting then splitting
// the resulting text using the old node lengths.
U *edit_css_nodes(U count, U edit_count) {
  reset();
  std::vector<U> offsets{0};
  for (U i = 0; i < count; ++i) offsets.push_back(offsets.back() + supplied_parts[i]);
  std::vector<Text> output(count);
  std::vector<PackedEdit> sorted(supplied_edits.begin(), supplied_edits.begin() + edit_count);
  std::stable_sort(sorted.begin(), sorted.end(), [](auto &a, auto &b) { return a.start < b.start; });
  U cursor = 0, index = 0;
  auto seek = [&](U position) { while (index + 1 < count && offsets[index + 1] <= position) ++index; };
  auto copy = [&](U end) {
    seek(cursor);
    while (cursor < end && index < count) {
      U last = std::min(end, offsets[index + 1]);
      output[index].append(input.data() + cursor, last - cursor);
      cursor = last;
      if (cursor < end) ++index;
    }
    seek(end);
  };
  for (auto &edit : sorted) {
    copy(edit.start);
    if (count) output[index].append(input.data() + edit.offset, edit.length);
    cursor = edit.end;
  }
  copy(offsets.back());
  for (auto &part : output) store(records, part);
  finish(); header[1] = count; return header;
}

// Restore resource placeholders after asynchronous relay work. Exact Map hits
// win over prefix matches; prefix matches follow the Map's insertion order.
U *restore_stylesheet(U length, U marker_count, U prefixes, U edits_only) {
  reset(); View source(input.data(), length);
  std::vector<std::pair<View, View>> pairs;
  std::unordered_map<View, U> exact;
  for (U i = 0; i < marker_count; ++i) {
    auto key = supplied_edits[i * 2], value = supplied_edits[i * 2 + 1];
    pairs.emplace_back(View(input.data() + key.offset, key.length), View(input.data() + value.offset, value.length));
    exact.emplace(pairs.back().first, i);
  }
  auto references = scan(source);
  std::vector<Edit> replacements;
  for (auto it = references.rbegin(); it != references.rend(); ++it) {
    auto &ref = *it; View url = ref.url;
    auto found = exact.find(url); size_t selected = pairs.size();
    if (found != exact.end()) selected = found->second;
    else if (prefixes) for (size_t i = 0; i < pairs.size(); ++i) if (url.starts_with(pairs[i].first)) { selected = i; break; }
    if (selected == pairs.size()) continue;
    Text replacement(pairs[selected].second); replacement += url.substr(pairs[selected].first.size());
    replacements.push_back({ref.start, ref.end, resource_token(ref, replacement)});
  }
  // restore_css exposes edits in reverse source order to its transform hook.
  for (auto &edit : replacements) { edits.push_back(edit.start); edits.push_back(edit.end); store(edits, edit.value); }
  if (replacements.empty() || edits_only) return finish();
  size_t cursor = 0;
  for (auto it = replacements.rbegin(); it != replacements.rend(); ++it) {
    css += slice(source, cursor, it->start); css += it->value; cursor = it->end;
  }
  css += source.substr(cursor);
  return finish();
}

// The real style pipeline restores placeholders and immediately applies those
// edits to text nodes. Keep both operations native instead of returning a JS
// edits array only to copy it straight back into WASM.
U *restore_css_nodes(U length, U marker_count, U prefixes, U count) {
  restore_stylesheet(length, marker_count, prefixes, 1);
  U edit_count = edits.size() / 4;
  input.resize(length + arena.size());
  std::copy(arena.begin(), arena.end(), input.begin() + length);
  supplied_edits.resize(edit_count);
  for (U i = 0; i < edit_count; ++i)
    supplied_edits[i] = {edits[i * 4], edits[i * 4 + 1], length + edits[i * 4 + 2], edits[i * 4 + 3], 0};
  return edit_css_nodes(count, edit_count);
}

// After JS completes relay fetches, format and apply resolved resource URLs in
// one pass. Keep the async networking and browser policy decisions in JS.
U *apply_css_values(U length, U count) {
  reset(); View source(input.data(), length);
  auto references = scan(source);
  std::erase_if(references, [](const Ref &ref) {
    auto url = lower(ref.url);
    return ref.url.empty() || ref.url[0] == '#' || (!ref.imported && (url.starts_with(u"data:") || url.starts_with(u"blob:")));
  });
  if (references.size() != count) return nullptr;
  std::vector<Edit> replacements;
  for (U i = 0; i < count; ++i) {
    auto &ref = references[i]; auto value = supplied_edits[i];
    replacements.push_back({ref.start, ref.end, resource_token(ref, Text(input.data() + value.offset, value.length))});
    if (value.order && ref.has_condition) replacements.push_back({ref.condition_start, ref.condition_end, u""});
  }
  std::stable_sort(replacements.begin(), replacements.end(), [](auto &a, auto &b) { return a.start > b.start; });
  size_t cursor = 0;
  for (auto it = replacements.rbegin(); it != replacements.rend(); ++it) {
    css += slice(source, cursor, it->start); css += it->value; cursor = it->end;
  }
  css += source.substr(cursor);
  return finish();
}
}
