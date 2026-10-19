from local_llm.benchmarks.serving.profiles import ServingProfile, resolve
from local_llm.benchmarks.serving.fingerprint import config_id
from local_llm.benchmarks.serving.launcher import build_argv
base=dict(arch='moe',alias='qwen36',model_path='{LLAMA_MODELS}/a.gguf',ctx=8192,threads=8,ngl=99)
a=resolve(ServingProfile.from_definition('p',base))
b=resolve(ServingProfile.from_definition('p',{**base,'extra':['--no-mmap','-sm','none']}))
c=resolve(ServingProfile.from_definition('p',{**base,'model_path':'{LLAMA_MODELS}/b-Q8_0.gguf'}))
print(config_id(a),config_id(b),config_id(c))
print(build_argv(a)==build_argv(b), build_argv(a)==build_argv(c))
