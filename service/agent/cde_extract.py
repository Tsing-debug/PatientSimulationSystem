"""CDE 临床试验资料 → 结构化登记 JSON 的抽取模块（管理员上传入口用）。

输入可以是任意常见格式的临床试验原始资料：
  - 药物临床试验登记与信息公示平台（CDE）导出的 HTML / JSON
  - Word（.docx）、PDF、Markdown、纯文本等

输出与 service/acknowledge/relative_experiment/<stem>.json 的结构一致，
即「一个适应症/疾病 → 一个新训练病例」的登记底稿，外加界面建议字段
（stem / label / description / difficulty / focus_dimensions / tags）。

流程：
  1. 先把原始字节转成纯文本（不同格式用不同解析器）；
  2. 上传的就是 JSON 时直接作为结构化结果（不调 LLM）；
  3. 其余文本交给火山方舟 LLM 抽取成目标 JSON schema。

LLM 鉴权沿用项目惯例：根目录 .env 的 TEXT_GENERATION_API_KEY（OpenAI 兼容
Chat Completions，见 service/agent/experiment_background.py）。
"""

from __future__ import annotations

import html.parser
import io
import json
import logging
import re
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import httpx

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_MODEL = "doubao-seed-character-251128"
DEFAULT_TEMPERATURE = 0.2
DEFAULT_MAX_TOKENS = 8192
DEFAULT_TIMEOUT = 180.0

TEXT_EXTENSIONS = {".md", ".markdown", ".txt"}
HTML_EXTENSIONS = {".html", ".htm"}
DOCX_EXTENSIONS = {".docx"}
DOC_EXTENSIONS = {".doc"}
PDF_EXTENSIONS = {".pdf"}
JSON_EXTENSIONS = {".json"}

# 目标 schema 示例：与 relative_experiment/*.json 保持同一字段家族。
# 深度较大的研发现场信息（investigators.sites 等）按需输出，缺失即置空。
CDE_SCHEMA_EXAMPLE: dict[str, Any] = {
    "source": "药物临床试验登记与信息公示平台",
    "source_id": "",
    "basic_info": {
        "registration_no": "CTR20263389",
        "status": "进行中",
        "status_detail": "尚未招募",
        "first_public_date": "2026-09-01",
        "applicant_name": "申办方公司名",
    },
    "title_and_background": {
        "drug_name": "CM512注射液",
        "drug_type": "生物制品",
        "indication": "慢性鼻窦炎伴鼻息肉",
        "scientific_title": "一项……的随机、双盲、安慰剂平行对照Ⅲ期临床研究",
        "public_title": "CM512注射液治疗慢性鼻窦炎伴鼻息肉的III期临床研究",
        "protocol_no": "CM512-102206",
        "phase": "III期",
    },
    "clinical_trial": {
        "purpose": {
            "primary": ["主要目的……"],
            "secondary": ["次要目的……"],
            "exploratory": [],
        },
        "design": {
            "category": "安全性和有效性",
            "phase": "III期",
            "design_type": "平行分组",
            "randomization": "随机化",
            "blinding": "双盲",
            "scope": "国内试验",
        },
        "subjects": {
            "age": "18岁(最小年龄)至75岁(最大年龄)",
            "sex": "男+女",
            "healthy_volunteers": False,
            "inclusion_criteria": ["逐条原文……"],
            "exclusion_criteria": ["逐条原文……"],
        },
        "arms": {
            "investigational_drugs": [
                {
                    "name_cn": "试验药",
                    "dosage_form": "注射液",
                    "strength": "300mg（2ml）",
                    "usage": "皮下注射，每24周给药一次",
                    "duration": "多次",
                }
            ],
            "control_drugs": [
                {
                    "name_cn": "对照药/安慰剂",
                    "dosage_form": "",
                    "strength": "",
                    "usage": "",
                    "duration": "",
                }
            ],
        },
        "endpoints": {
            "primary": [{"measure": "主要终点描述", "time_frame": "W24", "type": "有效性指标"}],
            "secondary": [],
        },
    },
    "applicant": {"names": ["申办方"]},
    "investigators": {"principal_investigators": []},
    "recruitment": {
        "target_enrollment": None,
        "enrolled": None,
        "first_informed_consent_date": None,
    },
}

SUGGEST_SCHEMA_EXAMPLE: dict[str, Any] = {
    "stem": "Chronic rhinosinusitis with nasal polyps",
    "label": "慢性鼻窦炎伴鼻息肉（III 期试验）",
    "description": "一句话说明该病例适合练什么（患者类型、沟通重点）。",
    "difficulty": 1,
    "focus_dimensions": ["信息传递", "知情同意", "耐心程度"],
    "tags": ["首次入组", "安慰剂"],
}


