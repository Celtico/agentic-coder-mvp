// N-API binding: exposes the native MLX engine to Node.
//
//   const engine = new Engine(modelDir, config)   // config from index.js
//   engine.start(Int32Array prompt, { temperature, topP, topK, seed, prefillStep })
//   engine.next()            -> next token id (number)
//   engine.logits(Int32Array) -> Float32Array of the last position (tests)
//   engine.reset()
//   engine.memory()          -> { active, peak, cache } bytes
//
// LoRA (same files and maths as mlx_lm):
//   engine.loraInit({ numLayers, rank, scale, keys, seed })
//   engine.loraLoad(adaptersFile, scale)   // e.g. a beta's adapters.safetensors
//   engine.loraSave(adaptersFile)
//   engine.loraRemove()
//   engine.trainStep(Int32Array tokens, offset, length, { learningRate, gradCheckpoint })
//                            -> { loss, tokens }
//   engine.loraLoss(Int32Array tokens, offset, length) -> { loss, tokens }
//
// Calls are synchronous: run the engine in its own process (utilityProcess),
// like the Python worker, so the app UI never waits on the GPU.
#include <napi.h>

#include <cmath>
#include <limits>
#include <memory>

#include "lora.h"
#include "qwen35.h"

namespace {

using namespace agentic;
using mx::array;

int get_int(const Napi::Object& o, const char* key, int fallback) {
  auto v = o.Get(key);
  return v.IsNumber() ? v.As<Napi::Number>().Int32Value() : fallback;
}

float get_float(const Napi::Object& o, const char* key, float fallback) {
  auto v = o.Get(key);
  return v.IsNumber() ? v.As<Napi::Number>().FloatValue() : fallback;
}

Config parse_config(const Napi::Object& o) {
  Config c;
  c.hidden_size = get_int(o, "hidden_size", 0);
  c.intermediate_size = get_int(o, "intermediate_size", 0);
  c.num_hidden_layers = get_int(o, "num_hidden_layers", 0);
  c.num_attention_heads = get_int(o, "num_attention_heads", 0);
  c.num_key_value_heads = get_int(o, "num_key_value_heads", 0);
  c.head_dim = get_int(o, "head_dim", c.hidden_size / std::max(1, c.num_attention_heads));
  c.vocab_size = get_int(o, "vocab_size", 0);
  c.rms_norm_eps = get_float(o, "rms_norm_eps", 1e-6f);
  c.linear_num_value_heads = get_int(o, "linear_num_value_heads", 0);
  c.linear_num_key_heads = get_int(o, "linear_num_key_heads", 0);
  c.linear_key_head_dim = get_int(o, "linear_key_head_dim", 0);
  c.linear_value_head_dim = get_int(o, "linear_value_head_dim", 0);
  c.linear_conv_kernel_dim = get_int(o, "linear_conv_kernel_dim", 4);
  c.full_attention_interval = get_int(o, "full_attention_interval", 4);
  c.tie_word_embeddings = o.Get("tie_word_embeddings").ToBoolean();
  c.rope_theta = get_float(o, "rope_theta", 1e7f);
  c.partial_rotary_factor = get_float(o, "partial_rotary_factor", 0.25f);
  auto q = o.Get("quantization");
  if (q.IsObject()) {
    auto qo = q.As<Napi::Object>();
    c.quant.group_size = get_int(qo, "group_size", 64);
    c.quant.bits = get_int(qo, "bits", 4);
    auto names = qo.GetPropertyNames();
    for (uint32_t i = 0; i < names.Length(); ++i) {
      auto key = names.Get(i).As<Napi::String>().Utf8Value();
      auto v = qo.Get(key);
      if (!v.IsObject()) continue;
      auto vo = v.As<Napi::Object>();
      c.quant_overrides[key] = {get_int(vo, "group_size", c.quant.group_size),
                                get_int(vo, "bits", c.quant.bits)};
    }
  }
  return c;
}

array to_tokens(const Napi::Value& v) {
  auto ta = v.As<Napi::Int32Array>();
  std::vector<int32_t> ids(ta.Data(), ta.Data() + ta.ElementLength());
  return array(ids.begin(), {1, static_cast<int>(ids.size())}, mx::int32);
}

struct Sampling {
  float temperature = 0.0f;
  float top_p = 1.0f;
  int top_k = 0;
};

// Same order as mlx_lm make_sampler: top-p, top-k, then temperature.
// Works on log-probabilities in the model dtype, exactly like mlx_lm, so the
// same prompt gives the same tokens as the Python engine.
array sample(array logits, const Sampling& s) {
  logits = mx::subtract(logits, mx::logsumexp(logits, -1, true));
  if (s.temperature <= 0.0f) return mx::argmax(logits, -1);
  auto neg_inf = array(-std::numeric_limits<float>::infinity(), logits.dtype());
  if (s.top_p > 0.0f && s.top_p < 1.0f) {
    auto probs = mx::exp(logits);
    auto sorted = mx::sort(mx::negative(probs), -1);  // descending as negatives
    sorted = mx::negative(sorted);
    auto cum = mx::cumsum(sorted, -1);
    // Keep the smallest set whose mass reaches top_p (always keep the first).
    auto keep = mx::less(mx::subtract(cum, sorted), array(s.top_p));
    auto kept_min = mx::min(mx::where(keep, sorted, array(2.0f)), -1, true);
    logits = mx::where(mx::greater_equal(probs, kept_min), logits, neg_inf);
  }
  if (s.top_k > 0 && s.top_k < logits.shape(-1)) {
    auto kth = mx::min(mx::topk(logits, s.top_k, -1), -1, true);
    logits = mx::where(mx::greater_equal(logits, kth), logits, neg_inf);
  }
  return mx::random::categorical(mx::multiply(logits, array(1.0f / s.temperature, logits.dtype())), -1);
}

class Engine : public Napi::ObjectWrap<Engine> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    auto cls = DefineClass(env, "Engine",
                           {InstanceMethod("start", &Engine::Start),
                            InstanceMethod("next", &Engine::Next),
                            InstanceMethod("logits", &Engine::Logits),
                            InstanceMethod("reset", &Engine::Reset),
                            InstanceMethod("memory", &Engine::Memory),
                            InstanceMethod("loraInit", &Engine::LoraInit),
                            InstanceMethod("loraLoad", &Engine::LoraLoad),
                            InstanceMethod("loraSave", &Engine::LoraSave),
                            InstanceMethod("loraRemove", &Engine::LoraRemove),
                            InstanceMethod("trainStep", &Engine::TrainStep),
                            InstanceMethod("loraLoss", &Engine::LoraLoss),
                            InstanceMethod("loraGradients", &Engine::LoraGradients)});
    exports.Set("Engine", cls);
    exports.Set("metal", Napi::Boolean::New(env, mx::metal::is_available()));
    return exports;
  }

  explicit Engine(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Engine>(info) {
    auto env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
      Napi::TypeError::New(env, "Engine(modelDir, config)").ThrowAsJavaScriptException();
      return;
    }
    try {
      if (mx::metal::is_available()) {
        // As mlx_lm does: keep the weights wired so macOS doesn't page them out.
        auto& dev = mx::gpu::device_info();
        auto it = dev.find("max_recommended_working_set_size");
        if (it != dev.end()) mx::set_wired_limit(std::get<size_t>(it->second));
      }
      model_ = std::make_unique<Qwen35>(info[0].As<Napi::String>().Utf8Value(),
                                        parse_config(info[1].As<Napi::Object>()));
      lora_ = std::make_unique<Lora>(*model_);
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    }
  }

 private:
  // Prefill the prompt and queue the first sampled token.
  Napi::Value Start(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    try {
      auto tokens = to_tokens(info[0]);
      sampling_ = {};
      int chunk = 2048;  // mlx_lm prefill_step_size
      if (info.Length() > 1 && info[1].IsObject()) {
        auto o = info[1].As<Napi::Object>();
        sampling_.temperature = get_float(o, "temperature", 0.0f);
        sampling_.top_p = get_float(o, "topP", 1.0f);
        sampling_.top_k = get_int(o, "topK", 0);
        if (o.Get("seed").IsNumber()) mx::random::seed(get_int(o, "seed", 0));
        chunk = std::max(1, get_int(o, "prefillStep", chunk));
      }
      model_->reset();
      int n = tokens.shape(1);
      int pos = 0;
      while (n - pos > 1) {
        int end = std::min(pos + chunk, n - 1);
        model_->forward(mx::slice(tokens, {0, pos}, {1, end}));
        mx::eval(model_->cache_arrays());
        mx::clear_cache();
        pos = end;
      }
      auto logits = model_->forward(mx::slice(tokens, {0, pos}, {1, n}));
      pending_ = sample(last(logits), sampling_);
      mx::async_eval({*pending_});
      return env.Undefined();
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // Return the queued token and start computing the one after it, so the GPU
  // works on step n+1 while JS handles token n (as mlx_lm generate_step does).
  Napi::Value Next(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (!pending_) {
      Napi::Error::New(env, "call start() first").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    try {
      array current = *pending_;
      auto logits = model_->forward(mx::reshape(current, {1, 1}));
      pending_ = sample(last(logits), sampling_);
      mx::async_eval({*pending_});
      mx::eval({current});
      if (++steps_ % 256 == 0) mx::clear_cache();
      return Napi::Number::New(env, current.item<int32_t>());
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // Forward tokens through the cache and return the last position's logits.
  Napi::Value Logits(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    try {
      auto out = mx::astype(last(model_->forward(to_tokens(info[0]))), mx::float32);
      mx::eval({out});
      auto result = Napi::Float32Array::New(env, out.size());
      std::copy(out.data<float>(), out.data<float>() + out.size(), result.Data());
      return result;
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  Napi::Value Reset(const Napi::CallbackInfo& info) {
    model_->reset();
    pending_.reset();
    mx::clear_cache();
    return info.Env().Undefined();
  }

  Napi::Value Memory(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto o = Napi::Object::New(env);
    o.Set("active", Napi::Number::New(env, static_cast<double>(mx::get_active_memory())));
    o.Set("peak", Napi::Number::New(env, static_cast<double>(mx::get_peak_memory())));
    o.Set("cache", Napi::Number::New(env, static_cast<double>(mx::get_cache_memory())));
    return o;
  }

  // Runs fn and turns C++ exceptions into JS errors.
  template <typename F>
  Napi::Value guard(const Napi::CallbackInfo& info, F fn) {
    try {
      return fn();
    } catch (const std::exception& e) {
      Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
      return info.Env().Undefined();
    }
  }

  Napi::Value LoraInit(const Napi::CallbackInfo& info) {
    return guard(info, [&]() -> Napi::Value {
      LoraOptions o;
      if (info.Length() > 0 && info[0].IsObject()) {
        auto obj = info[0].As<Napi::Object>();
        o.num_layers = get_int(obj, "numLayers", o.num_layers);
        o.rank = get_int(obj, "rank", o.rank);
        o.scale = get_float(obj, "scale", o.scale);
        if (obj.Get("seed").IsNumber()) mx::random::seed(get_int(obj, "seed", 0));
        auto keys = obj.Get("keys");
        if (keys.IsArray()) {
          auto arr = keys.As<Napi::Array>();
          for (uint32_t i = 0; i < arr.Length(); ++i)
            o.keys.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
        }
      }
      model_->reset();
      lora_->init(o);
      return info.Env().Undefined();
    });
  }

  Napi::Value LoraLoad(const Napi::CallbackInfo& info) {
    return guard(info, [&]() -> Napi::Value {
      model_->reset();
      lora_->load(info[0].As<Napi::String>().Utf8Value(),
                  info[1].As<Napi::Number>().FloatValue());
      return info.Env().Undefined();
    });
  }

  Napi::Value LoraSave(const Napi::CallbackInfo& info) {
    return guard(info, [&]() -> Napi::Value {
      lora_->save(info[0].As<Napi::String>().Utf8Value());
      return info.Env().Undefined();
    });
  }

  Napi::Value LoraRemove(const Napi::CallbackInfo& info) {
    return guard(info, [&]() -> Napi::Value {
      model_->reset();
      lora_->remove();
      return info.Env().Undefined();
    });
  }

  static Napi::Value loss_result(Napi::Env env, std::pair<float, int> r) {
    auto o = Napi::Object::New(env);
    o.Set("loss", Napi::Number::New(env, r.first));
    o.Set("tokens", Napi::Number::New(env, r.second));
    return o;
  }

  Napi::Value TrainStep(const Napi::CallbackInfo& info) {
    return guard(info, [&]() -> Napi::Value {
      float lr = 1e-5f;
      bool ckpt = false;
      if (info.Length() > 3 && info[3].IsObject()) {
        auto o = info[3].As<Napi::Object>();
        lr = get_float(o, "learningRate", lr);
        ckpt = o.Get("gradCheckpoint").ToBoolean();
      }
      pending_.reset();
      model_->reset();
      auto r = lora_->step(to_tokens(info[0]), info[1].As<Napi::Number>().Int32Value(),
                           info[2].As<Napi::Number>().Int32Value(), lr, ckpt);
      mx::clear_cache();
      return loss_result(info.Env(), r);
    });
  }

  Napi::Value LoraLoss(const Napi::CallbackInfo& info) {
    return guard(info, [&]() -> Napi::Value {
      auto r = lora_->loss(to_tokens(info[0]), info[1].As<Napi::Number>().Int32Value(),
                           info[2].As<Napi::Number>().Int32Value());
      return loss_result(info.Env(), r);
    });
  }

  // Saves the gradients to a safetensors file (tests).
  Napi::Value LoraGradients(const Napi::CallbackInfo& info) {
    return guard(info, [&]() -> Napi::Value {
      model_->reset();
      auto g = lora_->gradients(to_tokens(info[0]), info[1].As<Napi::Number>().Int32Value(),
                                info[2].As<Napi::Number>().Int32Value(), info[4].ToBoolean());
      mx::save_safetensors(info[3].As<Napi::String>().Utf8Value(), g);
      return info.Env().Undefined();
    });
  }

  static array last(const array& logits) {
    int S = logits.shape(1), V = logits.shape(2);
    return mx::reshape(mx::slice(logits, {0, S - 1, 0}, {1, S, V}), {V});
  }

  std::unique_ptr<Qwen35> model_;
  std::unique_ptr<Lora> lora_;
  std::optional<array> pending_;
  Sampling sampling_;
  int steps_ = 0;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return Engine::Init(env, exports);
}

}  // namespace

NODE_API_MODULE(agentic_mlx, InitAll)
