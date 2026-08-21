"""Authoritative current-session identity derived from iRacing SessionInfo."""


UNKNOWN = 'unknown'
SOURCE = 'iracing_session_info'

_PLACEHOLDERS = {
    '', 'unknown', 'n/a', 'none', 'null', '?', 'car', 'track',
}


def _clean(value):
    if value is None:
        return None
    text = str(value).strip().strip('"').strip("'").strip()
    if text.lower() in _PLACEHOLDERS:
        return None
    return text


def build_session_authority(session_info, current_session_num):
    """Return a stable authority payload and signature.

    Track display name is preferred for speech.  SessionType must come from
    Sessions[SessionNum]; EventType is intentionally never a fallback because
    it describes the weekend, not the currently active Practice/Qualify/Race.
    """
    info = session_info if isinstance(session_info, dict) else {}
    sessions = info.get('sessions')
    sessions = sessions if isinstance(sessions, dict) else {}

    session_num = (
        current_session_num
        if isinstance(current_session_num, int)
        and not isinstance(current_session_num, bool)
        else None
    )
    track = _clean(info.get('track_display')) or _clean(info.get('track'))
    car_model = _clean(info.get('player_car_model'))
    session_type = _clean(sessions.get(session_num)) if session_num is not None else None
    setup_fingerprint = _clean(info.get('setup_fingerprint'))

    missing = []
    if track is None:
        missing.append('track')
    if car_model is None:
        missing.append('car_model')
    if session_type is None:
        missing.append('session_type')

    payload = {
        'track': track or UNKNOWN,
        'car_model': car_model or UNKNOWN,
        'session_type': session_type or UNKNOWN,
        'session_num': session_num,
        'setup_fingerprint': setup_fingerprint or UNKNOWN,
        'setup_available': bool(info.get('setup_available')),
        'source': SOURCE,
        'complete': not missing,
        'missing': missing,
    }
    signature = (
        payload['track'],
        payload['car_model'],
        payload['session_type'],
        payload['session_num'],
    )
    return payload, signature
