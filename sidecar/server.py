# Minimal JoyCaption sidecar (GPU first; CPU only if explicitly selected)
# Endpoint: POST /predict  (multipart: image, plus form fields)
# Fields: device=gpu|cpu, quant=int8|nf4|bf16, image_side=384|448, max_tokens=160|200

import io, os, gc, subprocess, traceback
from typing import Optional
from pathlib import Path

from PIL import Image
from flask import Flask, request, jsonify

import torch
from transformers import AutoProcessor, LlavaForConditionalGeneration, BitsAndBytesConfig

import logging
import werkzeug

log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)  # only show errors, not every GET

MODEL_ID = os.environ.get("JOYCAPTION_MODEL_ID", "fancyfeast/llama-joycaption-beta-one-hf-llava")
CACHE_DIR = os.environ.get("JOYCAPTION_CACHE", None)
PORT = int(os.environ.get("JOYCAPTION_PORT", "5057"))

app = Flask(__name__)

_processor = None
_model = None
_loaded_conf = None  # (device, quant)
_compute_dtype = None  # set by _load; used by _infer

PROMPT_SDXL = (
    "You are JoyCaption. Write a Stable Diffusion/Flux prompt that will recreate the image. "
    "Style/quality tokens first, then subject, scene, lighting, composition. No negatives."
)

# -------------------
# Helpers
# -------------------
def _cuda_supports_bf16() -> bool:
    try:
        return torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    except Exception:
        return False

def _get_vision_module(root):
    try:
        core = getattr(root, "model", root)
        vt = getattr(core, "vision_tower", None)
        if vt is None:
            return None
        return getattr(vt, "vision_model", None)
    except Exception:
        return None

def _vision_has_quant_layers(vt_root) -> bool:
    if vt_root is None:
        return False
    for m in vt_root.modules():
        name = m.__class__.__name__.lower()
        if "linear4bit" in name or "linear8bit" in name:
            return True
    return False

def _coerce_id(x):
    if x is None: return None
    if isinstance(x, int): return x
    if isinstance(x, (list, tuple)) and x: return _coerce_id(x[0])
    try: return int(x)
    except Exception: return None

def _coerce_int(x, default: int) -> int:
    if isinstance(x, int): return x
    if isinstance(x, str):
        try: return int(x.strip())
        except Exception: return default
    if isinstance(x, (list, tuple)) and x: return _coerce_int(x[0], default)
    return default

def _coerce_bool(x, default: bool = False) -> bool:
    if isinstance(x, bool): return x
    if isinstance(x, (list, tuple)) and x: return _coerce_bool(x[0], default)
    if isinstance(x, str): return x.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(x, (int, float)): return x != 0
    return default

def _coerce_float(x, default: float) -> float:
    if isinstance(x, (int, float)): 
        try: return float(x)
        except Exception: return default
    if isinstance(x, str):
        try: return float(x.strip())
        except Exception: return default
    if isinstance(x, (list, tuple)) and x:
        return _coerce_float(x[0], default)
    return default

# -------------------
# Model load / unload / infer
# -------------------
def _load(device: str, quant: str):
    global _processor, _model, _loaded_conf, _compute_dtype
    if _model is not None and _loaded_conf == (device, quant):
        return (True, "ok")

    def _attempt_load(_quant: str):
        load_kwargs = {}
        if device == "gpu":
            if _quant == "int8":
                qcfg = BitsAndBytesConfig(
                    load_in_8bit=True,
                    llm_int8_enable_fp32_cpu_offload=False,
                    llm_int8_skip_modules=["vision_tower", "multi_modal_projector"]
                )
                dtype = torch.float16
                load_kwargs.update(dict(device_map="auto", quantization_config=qcfg))
            elif _quant == "nf4":
                qcfg = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=torch.bfloat16,
                    bnb_4bit_use_double_quant=True,
                    llm_int8_skip_modules=["vision_tower", "multi_modal_projector"],
                )
                dtype = torch.float16
                load_kwargs.update(dict(device_map="auto", torch_dtype="auto", quantization_config=qcfg))
            elif _quant == "bf16":
                dtype = torch.bfloat16
                load_kwargs.update(dict(device_map="auto", torch_dtype=dtype))
            else:
                return (False, f"Unknown quant: {_quant}", None, None, None)
        elif device == "cpu":
            dtype = torch.float32
            load_kwargs.update(dict(device_map={"": "cpu"}, torch_dtype=dtype))
        else:
            return (False, f"Unknown device: {device}", None, None, None)

        try:
            proc = AutoProcessor.from_pretrained(MODEL_ID, cache_dir=CACHE_DIR)
            mdl = LlavaForConditionalGeneration.from_pretrained(MODEL_ID, cache_dir=CACHE_DIR, **load_kwargs)
            return (True, "ok", proc, mdl, dtype)
        except Exception as e:
            return (False, str(e), None, None, None)

    ok, msg, proc, mdl, dtype = _attempt_load(quant)
    if not ok:
        _processor = None; _model = None; _loaded_conf = None; _compute_dtype = None
        return (False, msg)

    # 2) place vision (and projector) with quant-consistent dtypes
    try:
        vt = _get_vision_module(mdl)
        if device == "gpu" and torch.cuda.is_available():
            # Safest policy:
            # - bf16 mode: use bf16 if supported, else fp16
            # - int8/nf4: force fp16 to avoid BF16/FP16 matmul mismatches
            if quant == "bf16":
                vt_dtype = torch.bfloat16 if _cuda_supports_bf16() else torch.float16
            else:
                vt_dtype = torch.float16

            if vt is not None:
                vt.to(device="cuda", dtype=vt_dtype)

            # Also keep the projector aligned with the vision dtype
            proj = getattr(mdl, "multi_modal_projector", None)
            if proj is not None:
                proj.to(device="cuda", dtype=vt_dtype)

        else:
            # CPU path: keep everything float32
            if vt is not None:
                vt.to(device="cpu", dtype=torch.float32)
            proj = getattr(mdl, "multi_modal_projector", None)
            if proj is not None:
                proj.to(device="cpu", dtype=torch.float32)

    except Exception as e:
        print("[joycaption-err] vision tower placement note:", e, flush=True)


    if device == "gpu" and quant == "nf4":
        if _vision_has_quant_layers(_get_vision_module(mdl)):
            _processor = None; _model = None; _loaded_conf = None; _compute_dtype = None
            return (False, "nf4_strict_violation: quantization leaked into vision/projector")

    _processor = proc
    _model = mdl
    _loaded_conf = (device, quant)
    _compute_dtype = dtype
    return (True, "ok")