# ---------------------------------------------------------------------------
# 纯文本抽取（不依赖第三方解析库，尽量标准库）
# ---------------------------------------------------------------------------

class _HtmlTextExtractor(html.parser.HTMLParser):
    """去掉 script/style/标签，按块级元素断行，得到可读纯文本。"""

    _SKIP_TAGS = {"script", "style", "noscript", "head", "title"}
    _BLOCK_TAGS = {
        "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
        "br", "table", "section", "article",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1
        elif tag in self._BLOCK_TAGS and not self._skip_depth:
            self._chunks.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip_depth and data.strip():
            self._chunks.append(data)

    def text(self) -> str:
        out = "".join(self._chunks)
        return re.sub(r"\n{3,}", "\n\n", out).strip()


def _extract_docx(data: bytes) -> str:
    """docx = zip 里的 word/document.xml，取 w:t 文本并按 w:p 断行。"""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            xml_bytes = zf.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise ValueError("不是有效的 .docx 文件（需为 Word 2007+ 格式，旧 .doc 请先另存为 .docx）") from exc
    root = ET.fromstring(xml_bytes)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    parts: list[str] = []
    for para in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"):
        runs = [
            t.text or ""
            for t in para.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")
        ]
        line = "".join(runs).strip()
        if line:
            parts.append(line)
    text = "\n".join(parts)
    if not text.strip():
        raise ValueError(".docx 内未提取到文本，可能为空文档或加密")
    return text


def _extract_doc_with_cli(data: bytes) -> str:
    """用 antiword/catdoc/LibreOffice 读取旧版二进制 Word 文档。"""
    with tempfile.TemporaryDirectory(prefix="cde_doc_") as tmp:
        tmp_dir = Path(tmp)
        source = tmp_dir / "source.doc"
        source.write_bytes(data)

        for command in ("antiword", "catdoc"):
            executable = shutil.which(command)
            if not executable:
                continue
            try:
                completed = subprocess.run(
                    [executable, str(source)],
                    capture_output=True,
                    check=False,
                    timeout=60,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            if completed.returncode == 0 and completed.stdout:
                text = _decode_utf8(completed.stdout).strip()
                if text:
                    return text

        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if soffice:
            try:
                completed = subprocess.run(
                    [
                        soffice,
                        "--headless",
                        "--convert-to",
                        "txt:Text",
                        "--outdir",
                        str(tmp_dir),
                        str(source),
                    ],
                    capture_output=True,
                    check=False,
                    timeout=90,
                )
            except (OSError, subprocess.TimeoutExpired):
                completed = None
            converted = tmp_dir / "source.txt"
            if completed and completed.returncode == 0 and converted.is_file():
                text = _decode_utf8(converted.read_bytes()).strip()
                if text:
                    return text
    return ""


def _extract_doc_with_word(data: bytes) -> str:
    """Windows 上通过本机 Microsoft Word 安全地读取旧版 .doc。"""
    try:
        import pythoncom  # type: ignore
        import win32com.client  # type: ignore
    except ImportError as exc:
        raise ValueError(
            "旧版 .doc 需要 Microsoft Word + pywin32，或服务器安装 LibreOffice/antiword；"
            "也可以在 Word 中另存为 .docx 后上传。"
        ) from exc

    with tempfile.TemporaryDirectory(prefix="cde_doc_") as tmp:
        source = Path(tmp) / "source.doc"
        source.write_bytes(data)
        word: Any = None
        document: Any = None
        pythoncom.CoInitialize()
        try:
            word = win32com.client.DispatchEx("Word.Application")
            word.Visible = False
            word.DisplayAlerts = 0
            # msoAutomationSecurityForceDisable，避免上传文档运行宏。
            word.AutomationSecurity = 3
            document = word.Documents.Open(
                str(source.resolve()),
                ConfirmConversions=False,
                ReadOnly=True,
                AddToRecentFiles=False,
                PasswordDocument="",
                NoEncodingDialog=True,
            )
            text = str(document.Content.Text or "").replace("\r", "\n").strip()
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"旧版 .doc 解析失败：{exc}") from exc
        finally:
            if document is not None:
                try:
                    document.Close(False)
                except Exception:  # noqa: BLE001
                    pass
            if word is not None:
                try:
                    word.Quit()
                except Exception:  # noqa: BLE001
                    pass
            pythoncom.CoUninitialize()
    if not text:
        raise ValueError(".doc 内未提取到文本，可能为空文档、加密文档或扫描图片")
    return text


def _extract_doc(data: bytes) -> str:
    """读取 Word 97-2003 .doc；跨平台工具优先，Windows Word 作为后备。"""
    text = _extract_doc_with_cli(data)
    if text:
        return text
    return _extract_doc_with_word(data)


def _extract_pdf(data: bytes) -> str:
    """PDF 需要第三方解析库；没有就给出明确提示。"""
    reader: Any = None
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(__import__("io").BytesIO(data))
    except ImportError:
        try:
            from PyPDF2 import PdfReader  # type: ignore

            reader = PdfReader(__import__("io").BytesIO(data))
        except ImportError:
            try:
                import fitz  # type: ignore  # PyMuPDF

                doc = fitz.open(stream=data, filetype="pdf")
                text = "\n".join(page.get_text() for page in doc)
                doc.close()
                if not text.strip():
                    raise ValueError("PDF 未提取到文本（可能是扫描件），请使用可复制文本的 PDF 或改传 docx/html")
                return text
            except ImportError:
                pass
    if reader is None:
        raise ValueError(
            "服务器缺少 PDF 解析库：请在运行后端的 Python 环境安装 pypdf（pip install pypdf）后重试，"
            "或改传 docx / html / json 格式。"
        )
    try:
        pages = [str(page.extract_text() or "") for page in reader.pages]
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"PDF 解析失败：{exc}") from exc
    text = "\n".join(p for p in pages if p.strip())
    if not text.strip():
        raise ValueError("PDF 未提取到文本（可能是扫描件），请使用可复制文本的 PDF 或改传 docx/html")
    return text


