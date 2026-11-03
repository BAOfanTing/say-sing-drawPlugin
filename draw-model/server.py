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

角色一致性（图生图，见 refs/README.md）：
    DRAW_REFS=<仓库>/draw-model/refs   参考图目录（只认这个目录里的 png/jpg，防目录穿越）
    DRAW_IMG2IMG=1                     0 = 关掉触发词图生图，退回纯文生图
    DRAW_TRIGGERS=大肥鱼,鲸鱼娘,…      命中任一即走图生图
    DRAW_REF=                          固定用哪张参考图（留空 = 按 refs/default.txt 或目录里第一张）
    DRAW_CHAR_TEMPLATE=…              固定角色描述前缀（留空用内置那段）

请求体除 OpenAI 那几个字段外还认两个（供 curl 调试，宿主不会传）：
    "ref": "dfy-fullbody.png"   指定参考图；"ref": "none" 强制文生图
    "size": "768x1024"          宽高分开给（以前只取宽，正方形）

健壮性：
    DRAW_REQUEST_TIMEOUT=300    单张最多等多久（秒），超时回 504 并把管线标记待卸载；0 = 不限
    DRAW_LOG=<本目录>/logs/service.log   日志文件（调度任务起的进程抓不到控制台）
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import threading
import time
import traceback
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

_HERE = os.path.dirname(os.path.abspath(__file__))
REFS = os.environ.get("DRAW_REFS") or os.path.join(_HERE, "refs")
IMG2IMG = os.environ.get("DRAW_IMG2IMG", "1").strip() not in ("0", "false", "False", "")
TRIGGERS = [
    t.strip() for t in os.environ.get(
        "DRAW_TRIGGERS",
        "大肥鱼,鲸鱼娘,鲸鱼妹妹,小鲸鱼,蓝色鲸鱼,deepseek娘,画自己,画个自己,画一只自己",
    ).split(",") if t.strip()
]
REF_OVERRIDE = os.environ.get("DRAW_REF", "").strip()
# 单次请求最多等多久（秒）。超过就回 504 并把管线标记为"待卸载"：
# 之前没有这道闸，一次掉进共享内存的渲染能把服务卡死十几分钟，健康检查都连不上。
REQUEST_TIMEOUT = float(os.environ.get("DRAW_REQUEST_TIMEOUT", "300") or 0)
LOG_PATH = os.environ.get("DRAW_LOG") or os.path.join(_HERE, "logs", "service.log")

# 固定角色描述：参考图已经给了脸和服装，这段只补参考图裁掉/模糊掉的部分（尾巴、围裙刺绣、鳍耳）。
CHAR_TEMPLATE = os.environ.get("DRAW_CHAR_TEMPLATE") or (
    "蓝色大肥鱼的拟人化形象（DeepSeek 鲸鱼娘，角色设计与参考图完全一致）："
    "深蓝色到浅蓝渐变的超长微卷发，蓝色大眼，白色蕾丝女仆头巾，"
    "藏青色女仆连衣裙配白色荷叶边和白色围裙（围裙上有蓝色小鲸鱼刺绣），"
    "水滴形的鳍状耳，身后一条蓝色鲸鱼尾巴，蓝白配色。"
    "画风：Q 版动漫插画，赛璐璐上色，柔和打光。"
    "场景："
)

_lock = threading.Lock()          # 串行化：同一时刻只跑一次推理
_state = {
    "pipe": None,                 # 已加载的管线
    "loaded_at": 0.0,
    "last_used": 0.0,
    "renders": 0,
    "last_error": "",
    "sigmas": None,
    "tainted": False,             # 上一张超时/出错 → 下次请求先卸载重来
}
_idle_timer: threading.Timer | None = None


def log(msg: str) -> None:
    """同时写控制台与 logs/service.log —— 用调度任务起的时候控制台是抓不到的。"""
    line = f"[draw] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
    except Exception:
        pass


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


def _fix_unquantized_4bit(root, label: str = "") -> list[str]:
    """把「类名是 Linear4bit、权重却没真量化」的层换回普通 nn.Linear。

    Qwen3-VL 的视觉 merger（`model.visual.merger` / `deepstack_merger_list.*` 那 8 个 linear_fc1/fc2）
    在 bitsandbytes 4bit 加载后就是这个状态：weight 还是 bf16 的 (out, in)、`quant_state` 是 None。
    纯文生图不碰视觉塔，所以一直没暴露；一旦带参考图进来，前向就会撞
    `assert module.weight.shape[1] == 1`（bitsandbytes `fix_4bit_weight_quant_state_from_module`）。
    它们加起来才 170M 参数（bf16 约 0.34 GB），直接换成 bf16 的 nn.Linear 最省事。
    """
    import torch
    import torch.nn as nn
    import bitsandbytes as bnb

    fixed = []
    for name, mod in list(root.named_modules()):
        if not isinstance(mod, bnb.nn.Linear4bit):
            continue
        weight = mod.weight
        quantized = weight.dim() == 2 and weight.shape[1] == 1 and getattr(weight, "quant_state", None) is not None
        if quantized:
            continue
        parent_name, _, child = name.rpartition(".")
        parent = root.get_submodule(parent_name) if parent_name else root
        lin = nn.Linear(
            mod.in_features, mod.out_features, bias=mod.bias is not None,
            device=weight.device, dtype=weight.dtype,
        )
        with torch.no_grad():
            lin.weight.copy_(weight)
            if mod.bias is not None:
                lin.bias.copy_(mod.bias)
        setattr(parent, child, lin)
        fixed.append(name)
    if fixed:
        log(f"{label}修正 {len(fixed)} 个未真正量化的 4bit 层（视觉 merger）")
    return fixed


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
    _fix_unquantized_4bit(text_encoder, "文本编码器：")

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