def _free_model():
    """
    Safely unload the current model + processor from memory/VRAM.
    Leaves CUDA context (~few hundred MB) intact.
    """
    global _processor, _model, _loaded_conf, _compute_dtype
    try:
        if _model is not None and hasattr(_model, "to"):
            try:
                _model.to("cpu")  # move weights back to host before dropping
            except Exception:
                pass
    finally:
        # Drop references
        _processor = None
        _model = None
        _loaded_conf = None
        _compute_dtype = None

        # Cleanup
        gc.collect()
        if torch.cuda.is_available():
            try: torch.cuda.empty_cache()
            except Exception: pass
            try: torch.cuda.ipc_collect()
            except Exception: pass


def _infer(img, max_new_tokens: int = 512, instructions: str = PROMPT_SDXL,
           temperature: float = 0.6, top_p: float = 0.9):
    if _model is None:
        raise RuntimeError("Model not loaded")

    convo = [
        {"role": "system", "content": "You are JoyCaption."},
        {"role": "user", "content": instructions},
    ]
    convo_string = _processor.apply_chat_template(convo, tokenize=False, add_generation_prompt=True)
    inputs = _processor(text=[convo_string], images=[img], return_tensors="pt")

    dev = _model.device if hasattr(_model, "device") else next(_model.parameters()).device
    on_cpu = str(dev).startswith("cpu")

    if "pixel_values" in inputs:
        if not on_cpu:
            px_dtype = torch.bfloat16 if _cuda_supports_bf16() else torch.float16
            inputs["pixel_values"] = inputs["pixel_values"].to(device=dev, dtype=px_dtype, non_blocking=True)
        else:
            inputs["pixel_values"] = inputs["pixel_values"].to(device=dev, dtype=torch.float32)

    target_dtype = _compute_dtype or (torch.float32 if on_cpu else torch.float16)
    for k, v in list(inputs.items()):
        if k == "pixel_values": continue
        if isinstance(v, torch.Tensor):
            if v.is_floating_point():
                inputs[k] = v.to(device=dev, dtype=target_dtype, non_blocking=not on_cpu)
            else:
                inputs[k] = v.to(device=dev, non_blocking=not on_cpu)

    try:
        gcfg = _model.generation_config
        tok = getattr(_processor, "tokenizer", None)

        eos_id = _coerce_id(getattr(gcfg, "eos_token_id", None)) or _coerce_id(getattr(tok, "eos_token_id", None))
        bos_id = _coerce_id(getattr(gcfg, "bos_token_id", None)) or _coerce_id(getattr(tok, "bos_token_id", None))
        pad_id = _coerce_id(getattr(gcfg, "pad_token_id", None)) or _coerce_id(getattr(tok, "pad_token_id", None)) or eos_id

        if eos_id is not None: gcfg.eos_token_id = eos_id
        if bos_id is not None: gcfg.bos_token_id = bos_id
        if pad_id is not None: gcfg.pad_token_id = pad_id
    except Exception:
        pass

    # Determine sampling mode:
    # - If temperature > 0, enable sampling.
    # - Also allow sampling if 0 < top_p < 1 even when temperature == 0 (nucleus only).
    do_sample = (temperature is not None and float(temperature) > 0.0) or (0.0 < float(top_p) < 1.0)

    with torch.inference_mode():
        generate_ids = _model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=do_sample,
            temperature=(None if float(temperature) <= 0.0 else float(temperature)),
            top_p=(None if not (0.0 < float(top_p) <= 1.0) else float(top_p)),
            use_cache=True,
        )[0]

    prompt_len = inputs["input_ids"].shape[1]
    generate_ids = generate_ids[prompt_len:]
    caption = _processor.tokenizer.decode(generate_ids, skip_special_tokens=True, clean_up_tokenization_spaces=False).strip()
    return caption