def _decode_utf8(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def extract_plain_text(data: bytes, filename: str) -> str:
    """按扩展名把上传文件转成纯文本。不支持的格式抛 ValueError（带中文提示）。"""
    suffix = Path(filename or "").suffix.lower()
    if suffix in TEXT_EXTENSIONS:
        return _decode_utf8(data).strip()
    if suffix in HTML_EXTENSIONS:
        parser = _HtmlTextExtractor()
        try:
            parser.feed(_decode_utf8(data))
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"HTML 解析失败：{exc}") from exc
        text = parser.text()
        if not text:
            raise ValueError("HTML 内未提取到可见文本（可能为图片/JS 渲染页面，请复制文本保存后上传）")
        return text
    if suffix in DOCX_EXTENSIONS:
        return _extract_docx(data)
    if suffix in DOC_EXTENSIONS:
        return _extract_doc(data)
    if suffix in PDF_EXTENSIONS:
        return _extract_pdf(data)
    raise ValueError(
        f"暂不支持 .{suffix.lstrip('.')} 格式；请上传 doc / docx / pdf / html / md / txt / json。"
    )


# ---------------------------------------------------------------------------
# LLM 抽取配置与客户端
# ---------------------------------------------------------------------------

def _env_default(keys: tuple[str, ...]) -> str:
    import os

    for key in keys:
        value = os.getenv(key)
        if value and value.strip():
            return value.strip()
    return ""


@dataclass
class CdeExtractConfig:
    api_key: str = ""
    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    temperature: float = DEFAULT_TEMPERATURE
    max_tokens: int = DEFAULT_MAX_TOKENS
    timeout: float = DEFAULT_TIMEOUT
    trust_env: bool = True

    @classmethod
    def from_env(cls) -> CdeExtractConfig:
        import os

        trust_env = os.getenv("ARK_NO_PROXY", "").strip().lower() not in ("1", "true", "yes")
        return cls(
            api_key=_env_default(("TEXT_GENERATION_API_KEY", "ARK_API_KEY", "VOLC_ARK_API_KEY")),
            base_url=_env_default(("ARK_BASE_URL",)) or DEFAULT_BASE_URL,
            model=_env_default(("TEXT_GENERATION_MODEL", "ARK_MODEL",)) or DEFAULT_MODEL,
            trust_env=trust_env,
        )

    def require_api_key(self) -> None:
        if not self.api_key:
            raise ValueError(
                "缺少 LLM 鉴权信息：请在项目根目录 .env 设置 TEXT_GENERATION_API_KEY，"
                "或直接上传已结构化的 JSON 文件。"
            )