# ── 参考图（图生图） ──────────────────────────────────────
_REF_EXT = (".png", ".jpg", ".jpeg", ".webp")


def _list_refs() -> list[str]:
    if not os.path.isdir(REFS):
        return []
    return sorted(
        f for f in os.listdir(REFS)
        if f.lower().endswith(_REF_EXT) and not f.startswith(("_", "."))
    )


def _default_ref() -> str:
    """默认参考图：环境变量 > refs/default.txt 里写的 > 目录里第一张。"""
    if REF_OVERRIDE:
        return REF_OVERRIDE
    marker = os.path.join(REFS, "default.txt")
    if os.path.exists(marker):
        try:
            # utf-8-sig：Windows 上记事本/PowerShell 存的文件常带 BOM，带进文件名就永远匹配不上
            with open(marker, encoding="utf-8-sig") as fh:
                name = fh.read().strip()
            if name:
                return name
        except Exception:
            pass
    files = _list_refs()
    return files[0] if files else ""


def _ref_path(name: str) -> str:
    """把请求里的名字收敛成 refs/ 下的绝对路径；越界一律当没给。"""
    if not name:
        return ""
    base = os.path.basename(str(name).strip().replace("\\", "/"))
    if not base or base != str(name).strip().replace("\\", "/") or not base.lower().endswith(_REF_EXT):
        return ""
    path = os.path.join(REFS, base)
    try:                                      # 真·目录边界检查（防 ../ 与符号链接）
        if os.path.commonpath([os.path.abspath(path), os.path.abspath(REFS)]) != os.path.abspath(REFS):
            return ""
    except ValueError:
        return ""
    return path if os.path.isfile(path) else ""


def _triggered(prompt: str) -> bool:
    if not IMG2IMG:
        return False
    hay = prompt.replace(" ", "").lower()
    return any(t.replace(" ", "").lower() in hay for t in TRIGGERS)


def resolve_ref(prompt: str, requested: str | None) -> str:
    """决定这次要不要带参考图，返回绝对路径（空字符串 = 文生图）。"""
    asked = str(requested or "").strip()
    if asked.lower() in ("none", "off", "0"):
        return ""
    if asked:
        path = _ref_path(asked)
        if path:
            return path
        log(f"⚠ 请求里的 ref={asked} 不在 refs/ 里，忽略")
    if not _triggered(prompt):
        return ""
    path = _ref_path(_default_ref())
    if not path:
        log(f"⚠ 命中触发词但 refs/ 里没有可用参考图（{REFS}），退回文生图")
    return path


def load_ref_image(path: str):
    """读参考图：转 RGB、限制长边（视觉编码器按图块算 token，太大只会更慢更占显存）。"""
    from PIL import Image

    img = Image.open(path)
    img = img.convert("RGB")
    limit = int(os.environ.get("DRAW_REF_MAX_SIDE", "768"))
    if max(img.size) > limit:
        scale = limit / max(img.size)
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    return img


def _dims(size: int, ref_img) -> tuple[int, int]:
    """给出宽高：有参考图就按它的比例铺满 size² 的面积（否则参考图的比例会被压扁）。"""
    if ref_img is None:
        return size, size
    ratio = ref_img.width / max(1, ref_img.height)
    area = size * size
    w = (area * ratio) ** 0.5
    h = w / ratio
    w = max(256, min(2048, int(round(w / 32)) * 32))
    h = max(256, min(2048, int(round(h / 32)) * 32))
    return w, h


