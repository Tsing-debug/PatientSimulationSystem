from service.agent.patient_turn import detect_forced_end


def test_explicit_crc_end_request_forces_session_end() -> None:
    result = detect_forced_end("好的，结束测评")
    assert result is not None
    assert result[1] == "CRC 主动结束测评"


def test_abusive_crc_message_forces_session_end() -> None:
    result = detect_forced_end("你这个废物，闭嘴")
    assert result is not None
    assert result[1] == "沟通不尊重，患者终止交流"