class CdeExtractAgent:
    """调用方舟大模型把临床试验资料文本抽取成 CDE 登记 JSON。"""

    def __init__(
        self,
        config: CdeExtractConfig | None = None,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config or CdeExtractConfig.from_env()
        self._client = client
        self._owns_client = client is None

    def _make_client(self, *, trust_env: bool) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.config.base_url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            timeout=self.config.timeout,
            trust_env=trust_env,
        )

    async def __aenter__(self) -> CdeExtractAgent:
        if self._client is None:
            self.config.require_api_key()
            self._client = self._make_client(trust_env=self.config.trust_env)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("CdeExtractAgent 未初始化：请用 `async with CdeExtractAgent(...)`")
        return self._client

    async def _rebuild_without_proxy(self) -> None:
        if not self._owns_client:
            return
        old = self._client
        self._client = self._make_client(trust_env=False)
        self.config.trust_env = False
        if old is not None:
            await old.aclose()

    async def _chat(self, messages: list[dict[str, str]]) -> tuple[str, dict[str, Any]]:
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
            "stream": False,
        }

        async def _post() -> httpx.Response:
            return await self._ensure_client().post("/chat/completions", json=body)

        try:
            resp = await _post()
        except httpx.ConnectError:
            if not self.config.trust_env or not self._owns_client:
                raise
            await self._rebuild_without_proxy()
            resp = await _post()

        if resp.status_code >= 400:
            raise RuntimeError(f"方舟 Chat Completions 失败 HTTP {resp.status_code}: {resp.text[:800]}")
        data = resp.json()
        try:
            text = str(data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"方舟响应格式异常: {data!r}") from exc
        return text, (data.get("usage") or {})

    async def extract(self, text: str) -> dict[str, Any]:
        schema_text = json.dumps(CDE_SCHEMA_EXAMPLE, ensure_ascii=False, indent=2)
        suggest_text = json.dumps(SUGGEST_SCHEMA_EXAMPLE, ensure_ascii=False, indent=2)
        system = (
            "你是临床试验登记资料整理助手，服务于 CRC 入组沟通模拟训练系统。\n"
            "把用户提供的临床试验原始资料（可能来自药物临床试验登记与信息公示平台 CDE，"
            "或申办方提供的方案/知情同意书等）抽取成结构化 JSON。\n\n"
            "规则：\n"
            "1. 只输出一个 JSON 对象，含两个键 cde 与 suggest；不要 markdown 代码块，不要其它说明。\n"
            "2. cde 严格按示例 schema；资料里没有的字段用空字符串/空列表/null，不要编造。\n"
            "3. 入排标准（inclusion_criteria / exclusion_criteria）尽量保留原文整句。\n"
            "4. suggest.stem 给一个简短英文疾病/试验键名（参考示例风格），供存盘文件名使用；\n"
            "   suggest.label 为中文展示名（如「慢性鼻窦炎伴鼻息肉（III 期试验）」）；\n"
            "   suggest.description 一句话说明这个病例适合练什么；difficulty 为 1~3 整数；\n"
            "   suggest.focus_dimensions 从 ['信息传递','知情同意','耐心程度','共情能力','个性化适配','尊重程度'] 选 2~3 个；\n"
            "   suggest.tags 用 2~4 个中文标签概括（如 首次入组/安慰剂/重症/家属参与）。\n"
            "5. 若资料完全无法辨认疾病或药物，cde 保持空骨架并在 suggest 中如实说明。\n\n"
            f"【cde 目标结构示例】\n{schema_text}\n\n"
            f"【suggest 目标结构示例】\n{suggest_text}"
        )
        user = (
            "请把下面的临床试验资料抽取为 JSON（资料可能较长，逐段阅读，不要遗漏入排标准）。\n\n"
            f"【资料原文】\n{text[:60000]}"
        )
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        for attempt in range(4):
            reply, usage = await self._chat(messages)
            try:
                parsed = _parse_json_reply(reply)
                if not isinstance(parsed.get("cde"), dict) or not isinstance(parsed.get("suggest"), dict):
                    raise RuntimeError("JSON 必须包含对象类型的 cde 和 suggest 字段")
                break
            except RuntimeError as exc:
                if attempt == 3:
                    raise RuntimeError("试验资料解析失败：模型连续返回不合法的 JSON，已自动重试 3 次，尚未登记任何试验。请稍后重新上传。") from exc
                # Regenerate from the original source; never guess edits to
                # medical facts or silently normalize a malformed response.
                messages = [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user + "\n\n上一次输出校验失败：" + str(exc) +
                     "\n请重新从原文抽取完整 JSON。检查字段间逗号、字符串中的双引号转义和括号闭合；只返回合法 JSON，不要编造或省略原文信息。"},
                ]
        cde = parsed.get("cde") if isinstance(parsed.get("cde"), dict) else {}
        suggest = parsed.get("suggest") if isinstance(parsed.get("suggest"), dict) else {}
        return {"cde": _normalize_cde(cde), "suggest": _normalize_suggest(suggest), "usage": usage}


