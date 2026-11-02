# 运行环境（一套环境同时跑「说话」和「唱歌」）

完整操作步骤见 **[QUICKSTART.md](QUICKSTART.md)**（三步）；本文只讲环境与版本组合。

本插件有两个 GPU 侧依赖：

| 侧 | 用途 | 关键依赖 |
|---|---|---|
| **说话** | Breeze TTS 2 本地推理（可选，云端不需要） | torch 2.9.1+cu128 / triton-windows / qwen-tts / transformers |
| **唱歌** | RVC 换声 + pymss 分离 | torch / faiss-cpu / pymss / torchfcpe / praat-parselmouth / onnxruntime-gpu |

两边**可以共用一个环境**（2026-10-31 在 RTX 3080 / Windows / Python 3.11 上实测通过）：
numpy 2.4.6、torch 2.9.1、transformers 4.57.3 这一套组合，RVC 的换声、分离、rmvpe 全部正常。

> 老环境用的是 numpy 1.26 + torch 2.7.1，也能跑唱歌；但本地说话要求 torch 2.9.1 + numpy≥2，
> 所以想"一套环境两用"就要按下面这套版本来。

## 环境布局：两个环境，三件事

| 环境 | 路径 | 负责 | 关键版本 |
|---|---|---|---|
| **`say-sing`** | `E:\APP\Anaconda\envs\say-sing` | **说话（Breeze TTS）+ 唱歌（RVC）** | torch 2.9.1+cu128 / transformers 4.57.3 / numpy 2.4.6 |
| **画图 venv** | `<仓库>\draw-model\.venv` | **画图（Qwen-Image-2.1-Turbo）** | torch 复用 say-sing / diffusers 0.42.1 / transformers 5.22.1 |

画图的 venv 用 `python -m venv --system-site-packages draw-model\.venv` 建（复用 say-sing 的 torch），
**不要把 diffusers 装进 say-sing**：diffusers 0.42 要求 `huggingface_hub>=1.32`，而 `qwen-tts` 钉死
`transformers==4.57.3`（要 hub<1.0）—— 两者在同一个环境里不可能同时满足。详见 [DRAW.md](DRAW.md)。

> 早期用的是两个环境（`sing` 说话 / `rvc` 唱歌），2026-11-02 合并成 `say-sing` 一个：
> RVC 换声实测在 torch 2.9.1 + numpy 2.4 下正常（27-33 秒/首）。

## 从零装（Windows）

```powershell
# 0) 建环境（Python 3.10+，验证过 3.11）
conda create -n say-sing python=3.11 -y
conda activate say-sing

# 1) torch 走 cu128 索引（PyPI 上是 CPU 版，装错会 torch.cuda.is_available()=False）
python -m pip install torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128

# 国内太慢就手动下轮子（cp311 + win_amd64），再本地装：
#   torch-2.9.1+cu128-cp311-cp311-win_amd64.whl        (2.67 GB)
#   torchaudio-2.9.1+cu128-cp311-cp311-win_amd64.whl
# python -m pip install --no-index --find-links <轮子目录> "torch==2.9.1+cu128" "torchaudio==2.9.1+cu128"

# 2) 说话 + 唱歌的全部依赖（根目录一份 requirements.txt，含 triton 与 RVC 侧）
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 3) 自检
python -c "import torch, triton, faiss, pymss, parselmouth, librosa; print(torch.__version__, torch.cuda.is_available())"
```

期望输出形如 `2.9.1+cu128 True`。

## 两个必须知道的坑

| 坑 | 说明 |
|---|---|
| **triton 不是可选项** | Breeze 的 `models/fast_streaming.py` 在 import 期就 `import triton`，即使不用 int8 也会 `ModuleNotFoundError`。必须装 `triton-windows==3.5.1.post24`（3.6+ 会让 Inductor 报 `'KernelMetadata' object has no attribute 'cluster_dims'`） |
| **pip 会偷偷装 CPU 版 torch** | `qwen-tts` 依赖 torch，若只给 PyPI 源会拉到 `2.x+cpu`。根目录 `requirements.txt` 已经写了 `--extra-index-url https://download.pytorch.org/whl/cu128` + `torch==2.9.1+cu128`，照它装就不会错 |
| **`say-model/requirements.txt` 别直接用** | 那是上游 Breeze 仓库自带的（缺 triton、torch 会拉 CPU 版），只作参考。装依赖一律用**仓库根目录**的 `requirements.txt` |

## 不用本地说话的话

只跑"唱歌"，用老环境即可（numpy 1.26 / torch 2.7.1），不需要 triton 与 qwen-tts。
说话走云端（`say.engine = "breeze"`）时，网关侧零 GPU 依赖。