# -------------------
# API routes
# -------------------
@app.post("/predict")
def predict():
    def getp(name, default=None):
        if name in request.form: return request.form.get(name, default)
        if request.is_json: return (request.get_json(silent=True) or {}).get(name, default)
        return default

    file = request.files.get("image")
    image_path = getp("image_path", None)
    device = (getp("device", "gpu") or "gpu")
    quant  = (getp("quant", "int8") or "int8")

    image_side = _coerce_int(getp("image_side", getp("side", 448)), 448)
    max_tokens = _coerce_int(getp("max_tokens", 512), 512)
    write_txt  = _coerce_bool(getp("write_txt", "false"), False)
        # Sampling controls (UI -> API) with sane defaults and clamping
    temperature = _coerce_float(getp("temperature", 0.6), 0.6)
    top_p       = _coerce_float(getp("top_p", 0.9), 0.9)

    # clamp to safe ranges
    if temperature < 0.0: temperature = 0.0
    if temperature > 2.0: temperature = 2.0
    if top_p < 0.0: top_p = 0.0
    if top_p > 1.0: top_p = 1.0

    # NEW: user-provided instructions from the UI (fallback to PROMPT_SDXL)
    user_prompt = (getp("prompt", "") or "").strip()
    instructions = user_prompt if user_prompt else PROMPT_SDXL

    image_side = max(8, min(8192, image_side))
    max_tokens = max(1, min(4096, max_tokens))

    ok, msg = _load(device, quant)
    if not ok:
        emsg = str(msg)
        if "CUDA" in emsg or "cublas" in emsg or "hip" in emsg:
            return jsonify(code="GPU_LOAD_FAILED", message=emsg), 500
        return jsonify(code="LOAD_FAILED", message=emsg), 500

    img = None
    src_path: Optional[Path] = None
    if file:
        try:
            img = Image.open(io.BytesIO(file.read())).convert("RGB")
        except Exception:
            return jsonify(code="BAD_IMAGE", message="unable to decode image"), 400
    elif image_path:
        src_path = Path(image_path).expanduser().resolve()
        if not src_path.exists() or not src_path.is_file():
            return jsonify(code="BAD_PATH", message=f"image_path does not exist: {src_path}"), 400
        try:
            img = Image.open(str(src_path)).convert("RGB")
        except Exception:
            return jsonify(code="BAD_IMAGE", message="unable to open image_path"), 400
    else:
        return jsonify(code="BAD_IMAGE", message="missing image or image_path"), 400

    w, h = img.size
    if min(w, h) != image_side:
        if w < h:
            new_w = image_side
            new_h = int(h * (image_side / w))
        else:
            new_h = image_side
            new_w = int(w * (image_side / h))
        img = img.resize((new_w, new_h), Image.BICUBIC)

    try:
        text = _infer(img, max_new_tokens=max_tokens, instructions=instructions, temperature=temperature, top_p=top_p)
        text = " ".join(text.split()).strip('"')
    except torch.cuda.OutOfMemoryError:
        return jsonify(code="CUDA_OOM", message="Out of VRAM during generation"), 500
    except Exception as e:
        print("[joycaption-err] _infer exception:\n" + traceback.format_exc(), flush=True)
        return jsonify(code="INFER_FAILED", message=str(e)), 500

    txt_path = None
    if write_txt and src_path is not None:
        try:
            txt_path = str(src_path.with_suffix(".txt"))
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(text + "\n")
        except Exception as e:
            return jsonify(ok=True, text=text, txt_path=None, warn=f"write failed: {e}")

    return jsonify(ok=True, text=text, txt_path=txt_path)

@app.get("/gpu")
def gpu_status():
    gpus = []
    try:
        if torch.cuda is not None and torch.cuda.is_available():
            n = torch.cuda.device_count()
            for i in range(n):
                with torch.cuda.device(i):
                    free_b, total_b = torch.cuda.mem_get_info()
                used_b = total_b - free_b
                gpus.append({
                    "index": i,
                    "name": torch.cuda.get_device_name(i),
                    "total_bytes": int(total_b),
                    "free_bytes": int(free_b),
                    "used_bytes": int(used_b),
                })
    except Exception:
        pass
    return jsonify({"gpus": gpus, "count": len(gpus)})

@app.post("/unload")
def unload_route():
    _free_model()
    return jsonify(ok=True, message="Model + processor unloaded"), 200


@app.get("/health")
def health():
    return jsonify(loaded=(_model is not None), config=_loaded_conf or None)

@app.post("/load")
def load_route():
    device = request.form.get("device", "gpu")
    quant = request.form.get("quant", "int8")
    ok, msg = _load(device, quant)
    status = 200 if ok else 500
    return jsonify(
        status="ok" if ok else "error",
        message=msg,
        loaded=ok and (_model is not None),
        config=_loaded_conf
    ), status

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT)