# ── 推理 ──────────────────────────────────────────────────
def generate(prompt: str, size: int, steps, seed=None,
             ref_name: str | None = None, dims: tuple[int, int] | None = None) -> bytes:
    import torch

    with _lock:
        if _state["tainted"]:
            # 上一次超时/出错：管线可能留在半截状态，先扔掉重来
            unload_pipeline("上一张超时或出错")
            _state["tainted"] = False
        if _state["pipe"] is None:
            _state["pipe"] = load_pipeline()
            _state["loaded_at"] = time.time()
        pipe = _state["pipe"]
        _state["last_used"] = time.time()

        ref_path = resolve_ref(prompt, ref_name)
        ref_img = load_ref_image(ref_path) if ref_path else None
        width, height = dims or _dims(size, ref_img)

        kwargs = dict(prompt=(CHAR_TEMPLATE + prompt) if ref_img is not None else prompt,
                      width=width, height=height, true_cfg_scale=1.0)
        te_pinned = False
        if ref_img is not None:
            # Qwen-Image-2.1 的条件图走 Qwen3-VL 视觉槽 + VAE latent 前缀，必须传 list
            kwargs["image"] = [ref_img]
            # 兜底开关：默认不开。真正修好视觉塔的是加载期的 `_fix_unquantized_4bit()`，
            # 这条只是别的主机上还撞 FP4 报错时，把编码器临时按在卡上再用（多吃 ~5 GB 显存）。
            if os.environ.get("DRAW_TE_ON_GPU", "0") == "1":
                pipe.text_encoder.to("cuda")
                te_pinned = True
        if steps:
            kwargs["num_inference_steps"] = int(steps)
        elif _state["sigmas"]:
            kwargs["sigmas"] = torch.tensor(_state["sigmas"], dtype=torch.float32)
        if seed is not None:
            kwargs["generator"] = torch.Generator(device="cuda").manual_seed(int(seed))

        t0 = time.time()
        try:
            image = pipe(**kwargs).images[0]
        finally:
            if te_pinned:
                pipe.text_encoder.to("cpu")
                torch.cuda.empty_cache()
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        _state["renders"] += 1
        how = f"图生图 ref={os.path.basename(ref_path)}" if ref_img is not None else "文生图"
        log(f"出图 {width}x{height}（{how}）用时 {time.time() - t0:.1f}s（第 {_state['renders']} 张）")
        _arm_idle_timer()
        return buf.getvalue()


# ── HTTP ──────────────────────────────────────────────────
def _run_with_timeout(timeout: float, fn):
    """在后台线程里跑推理，最多等 timeout 秒。

    超时就把错误抛给调用方（回 504），而**不**让 HTTP 线程被钉死在里面：
    掉进 Windows 共享内存时一张图能跑十几分钟，服务会连 /health 都答不了，
    网关那头看到的是"连接被掐"，宿主那头就是"画图没反应"。
    """
    if not timeout or timeout <= 0:
        return fn()
    box: dict = {}

    def runner():
        try:
            box["value"] = fn()
        except BaseException as exc:      # noqa: BLE001 - 原样转给调用方
            box["error"] = exc

    th = threading.Thread(target=runner, name="draw-infer", daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        raise TimeoutError(f"单张超过 {timeout:.0f} 秒还没出来（多半是显存被别的程序占着，掉进共享内存了）")
    if "error" in box:
        raise box["error"]
    return box["value"]


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
                "img2img": IMG2IMG,
                "refs": _list_refs(),
                "refDefault": _default_ref(),
                "triggers": TRIGGERS,
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

        # size 支持 "1024"、"1024x1024"、"768x1024"；只给一个数就按正方形
        width = height = DEFAULT_SIZE
        raw_size = str(body.get("size") or "").strip().lower()
        if raw_size:
            try:
                parts = [p for p in raw_size.replace("*", "x").split("x") if p]
                if len(parts) == 1:
                    width = height = int(float(parts[0]))
                elif len(parts) >= 2:
                    width, height = int(float(parts[0])), int(float(parts[1]))
            except Exception:
                pass
        steps = body.get("steps") or (DEFAULT_STEPS or None)

        try:
            png = _run_with_timeout(
                REQUEST_TIMEOUT,
                lambda: generate(prompt, max(width, height), steps, body.get("seed"),
                                 ref_name=body.get("ref"),
                                 dims=(width, height) if width != height else None),
            )
        except TimeoutError as exc:
            _state["last_error"] = str(exc)[:400]
            _state["tainted"] = True          # 下次请求先卸载重来，别让它继续占着显存
            log(f"出图超时（{REQUEST_TIMEOUT:.0f}s）：{exc}")
            self._send(504, {"error": {"message": str(exc)[:400]}})
            return
        except Exception as exc:
            _state["last_error"] = str(exc)[:400]
            log(f"出图失败：{exc!r}\n{traceback.format_exc()}")
            self._send(500, {"error": {"message": str(exc)[:400] or type(exc).__name__}})
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
    refs = _list_refs()
    log(f"参考图目录 {REFS}｜{len(refs)} 张｜图生图 {'开' if IMG2IMG else '关'}"
        + (f"｜默认 {_default_ref()}" if refs else ""))
    if IMG2IMG:
        log("触发词：" + "、".join(TRIGGERS))
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
