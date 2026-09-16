from __future__ import annotations

import io
import zipfile

import pytest

from service.agent import cde_extract


def _minimal_docx(text: str) -> bytes:
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("word/document.xml", document)
    return output.getvalue()


def test_extract_html_ignores_script_and_keeps_visible_text() -> None:
    raw = "<html><head><title>隐藏标题</title></head><body><h1>试验标题</h1><script>bad()</script><p>入组标准</p></body></html>"
    text = cde_extract.extract_plain_text(raw.encode("utf-8"), "trial.html")
    assert "试验标题" in text
    assert "入组标准" in text
    assert "bad()" not in text


def test_extract_docx() -> None:
    assert cde_extract.extract_plain_text(_minimal_docx("临床试验内容"), "trial.docx") == "临床试验内容"


def test_extract_doc_routes_to_legacy_converter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cde_extract, "_extract_doc", lambda data: "旧版 Word 内容")
    assert cde_extract.extract_plain_text(b"binary", "trial.doc") == "旧版 Word 内容"


def test_unsupported_format_lists_supported_word_formats() -> None:
    with pytest.raises(ValueError, match="doc / docx / pdf / html"):
        cde_extract.extract_plain_text(b"data", "trial.pages")


def test_review_preserves_model_training_suggestions() -> None:
    review = cde_extract.review_from_cde(
        {"title_and_background": {"indication": "高血压", "drug_name": "测试药"}},
        {
            "stem": "Hypertension",
            "label": "高血压沟通训练",
            "description": "练习长期随访沟通",
            "difficulty": 2,
            "focus_dimensions": ["共情能力", "个性化适配"],
            "tags": ["长期随访", "家属参与"],
        },
    )
    assert review["focus_dimensions"] == ["共情能力", "个性化适配"]
    assert review["tags"] == ["长期随访", "家属参与"]
    assert review["difficulty"] == 2


def test_review_fills_missing_suggestions_from_cde() -> None:
    review = cde_extract.review_from_cde(
        {
            "basic_info": {"registration_no": "CTR20263575"},
            "title_and_background": {
                "indication": "消化系统痉挛性疼痛；急性肾绞痛",
                "phase": "其它生物等效性试验",
                "public_title": "一项药物生物等效性研究",
            },
        },
        {},
    )
    assert review["stem"] == "CTR20263575"
    assert review["label"] == "消化系统痉挛性疼痛等（其它生物等效性试验）"
    assert review["description"] == "CTR20263575：一项药物生物等效性研究"
    assert "试验试验" not in review["label"]
