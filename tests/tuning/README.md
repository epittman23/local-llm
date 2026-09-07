# Search spaces for `llama-tune`

One TOML per profile, naming the values `llama-tune` is allowed to try. Each
file declares **overrides only**.

That restriction is the point of the directory, not a formality.
`scripts/llama-env.sh` is this repo's single source of truth for serving
configuration; a grid that could set a base value would be a second profile
table, and the day the two disagreed a run would be recorded under a
configuration nobody could reproduce from the shell. So a grid may name only
the documented `LLAMA_*` override variables, and `llama-tune` refuses to load
one that names anything else. Everything a candidate does not override comes
from the profile, at the moment the server is launched.

## Shape

```toml
id = "qwen36"
profile = "qwen36"
min_ctx = 32768              # a scalar, usable in a constraint

[knob.LLAMA_THREADS]
values = [4, 6, 8, 10]
ordered = true               # refine tries the adjacent values

[knob.LLAMA_CACHE_K]
values = ["q8_0", "q4_0", "f16"]
ordered = false              # no adjacency: refine tries all the others

[[constraint]]
expr = "LLAMA_UBATCH <= LLAMA_BATCH"
```

`ordered` is what the refine stage descends along. For a numeric knob the
neighbourhood of a value is the entry either side of it in `values`, so the
order of that list is meaningful and should be monotonic. For a knob with no
natural adjacency -- a cache type -- `ordered = false` says so, and refine
tries every other value instead of pretending index ±1 means something.

A constraint is one comparison, `A OP B`, with `OP` one of `<= >= == != < >`.
Each side is a knob name, a scalar declared at the top of the file, or a
literal. A knob the candidate did not override resolves to the profile's own
value, read from `llama-env.sh profile-json` -- which is why constraints stay
true against the configuration that will actually be served rather than against
a copy of its defaults. It is a small comparison parser rather than `eval`,
deliberately: this process already executes model-generated code under process
isolation, and nothing here needs to also be an expression evaluator.

`grid_sha` is computed over the **parsed** structure, not the file's bytes, so
editing a comment does not file every earlier round as a different search
space. That is the same choice `adapter_sha` makes, for the same reason. A
sweep refuses to resume if the sha changed.

## `-c` is a trap, and every grid treats it as one

A smaller context window is strictly faster and strictly reduces what the
server can serve, so a sweep left free to shrink it will "win" by making the
model less useful. Every grid here declares a `min_ctx` and constrains
`LLAMA_CTX` against it, and `llama-tune report` warns in words when the
adopted winner reduces the context.

## What is deliberately not in these grids

`LLAMA_OT` (tensor overrides) takes a regex whose meaning depends on the
model's own layer names, so a value that is a sensible placement pin for
`qwen38` is a no-op for `qwen25c`. It is left to hand-written experiments until
there is a per-profile vocabulary for it worth sampling from.
