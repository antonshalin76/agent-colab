from __future__ import annotations

import json
import sys
from pathlib import Path
from uuid import UUID, uuid4

workspace = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(workspace / "sidecar"))

from translator_sidecar.provider_contract import (  # noqa: E402
    AudioDirection,
    Language,
    OpenProviderSession,
    PcmFormat,
    ProviderId,
    ProviderInputFrame,
    SampleFormat,
    TranslationMode,
    VoiceEngine,
    VoiceGender,
    VoiceProfile,
)
from translator_sidecar.provider_engine import ProviderEngine  # noqa: E402


def request() -> OpenProviderSession:
    pcm = PcmFormat(
        sample_rate_hz=16_000,
        channels=1,
        sample_format=SampleFormat.S16LE,
        frame_duration_ms=20,
    )
    return OpenProviderSession(
        session_id=uuid4(),
        provider_id=ProviderId.LOCAL,
        direction_id=AudioDirection.MICROPHONE,
        source_language=Language.RU,
        target_language=Language.EN,
        mode=TranslationMode.QUALITY_FIRST,
        requested_input_format=pcm,
        requested_output_format=pcm,
        voice_profile=VoiceProfile(
            language=Language.EN,
            gender=VoiceGender.MALE,
            engine=VoiceEngine.PIPER,
        ),
        debug_text_enabled=False,
    )


def frame(session: OpenProviderSession, sequence: int) -> ProviderInputFrame:
    utterance_id = UUID(int=sequence + 10)
    sample_count = session.requested_input_format.sample_rate_hz * 20 // 1000
    return ProviderInputFrame(
        session_id=session.session_id,
        direction_id=session.direction_id,
        stream_id=UUID(int=1),
        utterance_id=utterance_id,
        sequence=sequence,
        capture_monotonic_ns=0,
        sample_rate_hz=16_000,
        channels=1,
        sample_format=SampleFormat.S16LE,
        frame_duration_ms=20,
        source_language=session.source_language,
        target_language=session.target_language,
        mode=session.mode,
        end_of_utterance=True,
        pcm=b"\x01\x02" * sample_count,
    )


def terminal_identity_released() -> tuple[bool, str]:
    engine = ProviderEngine()
    session = request()
    engine.open_session(session)
    try:
        for sequence in range(80):
            assert engine.enqueue_frame(frame(session, sequence), now_ns=0) is None
            engine.process_next(session.session_id, now_ns=0)
            engine.drain_output(session.session_id, now_ns=0)
    except Exception as error:
        return False, f"capacity lifecycle failed: {type(error).__name__}: {error}"
    private_session = engine._sessions[session.session_id]  # noqa: SLF001
    passed = private_session.utterance_streams == {}
    return passed, "active identities released" if passed else "terminal identities remain active"


def terminal_semantics_preserved() -> tuple[bool, str]:
    from translator_sidecar.provider_engine import ProviderProtocolError

    engine = ProviderEngine()
    session = request()
    engine.open_session(session)
    original = frame(session, 0)
    try:
        assert engine.enqueue_frame(original, now_ns=0) is None
        engine.process_next(session.session_id, now_ns=0)
        engine.drain_output(session.session_id, now_ns=0)
        private_session = engine._sessions[session.session_id]  # noqa: SLF001
        tombstone_retained = original.utterance_id in private_session.terminal_utterances
        try:
            engine.enqueue_frame(original, now_ns=0)
        except ProviderProtocolError as error:
            duplicate_rejected = str(error) == "utterance_terminal"
        else:
            duplicate_rejected = False
        passed = tombstone_retained and duplicate_rejected
        return passed, "tombstone retained and duplicate rejected" if passed else "terminal semantics changed"
    except Exception as error:
        return False, f"terminal semantics failed: {type(error).__name__}: {error}"


identity_passed, identity_evidence = terminal_identity_released()
semantics_passed, semantics_evidence = terminal_semantics_preserved()
print(json.dumps({
    "protocolVersion": "agent-collab/translator-oracle/v1",
    "checks": {
        "terminalIdentityReleased": {
            "passed": identity_passed,
            "evidence": identity_evidence,
        },
        "terminalSemanticsPreserved": {
            "passed": semantics_passed,
            "evidence": semantics_evidence,
        },
    },
}, sort_keys=True))
raise SystemExit(0 if identity_passed and semantics_passed else 1)
