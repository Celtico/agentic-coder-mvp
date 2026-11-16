// Prompt cache like mlx_lm's LRUPromptCache as the Python worker uses it
// (src/core/assistant/mlx-worker.py): copies of the model cache, keyed by the
// tokens they have read. A new prompt starts from the longest copy it begins
// with. The Gated DeltaNet state cannot be rewound, so only exact prefixes count.
#pragma once

#include <algorithm>
#include <list>
#include <optional>
#include <utility>
#include <vector>

#include "qwen35.h"

namespace agentic {

class PromptCache {
 public:
  size_t max_entries = 8;
  size_t max_bytes = 1000000000;

  // The longest entry the prompt begins with that leaves at least one token
  // to read (the last one gives the logits): its length and a copy of it.
  std::optional<std::pair<size_t, CacheState>> find(const std::vector<int32_t>& tokens) {
    auto best = entries_.end();
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
      size_t n = it->tokens.size();
      if (n < tokens.size() && (best == entries_.end() || n > best->tokens.size()) &&
          std::equal(it->tokens.begin(), it->tokens.end(), tokens.begin()))
        best = it;
    }
    if (best == entries_.end()) return std::nullopt;
    entries_.splice(entries_.begin(), entries_, best);
    return std::make_pair(best->tokens.size(), best->state);
  }

  bool has(const std::vector<int32_t>& tokens, size_t length) const {
    return std::any_of(entries_.begin(), entries_.end(), [&](const Entry& e) {
      return e.tokens.size() == length && std::equal(e.tokens.begin(), e.tokens.end(), tokens.begin());
    });
  }

  // Adds (or replaces) an entry and drops the least recently used ones over the limits.
  void insert(std::vector<int32_t> tokens, CacheState state) {
    entries_.remove_if([&](const Entry& e) {
      if (e.tokens != tokens) return false;
      bytes_ -= e.bytes;
      return true;
    });
    size_t n = state.nbytes();
    entries_.push_front({std::move(tokens), std::move(state), n});
    bytes_ += n;
    while (!entries_.empty() && (entries_.size() > max_entries || bytes_ > max_bytes)) {
      bytes_ -= entries_.back().bytes;
      entries_.pop_back();
    }
  }

  void clear() {
    entries_.clear();
    bytes_ = 0;
  }
  size_t size() const { return entries_.size(); }
  size_t bytes() const { return bytes_; }

 private:
  struct Entry {
    std::vector<int32_t> tokens;
    CacheState state;
    size_t bytes;
  };
  std::list<Entry> entries_;  // most recently used first
  size_t bytes_ = 0;
};

}  // namespace agentic