def _parse_json_reply(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("模型未返回 JSON 对象，请重试")
    try:
        data = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"模型返回的 JSON 解析失败：{exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("模型返回的 JSON 根节点必须是对象")
    return data


def _as_str_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _normalize_cde(cde: dict[str, Any]) -> dict[str, Any]:
    """把模型输出整理成干净骨架：缺字段补默认值，数组去重。"""
    basic = cde.get("basic_info") if isinstance(cde.get("basic_info"), dict) else {}
    tab = cde.get("title_and_background") if isinstance(cde.get("title_and_background"), dict) else {}
    trial = cde.get("clinical_trial") if isinstance(cde.get("clinical_trial"), dict) else {}
    subjects = trial.get("subjects") if isinstance(trial.get("subjects"), dict) else {}
    return {
        "source": str(cde.get("source") or "上传资料"),
        "source_id": str(cde.get("source_id") or ""),
        "basic_info": {
            "registration_no": str(basic.get("registration_no") or ""),
            "status": str(basic.get("status") or ""),
            "status_detail": str(basic.get("status_detail") or ""),
            "first_public_date": str(basic.get("first_public_date") or ""),
            "applicant_name": str(basic.get("applicant_name") or ""),
        },
        "title_and_background": {
            "drug_name": str(tab.get("drug_name") or ""),
            "drug_type": str(tab.get("drug_type") or ""),
            "indication": str(tab.get("indication") or ""),
            "scientific_title": str(tab.get("scientific_title") or ""),
            "public_title": str(tab.get("public_title") or ""),
            "protocol_no": str(tab.get("protocol_no") or ""),
            "phase": str(tab.get("phase") or (trial.get("design") or {}).get("phase") or ""),
        },
        "clinical_trial": {
            "purpose": {
                "primary": _as_str_list((trial.get("purpose") or {}).get("primary")),
                "secondary": _as_str_list((trial.get("purpose") or {}).get("secondary")),
                "exploratory": _as_str_list((trial.get("purpose") or {}).get("exploratory")),
            },
            "design": {
                "category": str((trial.get("design") or {}).get("category") or ""),
                "phase": str((trial.get("design") or {}).get("phase") or ""),
                "design_type": str((trial.get("design") or {}).get("design_type") or ""),
                "randomization": str((trial.get("design") or {}).get("randomization") or ""),
                "blinding": str((trial.get("design") or {}).get("blinding") or ""),
                "scope": str((trial.get("design") or {}).get("scope") or ""),
            },
            "subjects": {
                "age": str(subjects.get("age") or ""),
                "sex": str(subjects.get("sex") or ""),
                "healthy_volunteers": bool(subjects.get("healthy_volunteers", False)),
                "inclusion_criteria": _as_str_list(subjects.get("inclusion_criteria")),
                "exclusion_criteria": _as_str_list(subjects.get("exclusion_criteria")),
            },
            "arms": {
                "investigational_drugs": _as_str_list(_drugs((trial.get("arms") or {}).get("investigational_drugs"))),
                "control_drugs": _as_str_list(_drugs((trial.get("arms") or {}).get("control_drugs"))),
            },
            "endpoints": {
                "primary": [
                    {
                        "measure": str(e.get("measure") or ""),
                        "time_frame": str(e.get("time_frame") or ""),
                        "type": str(e.get("type") or "有效性指标"),
                    }
                    for e in (trial.get("endpoints") or {}).get("primary") or []
                    if isinstance(e, dict)
                ],
                "secondary": [
                    {
                        "measure": str(e.get("measure") or ""),
                        "time_frame": str(e.get("time_frame") or ""),
                        "type": str(e.get("type") or "有效性指标"),
                    }
                    for e in (trial.get("endpoints") or {}).get("secondary") or []
                    if isinstance(e, dict)
                ],
            },
        },
        "recruitment": {
            "target_enrollment": (cde.get("recruitment") or {}).get("target_enrollment"),
            "enrolled": (cde.get("recruitment") or {}).get("enrolled"),
            "first_informed_consent_date": (cde.get("recruitment") or {}).get("first_informed_consent_date"),
        },
    }


def _drugs(value: Any) -> list[str]:
    """arms 里的药物条目抽成一行简介。"""
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    out: list[str] = []
    for item in value or []:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif isinstance(item, dict):
            bits = [str(item.get(k) or "") for k in ("name_cn", "strength", "usage")]
            out.append("；".join(b for b in bits if b))
    return out


def _normalize_suggest(suggest: dict[str, Any]) -> dict[str, Any]:
    dims = [
        d
        for d in _as_str_list(suggest.get("focus_dimensions"))
        if d in ("信息传递", "知情同意", "耐心程度", "共情能力", "个性化适配", "尊重程度")
    ]
    difficulty = suggest.get("difficulty")
    try:
        difficulty = max(1, min(3, int(difficulty)))
    except (TypeError, ValueError):
        difficulty = 1
    return {
        "stem": str(suggest.get("stem") or "").strip(),
        "label": str(suggest.get("label") or "").strip(),
        "description": str(suggest.get("description") or "").strip(),
        "difficulty": difficulty,
        "focus_dimensions": dims or ["信息传递", "知情同意"],
        "tags": _as_str_list(suggest.get("tags"))[:5],
    }


def suggestion_from_cde(cde: dict[str, Any]) -> dict[str, Any]:
    """结构化 JSON 上传时，不需要 LLM，直接从字段拼一份建议。"""
    tab = cde.get("title_and_background") or {}
    basic = cde.get("basic_info") or {}
    indication = str(tab.get("indication") or "").strip()
    phase = str(tab.get("phase") or "").strip()
    drug = str(tab.get("drug_name") or "").strip()
    registration_no = str(basic.get("registration_no") or "").strip()
    public_title = str(tab.get("public_title") or tab.get("scientific_title") or "").strip()

    # 展示名只取第一项适应症，避免把一整串分号列表塞进卡片标题。
    first_indication = re.split(r"[；;。\n]", indication, maxsplit=1)[0].strip()
    if indication and first_indication != indication:
        first_indication += "等"
    phase_label = phase if "试验" in phase else (f"{phase}试验" if phase else "")
    subject = first_indication or drug or registration_no or "未命名病例"
    label = f"{subject}（{phase_label}）" if phase_label else subject

    # CTR 登记号天然唯一、英文安全，优先作为文件键名兜底。
    safe_registration = re.sub(r"[^A-Za-z0-9._-]+", "-", registration_no).strip("-._")
    safe_drug = re.sub(r"[^A-Za-z0-9._-]+", "-", drug).strip("-._")
    stem = safe_registration or safe_drug

    summary = public_title or indication or drug
    if registration_no and summary:
        description = f"{registration_no}：{summary}"
    else:
        description = summary or f"{subject}沟通训练"
    return {
        "stem": stem,
        "label": label,
        "description": description[:240],
        "difficulty": 1,
        "focus_dimensions": ["信息传递", "知情同意"],
        "tags": ["首次入组"] if indication else [],
    }


def review_from_cde(
    cde: dict[str, Any],
    model_suggest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """import 接口的返回：把抽取结果与建议合并成一个可审阅的 review 对象。"""
    cde = _normalize_cde(cde)
    fallback = suggestion_from_cde(cde)
    if isinstance(model_suggest, dict):
        generated = _normalize_suggest(model_suggest)
        suggest = {
            "stem": generated["stem"] or fallback["stem"],
            "label": generated["label"] or fallback["label"],
            "description": generated["description"] or fallback["description"],
            "difficulty": generated["difficulty"],
            "focus_dimensions": generated["focus_dimensions"] or fallback["focus_dimensions"],
            "tags": generated["tags"] or fallback["tags"],
        }
    else:
        suggest = fallback
    warnings: list[str] = []
    basic = cde.get("basic_info") or {}
    tab = cde.get("title_and_background") or {}
    if not basic.get("registration_no"):
        warnings.append("未识别到 CTR 登记号，请人工补充（如资料为院内方案可留空）")
    if not tab.get("indication"):
        warnings.append("未识别到适应症/疾病名称，请人工补充后登记")
    if not tab.get("drug_name"):
        warnings.append("未识别到试验药物名称")
    return {
        "cde": cde,
        "stem": suggest["stem"],
        "label": suggest["label"],
        "description": suggest["description"],
        "difficulty": suggest["difficulty"],
        "focus_dimensions": suggest["focus_dimensions"],
        "tags": suggest["tags"],
        "warnings": warnings,
    }
