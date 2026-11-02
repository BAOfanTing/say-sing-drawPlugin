"""Qwen-Image-2.1-Turbo 本地出图 —— 纯 diffusers，10 GB 卡可用。

和 gen-test.py 的区别：
  · 用 Turbo（8 步）的官方 bf16 权重，加载时用 bitsandbytes nf4 压到 ~4 GB 显存
  · 不用 GGUF（unsloth 那份是 ComfyUI 布局，norm_out 形状和 diffusers 对不上）

用法：
  python gen-turbo.py                            # 默认提示词，1024²、8 步
  python gen-turbo.py "一位穿白裙的少女" 8 1024
"""
import os
import sys
import time

import torch

sys.stdout.reconfigure(encoding="utf-8")

W = r"E:\Cache\qq-agent\say-sing-drawPlugin\draw-model\weights"
OUT = r"E:\Cache\qq-agent\say-sing-drawPlugin\draw-model\outputs"
TURBO_CFG = os.path.join(W, "turbo-config")
os.makedirs(OUT, exist_ok=True)

PROMPT = sys.argv[1] if len(sys.argv) > 1 else (
    "一位蓝白配色的 Q 版动漫少女，蓝色长发、鲸鱼尾巴，站在海边礁石上，"
    "逆光、暖色调、精致插画风格，画面干净"
)
STEPS = int(sys.argv[2]) if len(sys.argv) > 2 else 8
SIDE = int(sys.argv[3]) if len(sys.argv) > 3 else 1024


def gb(n):
    return n / 2 ** 30


def need(path, label):
    if not os.path.exists(path):
        sys.exit(f"缺 {label}：{path}")
    return path


t_all = time.time()
torch.cuda.reset_peak_memory_stats()

# ── 1) DiT：官方 bf16 + nf4 量化 ──────────────────────
from diffusers import QwenImage21Transformer2DModel
from transformers import BitsAndBytesConfig

dit_dir = os.path.join(W, "turbo-dit", "transformer")
need(os.path.join(dit_dir, "config.json"), "Turbo transformer config")
need(os.path.join(dit_dir, "diffusion_pytorch_model-00001-of-00002.safetensors"), "Turbo transformer 分片1")
need(os.path.join(dit_dir, "diffusion_pytorch_model-00002-of-00002.safetensors"), "Turbo transformer 分片2")

print("[1/4] DiT（bf16 → nf4 量化，首次较慢）…")
t0 = time.time()
transformer = QwenImage21Transformer2DModel.from_pretrained(
    dit_dir,
    quantization_config=BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    ),
    torch_dtype=torch.bfloat16,
)
print(f"      {time.time() - t0:.1f}s", flush=True)

# ── 2) 文本编码器：4bit ───────────────────────────────
from transformers import Qwen3VLForConditionalGeneration, Qwen3VLProcessor

te_dir = os.path.join(W, "text_encoders")
print("[2/4] 文本编码器（4bit）…")
t0 = time.time()
text_encoder = Qwen3VLForConditionalGeneration.from_pretrained(
    te_dir,
    quantization_config=BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    ),
    torch_dtype=torch.bfloat16,
)
processor = Qwen3VLProcessor.from_pretrained(os.path.join(TURBO_CFG, "processor"))
for cand in (os.path.join(te_dir, "chat_template.jinja"),
             os.path.join(TURBO_CFG, "chat_template.jinja"),
             os.path.join(W, "text_encoders", "chat_template.jinja")):
    if os.path.exists(cand):
        processor.chat_template = open(cand, encoding="utf-8").read()
        print(f"      chat_template ← {os.path.basename(cand)}")
        break
print(f"      {time.time() - t0:.1f}s | 显存 {gb(torch.cuda.memory_allocated()):.2f} GB")

# ── 3) VAE + scheduler ────────────────────────────────
from diffusers import AutoencoderKLQwenImage21, FlowMatchEulerDiscreteScheduler, QwenImage21Pipeline

vae_dir = os.path.join(W, "turbo-vae", "vae")
need(os.path.join(vae_dir, "diffusion_pytorch_model.safetensors"), "Turbo VAE")
cfg_src = os.path.join(W, "base-config", "vae", "config.json")
if not os.path.exists(os.path.join(vae_dir, "config.json")) and os.path.exists(cfg_src):
    import shutil
    shutil.copy2(cfg_src, os.path.join(vae_dir, "config.json"))

print("[3/4] VAE + scheduler…")
vae = AutoencoderKLQwenImage21.from_pretrained(vae_dir, torch_dtype=torch.bfloat16)
scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(os.path.join(TURBO_CFG, "scheduler"))

# ── 4) 组管线 ─────────────────────────────────────────
print("[4/4] 组装管线…")
pipe = QwenImage21Pipeline(
    scheduler=scheduler,
    vae=vae,
    text_encoder=text_encoder,
    processor=processor,
    transformer=transformer,
)
pipe.vae.enable_slicing()
# 10 GB 卡的关键：用不到的组件放回内存，用到时才搬上卡（VAE 留在 CPU 会报 dtype 不匹配）
pipe.enable_model_cpu_offload()
print(f"      准备完成 {time.time() - t_all:.1f}s | 显存 {gb(torch.cuda.memory_allocated()):.2f} GB", flush=True)

# ── 出图 ──────────────────────────────────────────────
torch.cuda.reset_peak_memory_stats()
print("      >>> 开始采样（8 步，显卡会占满，属正常）", flush=True)
t0 = time.time()
# Turbo 的调度是训练时定死的：model_index.json 里有 sample_sigmas（8 个值 = 7 步），
# 直接传 num_inference_steps 会走默认调度，效果打折。
import json as _json
_sigmas = None
_mi = os.path.join(TURBO_CFG, "model_index.json")
if os.path.exists(_mi):
    _sigmas = _json.load(open(_mi, encoding="utf-8")).get("sample_sigmas")
if _sigmas:
    import torch as _t
    print(f"  用官方 sample_sigmas（{len(_sigmas)} 个断点 ≈ {len(_sigmas)-1} 步）")
    image = pipe(
        prompt=PROMPT,
        width=SIDE,
        height=SIDE,
        sigmas=_t.tensor(_sigmas, dtype=torch.float32),
        true_cfg_scale=1.0,
    ).images[0]
else:
    image = pipe(
        prompt=PROMPT,
        width=SIDE,
        height=SIDE,
        num_inference_steps=STEPS,
        true_cfg_scale=1.0,
    ).images[0]
elapsed = time.time() - t0

path = os.path.join(OUT, f"turbo-{int(time.time())}.png")
image.save(path)
print()
print("=" * 60)
print(f"出图成功：{path}")
print(f"  分辨率 {SIDE}x{SIDE}｜步数 {STEPS}｜单张耗时 {elapsed:.1f}s")
print(f"  峰值显存 {gb(torch.cuda.max_memory_allocated()):.2f} GB")
print("=" * 60)
