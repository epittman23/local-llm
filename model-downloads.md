# Model Download Commands
## Template
```
hf download < model > --local-dir ~/models/< alias > --include "*< quant >*"
```
---
## Qwen 2.5 Coder 7B
```
hf download unsloth/Qwen2.5-Coder-7B-Instruct-GGUF --local-dir ~/models/qwen25-coder-7b --include "*Q4_K_M*"
```

## Qwen 3 Coder 30B A3B
```
hf download unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF --local-dir ~/models/qwen3-coder-30b-a3b --include "*Q4_1*"
```