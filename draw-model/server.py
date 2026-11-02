"""Qwen-Image-2.1 本地出图服务 —— 纯 Python（diffusers），不用 ComfyUI。

对上游暴露 **OpenAI 兼容**接口，宿主控制台的「图片生成 → 服务地址」直接指向本服务即可：

    POST /v1/images/generations
    { "model": "qwen-image-2.1-turbo", "prompt": "…", "n": 1, "size": "1024x1024" }
    → { "created": 1730000000, "data": [ { "b64_json": "…" } ] }

设计要点（和 say-model 的本地 TTS 保持一致）：
  · **懒加载 + 闲置退出**：第一个请求才把模型搬上显卡，闲置 DRAW_IDLE_SECONDS 后释放，
    不跟唱歌/说话抢显存；
  · **单请求串行**：内部一把锁，同一时刻只跑一张，避免并发把 10 GB 撑爆；
  · **鉴权**：可选 Bearer token（与网关共用一个密钥）；
  · **不撞宿主**：所有重活都在本机，宿主只做转发。

启动：
    E:\\Cache\\qq-agent\\say-sing-drawPlugin\\draw-model\\.venv\\Scripts\\python.exe draw\\server.py

环境变量（都有默认值）：
    DRAW_PORT=7880
    DRAW_HOST=127.0.0.1
    DRAW_TOKEN=（留空则不校验）
    DRAW_WEIGHTS=<仓库>/draw-model/weights
    DRAW_IDLE_SECONDS=180        闲置多少秒后卸载模型（0 = 常驻）
    DRAW_SIZE=1024               默认边长
    DRAW_STEPS=（留空则用 Turbo 的 sample_sigmas）
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8")

PORT = int(os.environ.get("DRAW_PORT", "7880"))
HOST = os.environ.get("DRAW_HOST", "127.0.0.1")
TOKEN = os.environ.get("DRAW_TOKEN", "").strip()
IDLE_SECONDS = int(os.environ.get("DRAW_IDLE_SECONDS", "180"))
DEFAULT_SIZE = int(os.environ.get("DRAW_SIZE", "1024"))
DEFAULT_STEPS = os.environ.get("DRAW_STEPS", "").strip()

WEIGHTS = os.environ.get("DRAW_WEIGHTS") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "draw-model", "weights"
)
TURBO_CFG = os.path.join(WEIGHTS, "turbo-config")
BASE_CFG = os.path.join(WEIGHTS, "base-config")

_lock = threading.Lock()          # 串行化：同一时刻只跑一次推理
_state = {
    "pipe": None,                 # 已加载的管线
    "loaded_at": 0.0,
    "last_used": 0.0,
    "renders": 0,
    "last_error": "",
    "sigmas": None,
}
_idle_timer: threading.Timer | None = None


def log(msg: str) -> None:
    print(f"[draw] {msg}", flush=True)


# ── 管线加载 / 卸载 ────────────────────────────────────────
def _read_sigmas():
    for cfg in (TURBO_CFG, BASE_CFG):
        p = os.path.join(cfg, "model_index.json")
        if os.path.exists(p):
            try:
                data = json.load(open(p, encoding="utf-8"))
                if data.get("sample_sigmas"):
                    return data["sample_sigmas"]
            except Exception:
                pass
    return None


def load_pipeline():
    """把 DiT / 文本编码器 / VAE 搬上显卡。首次调用会量化（较慢）。"""
    import torch
    from diffusers import (
        AutoencoderKLQwenImage21,
        FlowMatchEulerDiscreteScheduler,
        QwenImage21Pipeline,
        QwenImage21Transformer2DModel,
    )
    from transformers import (
        BitsAndBytesConfig,
        Qwen3VLForConditionalGeneration,
        Qwen3VLProcessor,
    )

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    )

    dit_dir = os.path.join(WEIGHTS, "turbo-dit", "transformer")
    vae_dir = os.path.join(WEIGHTS, "turbo-vae", "vae")
    te_dir = os.path.join(WEIGHTS, "text_encoders")

    for path, label in (
        (os.path.join(dit_dir, "config.json"), "DiT 配置"),
        (os.path.join(vae_dir, "diffusion_pytorch_model.safetensors"), "VAE 权重"),
        (os.path.join(te_dir, "config.json"), "文本编码器"),
    ):
        if not os.path.exists(path):
            raise RuntimeError(f"缺 {label}：{path}")

    # VAE 的 config 用基座那份（Turbo 仓库只给了权重）
    vae_cfg = os.path.join(vae_dir, "config.json")
    if not os.path.exists(vae_cfg):
        src = os.path.join(BASE_CFG, "vae", "config.json")
        if os.path.exists(src):
            open(vae_cfg, "w", encoding="utf-8").write(open(src, encoding="utf-8").read())

    t0 = time.time()
    log("加载 DiT（bf16 → nf4 量化）…")
    transformer = QwenImage21Transformer2DModel.from_pretrained(
        dit_dir, quantization_config=bnb, torch_dtype=torch.bfloat16
    )

    log("加载文本编码器（4bit）…")
    text_encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        te_dir, quantization_config=bnb, torch_dtype=torch.bfloat16
    )

    processor_dir = os.path.join(TURBO_CFG, "processor")
    if not os.path.exists(processor_dir):
        processor_dir = os.path.join(BASE_CFG, "processor")
    processor = Qwen3VLProcessor.from_pretrained(processor_dir)
    for cand in (
        os.path.join(te_dir, "chat_template.jinja"),
        os.path.join(TURBO_CFG, "chat_template.jinja"),
    ):
        if os.path.exists(cand):
            processor.chat_template = open(cand, encoding="utf-8").read()
            break

    log("加载 VAE + scheduler…")
    vae = AutoencoderKLQwenImage21.from_pretrained(vae_dir, torch_dtype=torch.bfloat16)
    scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(os.path.join(TURBO_CFG, "scheduler"))

    pipe = QwenImage21Pipeline(
        scheduler=scheduler, vae=vae, text_encoder=text_encoder,
        processor=processor, transformer=transformer,
    )
    pipe.vae.enable_slicing()
    # 10 GB 卡必须靠 offload：用不到的组件留在内存、用到时才搬上卡。
    # 不加会把 DiT(≈4G) + TE(≈5G) + VAE 一起塞进显卡，超物理显存后走 Windows 共享内存，
    # 单张从 25 秒掉到十几分钟（实测 900 秒无响应、显存显示 10.95 GB）。
    pipe.enable_model_cpu_offload()

    _state["sigmas"] = _read_sigmas()
    log(f"管线就绪，用时 {time.time() - t0:.1f}s"
        + (f"，显存 {torch.cuda.memory_allocated() / 2**30:.2f} GB" if torch.cuda.is_available() else ""))
    return pipe


def unload_pipeline(reason: str = "") -> None:
    """释放模型（把显存还回去）。"""
    if _state["pipe"] is None:
        return
    _state["pipe"] = None
    try:
        import torch
        torch.cuda.empty_cache()
        if torch.cuda.is_available():
            log(f"模型已卸载（{reason}），显存回落到 {torch.cuda.memory_allocated() / 2**30:.2f} GB")
            return
    except Exception:
        pass
    log(f"模型已卸载（{reason}）")


def _arm_idle_timer() -> None:
    global _idle_timer
    if IDLE_SECONDS <= 0:
        return
    if _idle_timer is not None:
        _idle_timer.cancel()
    _idle_timer = threading.Timer(IDLE_SECONDS, lambda: unload_pipeline(f"闲置 {IDLE_SECONDS}s"))
    _idle_timer.daemon = True
    _idle_timer.start()


# ── 推理 ──────────────────────────────────────────────────
def generate(prompt: str, size: int, steps, seed=None) -> bytes:
    import torch

    with _lock:
        if _state["pipe"] is None:
            _state["pipe"] = load_pipeline()
            _state["loaded_at"] = time.time()
        pipe = _state["pipe"]
        _state["last_used"] = time.time()

        kwargs = dict(prompt=prompt, width=size, height=size, true_cfg_scale=1.0)
        if steps:
            kwargs["num_inference_steps"] = int(steps)
        elif _state["sigmas"]:
            kwargs["sigmas"] = torch.tensor(_state["sigmas"], dtype=torch.float32)
        if seed is not None:
            kwargs["generator"] = torch.Generator(device="cuda").manual_seed(int(seed))

        t0 = time.time()
        image = pipe(**kwargs).images[0]
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        _state["renders"] += 1
        log(f"出图 {size}x{size} 用时 {time.time() - t0:.1f}s（第 {_state['renders']} 张）")
        _arm_idle_timer()
        return buf.getvalue()


# ── HTTP ──────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self) -> bool:
        if not TOKEN:
            return True
        given = str(self.headers.get("authorization", "")).replace("Bearer ", "").strip()
        return given == TOKEN

    def log_message(self, fmt, *args):  # 关掉默认访问日志噪音
        return

    def do_GET(self):
        if self.path == "/health":
            import torch
            loaded = _state["pipe"] is not None
            self._send(200, {
                "ok": True,
                "loaded": loaded,
                "renders": _state["renders"],
                "vramGB": round(torch.cuda.memory_allocated() / 2**30, 2) if torch.cuda.is_available() else 0,
                "idleSeconds": IDLE_SECONDS,
                "lastError": _state["last_error"],
            })
            return
        if self.path in ("/v1/models", "/models"):
            self._send(200, {"object": "list", "data": [
                {"id": "qwen-image-2.1-turbo", "object": "model", "owned_by": "local"},
            ]})
            return
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path not in ("/v1/images/generations", "/images/generations"):
            self._send(404, {"error": {"message": "not found"}})
            return
        if not self._auth_ok():
            self._send(401, {"error": {"message": "unauthorized"}})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw or b"{}")
        except Exception as exc:
            self._send(400, {"error": {"message": f"bad json: {exc}"}})
            return

        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            self._send(400, {"error": {"message": "prompt 不能为空"}})
            return

        size = DEFAULT_SIZE
        raw_size = str(body.get("size") or "").strip()
        if "x" in raw_size:
            try:
                size = int(raw_size.lower().split("x")[0])
            except Exception:
                pass
        steps = body.get("steps") or (DEFAULT_STEPS or None)

        try:
            png = generate(prompt, size, steps, body.get("seed"))
        except Exception as exc:
            _state["last_error"] = str(exc)[:400]
            log(f"出图失败：{exc}")
            self._send(500, {"error": {"message": str(exc)[:400]}})
            return

        self._send(200, {
            "created": int(time.time()),
            "data": [{"b64_json": base64.b64encode(png).decode("ascii")}],
        })


def main() -> None:
    log(f"权重目录 {WEIGHTS}")
    log(f"听 {HOST}:{PORT}｜鉴权 {'开' if TOKEN else '关'}｜闲置退出 {IDLE_SECONDS or '常驻'}s")
    if not os.path.isdir(WEIGHTS):
        log("⚠ 权重目录不存在，等权重下完再启动")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
