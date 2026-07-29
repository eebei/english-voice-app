"""
OMORAY PITWALL - iRacing Bridge  BUILD 2026-07-04-039
Reads iRacing shared memory directly
Features: lap times, personal best, tire temps, iRating, SOF, Safety Rating, track info
Requires: pip install websockets
Usage: python bridge.py
"""

import asyncio
import os
import sys
import json
import re
import mmap
import ctypes
import struct
import time
import math
import random
from datetime import datetime
import threading
import websockets

# ⚠️標準出力/エラーをutf-8に。Windowsコンソールはcp932で、Lunaの返答に含まれる — や · 等を
#   printするとUnicodeEncodeErrorで落ちていた（2026/7/7の接続断の主因）。またmain.js(Electron)は
#   bridgeのstdoutをそのままデバッグログに書くため、cp932化けが「?」としてログに残る問題もあった。
#   utf-8に固定すれば print が落ちず、ログにも正しい日本語が残る（errors=replaceで最後の保険）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ★2026-07-21（Codexレビュー P0-2）：ヘッダーオフセット定数・共有メモリreaderは irsdk_mem.py が
#   唯一の真実源。log_strategy_timeseries.py が独自定義とズレて共有メモリを誤読した事故と、
#   独自FFI実装がargtypesを欠いていた事故の再発防止。
import irsdk_mem
import race_lifecycle
import class_map
import driver_activity as driver_activity_mod
import final_lap
import fuel_strategy as fuel_strategy_mod
import session_authority as session_authority_mod

# ⚠️ビルドを更新したらここを必ず変える（ログでexe版を判別するため。今まで固定で混乱の元だった）。
BUILD_VERSION = "2026-07-07-B (gap/fuel/autoflow/stream)"
PORT = 8765
connected_clients = set()
loop = None

# ログは実行ファイル（exe/py）と同じ場所に書く（どこに置いても動く）
try:
    _base = os.path.dirname(os.path.abspath(sys.argv[0])) or os.getcwd()
except Exception:
    _base = "."
LOG_PATH = os.path.join(_base, "bridge_log.txt")

# ⚠️PTT/音量設定は実行ファイルと同じ場所ではなく、OS標準の永続フォルダに保存する。
# desktop版はportable形式で毎回ランダムな一時フォルダに展開されるため、_base基準だと
# 設定ファイルも使い捨てフォルダに書かれ、次回起動時には消えている（設定が復元されない不具合の原因）。
try:
    _appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    _config_dir = os.path.join(_appdata, "OMORAY-PITWALL")
    os.makedirs(_config_dir, exist_ok=True)
except Exception:
    _config_dir = _base
PTT_CONFIG_PATH = os.path.join(_config_dir, "ptt_config.json")
VOL_CONFIG_PATH = os.path.join(_config_dir, "vol_config.json")
MIC_CONFIG_PATH = os.path.join(_config_dir, "mic_config.json")

# ── PTT（プッシュ・トゥ・トーク）状態 ──
ptt_binding = None        # {"joy": int, "button": int, "name": str}
ptt_capturing = False     # 設定モード（次に押されたボタンを登録）
ptt_pressed = False       # 現在押下中か
ptt_lang = "ja-JP"        # STT言語（選択キャラに追従。English勢=en-GB/en-US、日本語勢=ja-JP）
ptt_mismatch_warned = False  # 登録デバイスが見つからない事を通知済みか（毎スキャンで連呼しない）
ptt_discard_recording = False  # rendererがbusy等で拒否した即時録音をSTTへ送らない

# ── コスト計測用session_id（rendererから受け取りメモリ保持。認証には使わない）──
usage_session_id = None

# ── 音量ボタン（ステアリングのダイヤル/ボタンで走行中に音量上下）──
vol_binding = {"up": None, "down": None}   # 各 {"joy": int, "button": int}
vol_capturing = None       # 設定モード中の対象 'up' | 'down' | None
vol_pressed = {"up": False, "down": False} # 各方向の現在押下状態（エッジ検出用）

def load_ptt_config():
    global ptt_binding
    try:
        with open(PTT_CONFIG_PATH, "r", encoding="utf-8") as f:
            ptt_binding = json.load(f)
    except Exception:
        ptt_binding = None

def save_ptt_config():
    try:
        with open(PTT_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(ptt_binding, f)
    except Exception:
        pass

def load_vol_config():
    global vol_binding
    try:
        with open(VOL_CONFIG_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
            if isinstance(d, dict):
                vol_binding = {"up": d.get("up"), "down": d.get("down")}
    except Exception:
        vol_binding = {"up": None, "down": None}

def save_vol_config():
    try:
        with open(VOL_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(vol_binding, f)
    except Exception:
        pass

TTS_API_KEY = ""  # bridgeはRailway STT proxyを使うので空でもOK（直接Google API呼ばない場合）

# 独自ドメインのDNS障害からBridgeのSTT経路を分離する。
RAILWAY_URL = "https://english-voice-app-production.up.railway.app"

# コーナー単位サイドバイサイド検知の舵角しきい値（ラジアン）。
# ⚠️車種でステアリング比が違う(GT3は切れ角大、フォーミュラは小さい)ため固定値の限界あり。
# 実走テストで誤検知/未検知が出たら、この2値をチューニングする(Yuji方針・2026-07-14)。
CORNER_ENTRY_RAD = 0.10   # 約5.7度。これを超えたら「コーナー進入」候補
CORNER_EXIT_RAD = 0.04    # 約2.3度。これを下回ったら「コーナー脱出」候補（ヒステリシスで閾値付近のふらつき対策）

# ── 発話タイミング「間合い」ゲート（Version A・2026-07-16 Yuji設計。舵角も加味）──
# よく喋るAIでなく"間合いを読むエンジニア"。プロアクティブ無線(ラップタイム/ペース/ギャップ等)は
# ブレーキング/コーナリング中に"喋り始めない"。ほぼ直進かつブレーキ踏んでない窓でだけ開始する。
# 安全直結(隣接車/クラッシュ/損傷等)は常に即・ゲート無視。既に喋ってるのは止めない(開始だけゲート)。
# ⚠️車種でステア比が違うので実走で要チューニング。閾値は初期値。
SPEAK_STEER_RAD = 0.12    # 約7度未満＝ほぼ直進とみなす
SPEAK_BRAKE_TH  = 0.12    # ブレーキ12%未満＝ブレーキしてないとみなす
SPEAK_HOLD_MAX  = 4.0     # 窓が開くまでの最大保留秒。これを超えた古い情報は捨てる（陳腐化防止）

# シリーズ固有のクラス略称/飾り名を、口頭で分かりやすい一般的なカテゴリー名に変換する
# （例：IMSA23シリーズのGT3規定クラスは"IMSA23"という略称だが、喋る時は"GT3"の方が伝わる）。
# ⚠️iRacingはシリーズ/AIレースごとにクラス名へ独自の飾り名を付ける（例「Crev GT3 2026」）。
#   ①まず完全一致の別名表、②無ければ名前に標準カテゴリー語(GT3/GTP等)が含まれていればそこへ丸める。
#   これで新シリーズが「〇〇 GT3 20XX」等でも自動で「GT3」に集約される(Yuji方針・2026-07-14/16)。
CLASS_NAME_ALIASES = {'IMSA23': 'GT3', 'Dallara P217': 'P217', 'Dallara P217 LMP2': 'P217'}
# 順序＝より具体的/長いトークンを先に（"GT3"が"GTP"等に誤マッチしないよう単語単位で判定）。
_CLASS_CATEGORY_TOKENS = ['GTP', 'LMP2', 'LMP3', 'GT3', 'GT4', 'GTE', 'P217', 'TCR']

def _norm_class_name(name):
    if not name:
        return name
    if name in CLASS_NAME_ALIASES:
        return CLASS_NAME_ALIASES[name]
    _u = name.upper()
    for _tok in _CLASS_CATEGORY_TOKENS:
        if _tok in _u:
            return _tok
    return name

_ORDINALS_EN = {1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th'}

def _class_id_txt_en(class_name, class_pos):
    label = _norm_class_name(class_name) or 'faster class'
    if class_pos and 1 <= class_pos <= 5:
        return label + ' ' + _ORDINALS_EN[class_pos] + ' car'
    return label + ' class'

def _fmt_gap(g):
    # 車間秒数の読み上げ用フォーマット。ぴったりの数字(9.0/10.0)は小数点を出さない
    # （「9秒」でなく「9.0秒」とTTSが律儀に読んでしまう問題への対応・Yuji指摘2026-07-14）。
    r = round(g, 1)
    return str(int(r)) if r == int(r) else str(r)

def _catchup_stage_of(g):
    # 段階的キャッチアップ/ディフェンスコールの距離帯判定（10/7/3/1.5秒）
    if g <= 1.5: return 4
    if g <= 3.0: return 3
    if g <= 7.0: return 2
    if g <= 10.0: return 1
    return 0

def log(msg):
    line = "[" + datetime.now().strftime("%H:%M:%S") + "] " + msg
    # ⚠️Windowsコンソールはcp932。会話ログ(Lunaの返答)に含まれる — や · 等cp932に無い文字を
    #   printするとUnicodeEncodeErrorが発生し、呼び出し元のWS接続ハンドラごとクラッシュ→
    #   ブラウザ切断→「Connection error」の主因だった(2026/7/7判明)。printを絶対に例外で
    #   落とさないよう保護する。ファイル(utf-8)には完全な文字列を残す。
    try:
        print(line, flush=True)
    except Exception:
        try:
            print(line.encode("ascii", "replace").decode("ascii"), flush=True)
        except Exception:
            pass
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

# ── マイク入力（PTT用・ネイティブキャプチャ）──
# pyaudioでマイクから直接音声をキャプチャ（フルスクリーン背後でも動作）
ptt_audio = None
ptt_recording = False
ptt_test_active = False       # マイクテストモード（レベルメーターだけ流す・STT送信しない）
selected_mic_index = None     # 使用する入力デバイスのindex。None=システム既定

def load_mic_config():
    global selected_mic_index
    try:
        with open(MIC_CONFIG_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
            idx = d.get("index")
            selected_mic_index = idx if isinstance(idx, int) else None
    except Exception:
        selected_mic_index = None

def save_mic_config():
    try:
        with open(MIC_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump({"index": selected_mic_index}, f)
    except Exception:
        pass

def init_mic():
    global ptt_audio
    try:
        import pyaudio
        ptt_audio = pyaudio.PyAudio()
        log("PTT: pyaudio initialized")
        return True
    except Exception as e:
        log("PTT: pyaudio init failed - " + str(e))
        return False

def _fix_device_name(raw, idx):
    """Windowsのマイクデバイス名がPyAudio経由で文字化けする（日本語Windowsでcp932の名前が誤デコード
    される）ため、安全な範囲で復元する。①正しい名前(ASCII/正しく復号済み)は壊さない ②cp932バイトが
    latin-1で誤デコードされた典型的な化けはround-tripで日本語に戻す ③空/不明なら番号ラベル。
    ※PyAudioの復号経路は環境依存で、UTF-8のロス付きデコードで元が失われている場合は復元不可＝ベスト
      エフォート。どちらにせよ選択はindexで行い、★(既定)とテスト/メーターで確実に選べるようにしてある。"""
    try:
        s = raw if isinstance(raw, str) else bytes(raw).decode('cp932', 'replace')
    except Exception:
        s = None
    if not s:
        return 'Microphone ' + str(idx)
    if all(ord(c) < 128 for c in s):   # ASCIIのみ＝化けようがない
        return s
    try:
        recovered = s.encode('latin-1').decode('cp932')   # latin-1で誤デコードされたcp932を戻す
        if recovered and '�' not in recovered:
            return recovered
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass   # 正しい日本語(latin-1に載らない)や復元不可はそのまま返す
    return s

def _clean_display_name(raw, idx):
    """表示用のデバイス名を整える。Windowsのマイク名は「<日本語の説明> (<英語のデバイス名>)」形式が多く、
    括弧内の英語が確実な識別子。前置きの日本語(化ける/冗長)は捨てて括弧内の英語を優先する
    (Yuji方針：英語で足りるなら日本語省略＝文字化けも消える)。括弧が無ければ復元済みの名前をそのまま。"""
    fixed = _fix_device_name(raw, idx)
    m = re.search(r'\(([^()]*[A-Za-z][^()]*)\)', fixed)   # 英字を含む括弧内＝英語デバイス名
    if m:
        inner = m.group(1).strip()
        if inner:
            return inner
    return fixed

def list_input_devices():
    """マイク(入力デバイス)を列挙。[{index,name,is_default}] を返す（UIのマイク選択用）。
    同一デバイスがWindowsの複数のオーディオ方式(MME/DirectSound/WASAPI等)で重複して出るので、
    表示名で重複を1つに絞る(Yuji方針B：利用者が迷わないように)。既定デバイスは優先して残す。"""
    devices = []
    if not ptt_audio:
        return devices
    try:
        default_idx = None
        try:
            default_idx = ptt_audio.get_default_input_device_info().get('index')
        except Exception:
            default_idx = None
        seen = {}   # 表示名 -> devicesの要素（重複排除・既定優先）
        for i in range(ptt_audio.get_device_count()):
            try:
                info = ptt_audio.get_device_info_by_index(i)
                if int(info.get('maxInputChannels', 0)) <= 0:
                    continue
                disp = _clean_display_name(info.get('name'), i)
                is_def = (i == default_idx)
                if disp in seen:
                    # 既に同名あり＝重複。既定デバイスなら、そちらのindexに差し替えて★を付ける。
                    if is_def and not seen[disp]['is_default']:
                        seen[disp]['index'] = i
                        seen[disp]['is_default'] = True
                    continue
                entry = {'index': i, 'name': disp, 'is_default': is_def}
                seen[disp] = entry
                devices.append(entry)
            except Exception:
                continue
    except Exception as e:
        log("mic enumerate error: " + str(e))
    return devices

def _rms_level(data):
    """16bit PCMチャンクの音量を0-100で返す（レベルメーター用）。約5000で満タン相当。"""
    try:
        import array, math
        a = array.array('h')
        a.frombytes(data)
        n = len(a)
        if not n:
            return 0
        s = 0
        for v in a:
            s += v * v
        rms = math.sqrt(s / n)
        return max(0, min(100, int(rms / 5000 * 100)))
    except Exception:
        return 0

def start_ptt_record():
    global ptt_recording, ptt_discard_recording
    if not ptt_audio:
        return False
    if ptt_recording:
        log("PTT: duplicate start ignored")
        return False
    ptt_discard_recording = False
    ptt_recording = True
    log("PTT: recording started (native pyaudio)")
    return True

def stop_ptt_record():
    global ptt_recording
    if not ptt_recording:
        log("PTT: duplicate stop ignored")
        return False
    ptt_recording = False
    log("PTT: recording stopped, sending to STT...")
    return True

def abort_ptt_record():
    """即時録音開始後、rendererがbusyなら現在テイクを破棄する。"""
    global ptt_recording, ptt_discard_recording
    ptt_discard_recording = True
    ptt_recording = False
    log("PTT: recording aborted by renderer")

def record_ptt_audio():
    """バックグラウンドスレッド：キャプチャ要求(録音 or マイクテスト)ごとにストリームを開き、
    入力レベルをUIへ流す。録音時はWAV化してSTTへ送る。テスト時はレベルのみ。
    ⚠️ストリームをキャプチャの都度開き直すことで、UIでマイクを切り替えたら次のキャプチャから
      即反映される（旧実装は起動時に"システム既定"デバイスで1回だけ開いて固定していた——SIM PCで
      別デバイスが既定になっていると無音を拾い「didn't catch that」になる根本原因だった）。"""
    global ptt_recording, ptt_test_active, ptt_discard_recording
    if not ptt_audio:
        log("PTT record: pyaudio not initialized, skipping")
        return
    import pyaudio, base64, wave
    CHUNK = 1024
    FORMAT = pyaudio.paInt16   # LINEAR16 = Google STT互換（Float32ではない）
    CHANNELS = 1
    RATE = 16000
    while True:
        if not (ptt_recording or ptt_test_active):
            time.sleep(0.03)
            continue
        dev_idx = selected_mic_index   # このキャプチャで使うデバイス（切替を都度反映）
        try:
            stream = ptt_audio.open(format=FORMAT, channels=CHANNELS, rate=RATE,
                                    input=True, frames_per_buffer=CHUNK,
                                    input_device_index=dev_idx)
        except Exception as e:
            log("PTT: mic open failed (device=%s): %s" % (str(dev_idx), str(e)))
            broadcast({'type': 'mic_error', 'message': str(e)})
            ptt_recording = False
            ptt_test_active = False
            time.sleep(0.3)
            continue
        log("PTT: mic stream open (device=%s)" % str(dev_idx))
        frames = []
        was_recording = False
        _tick = 0
        try:
            while ptt_recording or ptt_test_active:
                try:
                    data = stream.read(CHUNK, exception_on_overflow=False)
                except Exception as e:
                    log("PTT read error: " + str(e))
                    break
                if ptt_recording:
                    frames.append(data)
                    was_recording = True
                _tick += 1
                if _tick % 2 == 0:   # 約8回/秒でレベル送信（メーター用・軽量）
                    broadcast({'type': 'mic_level', 'level': _rms_level(data)})
        finally:
            try:
                stream.stop_stream(); stream.close()
            except Exception:
                pass
        broadcast({'type': 'mic_level', 'level': 0})   # メーターを戻す
        if ptt_discard_recording:
            ptt_discard_recording = False
            log("PTT: discarded aborted recording")
            continue
        if was_recording and frames:
            # WAVファイルはWindows対応パスに（/tmpはWindows未対応）
            wav_file = os.path.join(_base, "ptt_audio.wav")
            raw = b''.join(frames)
            # ── マイク自動ゲイン（2026-07-17 Yuji方針）──
            # 静かなマイクでもSTTが通るよう、ピーク音量を目標まで自動で底上げする。3人中2人が
            # マイク音量問題を踏んだため、Windowsをいじらせずアプリ側で吸収する。無音は増幅しない
            # （ノイズを大きくしないため）。クリップは飽和処理。audioop不可の環境では黙ってスキップ。
            peak = 0
            try:
                import audioop
                peak = audioop.max(raw, 2)          # 2バイト=16bit
                TARGET = 22000                       # int16(32767)の約2/3。歪ませず十分な音量
                if 200 < peak < TARGET:              # 無音(<200)は触らない／既に十分なら触らない
                    gain = min(8.0, TARGET / float(peak))
                    raw = audioop.mul(raw, 2, gain)  # クリップは内部で飽和
                    log("PTT: auto-gain x%.1f (peak %d -> ~%d)" % (gain, peak, int(peak * gain)))
            except Exception as _ge:
                log("PTT auto-gain skipped: " + str(_ge))
            try:
                sample_width = ptt_audio.get_sample_size(FORMAT)
                # rawはLINEAR16のraw PCM(gain調整後)なので、byte数から正確な秒数を逆算できる
                # （WEBM_OPUS等の圧縮音声と違い、ここは推測不要の実測値）。
                duration_seconds = len(raw) / float(RATE * CHANNELS * sample_width)
                if duration_seconds < 0.35:
                    log("PTT DIAG: too_short duration=%.2fs peak=%s device=%s" % (
                        duration_seconds, str(peak), str(dev_idx)))
                    broadcast({'type': 'ptt_diagnostic', 'reason': 'too_short',
                               'duration': round(duration_seconds, 2)})
                    continue
                if peak < 200:
                    log("PTT DIAG: no_signal duration=%.2fs peak=%s device=%s" % (
                        duration_seconds, str(peak), str(dev_idx)))
                    broadcast({'type': 'ptt_diagnostic', 'reason': 'no_signal',
                               'duration': round(duration_seconds, 2)})
                    continue
                with wave.open(wav_file, 'wb') as wf:
                    wf.setnchannels(CHANNELS)
                    wf.setsampwidth(sample_width)
                    wf.setframerate(RATE)
                    wf.writeframes(raw)
                with open(wav_file, 'rb') as f:
                    b64 = base64.b64encode(f.read()).decode()
                log("PTT: wav saved (%d bytes, %.2fs), sending to STT" % (len(b64), duration_seconds))
                # Python/urllibだけWindows DNS(getaddrinfo)に失敗し、同じPCのElectron側HTTPSは
                # 正常という実機事例が発生。STTもchat/TTSと同じElectron通信経路へ統一する。
                broadcast({'type': 'ptt_audio', 'audio': b64,
                           'encoding': 'LINEAR16', 'sampleRateHertz': RATE,
                           'languageCode': ptt_lang,
                           'audioDurationSeconds': duration_seconds,
                           'usageSessionId': usage_session_id})
            except Exception as e:
                log("PTT wav/stt error: " + str(e))

# ══════════════════════════════════════════════════════════════════════════
# ★★2026-07-20 無線ディレクター（発話アーキテクチャの全面再設計）★★
# ══════════════════════════════════════════════════════════════════════════
# 【なぜ作ったか】
#   これまで発話の可否を各検知ロジックが「自分の中だけで」判断しており、全体を見る主体が
#   居なかった。その結果、正反対に見える2つの事故が同じ原因から起きた：
#     ・マルチクラス接近が12秒毎に94回連呼（自分しか見ていないので"うるさい"と気づけない）
#     ・停止車警告が構造的に永久沈黙（雑談用クールダウン last_battle_global が衝突警告を抑制
#       ＝低優先度が高優先度をダッキングしていた）
#     ・2026-07-20 実走では全判断コールが沈黙（検知24回・発話0回。ドライバー激怒）
#
# 【設計の由来】Yujiの言葉（SIMの振動スピーカー）：
#   「エンジン音は鳴り続けるが、シフトが来ればシフトが強調され、タイヤロックが来れば
#     エンジン音は隠れるぐらいになる。そういう仕組みになっているのか？」
#   ＝音響のサイドチェイン・ダッキング。無線コールも同じ構造にする。
#
# 【規則】
#   1. 優先度クラス P0(安全・即時) 〜 P5(雑談)
#   2. 上位が直近に喋っていたら下位は破棄する。**下位は上位を絶対に抑制できない**
#   3. P3〜P5 だけ発話予算で構造的に制限する（プロンプトでの「連呼するな」は守られなかった）
#   4. P0〜P2 は予算・ダッキングの対象外＝絶対に落とさない
#   5. ドライバーの「静かにして」は P3〜P5 の予算を絞るだけ。P0/P1 には効かせない
PRIORITY = {
    # P0 安全・即時（0.1秒が命。絶対に落とさない）
    'stopped_ahead': 0, 'side_by_side': 0, 'crash_check': 0, 'incident': 0, 'damage_report': 0,
    # P1 安全・文脈（Yuji仕様：GT3は最も遅いクラス＝速い車の接近は危険。必ず報告する）
    'multiclass': 1, 'multi_car_straight': 1, 'pit_box_here': 1,   # pit_box_hereは期限が極端に短い
    # ↓Codex提案で格下げ：低SR/iRは物理的な即時危険ではない
    'danger': 3,
    # P2 手順（タイミングが命）
    'pit_entry': 2, 'pit_exit': 2, 'pit_box_stop': 2, 'limiter_off': 2, 'pit_box_countdown': 2,
    # ★2026-07-24 Codex P0：post_contact_okはcrash_check(P0)発火の5秒後に必ず届かせたい"安否確認の第二声"。
    #   P4ではP0発話後の10秒duck windowで落とされる（DUCK_WINDOW={3:6,4:10,5:12}）→P2に置く
    #   （P2以上はduck対象外・かつ予算制限もない）。手順コールと同格＝タイミングを守る、で意味も揃う。
    'post_contact_ok': 2,
    # ★ベスト更新は祝う瞬間。予算で消されないようP2に置く（実走で沈黙しドライバーが落胆した）
    'personal_best': 2, 'session_best': 2,
    # Final Lapは時刻判断。P2でduck/budgetによる消費を防ぐ。
    'final_lap': 2, 'final_lap_notice': 2,
    # 燃料不足は数値根拠のP0。band dedupで連呼を防ぐ。
    'fuel_warning': 0, 'fuel_strategy_warning': 0, 'fuel_strategy_safe': 3,
    # P3 戦略
    'first_lap': 3,
    'catchup': 3, 'defend': 3, 'battle': 3,
    # P4 情報
    'time_loss': 4, 'pace_check': 4, 'position_up': 4, 'position_down': 4,
    'rolling_gap': 4, 'lap_time': 4,
}
DEFAULT_PRIORITY = 5                  # 未知は雑談扱い＝最も抑制される（安全側に倒れる）
DUCK_WINDOW = {3: 6.0, 4: 10.0, 5: 12.0}   # 上位が喋った直後、この秒数は下位を出さない
BUDGET_WINDOW = 60.0                  # 発話予算の観測窓（秒）
BUDGET_MAX = {3: 5, 4: 2, 5: 1}       # 窓内の最大発話回数（P3=戦略/P4=情報/P5=雑談）
#   ★2026-07-20 実走で順位コールが16秒に5連発したためP4を4→2へ、雑談も2→1へ絞った
QUIET_FACTOR = 0.4                    # ドライバーが「静かにして」と言った時に予算へ掛ける係数

_director = {'last_by_prio': {}, 'recent': [], 'quiet_until': 0.0}

# ★P0（2026-07-21 Codexレビュー再指摘）：director_gateはbroadcast()の唯一の関門なので、
#   race_lifecycle.director_active()もここに配線する。走行中ディレクター（レース無線）は
#   DEBRIEFで停止するが、終了案内（checker_out_notice等）は許可リストで個別に通す。
_lifecycle_state = race_lifecycle.RACING
DEBRIEF_ALLOWED_TRIGGERS = {'checker_out_notice'}

# ★2026-07-26 Unit E0 v3（Codex 再差戻し対応）：Driver Handoff/Inactive Driver 認識。
#   非搭乗中の本人向け自動発話を抑止するため broadcast() の入り口で判定する。
#   activity 計算本体は driver_activity.py の純粋関数で行い、ここでは結果保持のみ。
_driver_activity = driver_activity_mod.ACTIVE

# ★v3 Codex P0-1：手動「運転支援再開」シグナル。renderer からの WebSocket cmd
#   'resume_driving_support' で set され、poll_iracing() が 1フレーム分消費する。
#   PTT は非搭乗中の観戦者会話でも押されるため activity 判定源にできない
#   → 通常 PTT とは別経路の明示 CMD で本人再搭乗を確定。
_manual_resume_pending = False


def _set_driver_activity(state):
    """poll_iracing() から driver_activity 計算後に呼ぶ。module-level に保持し broadcast() から参照。"""
    global _driver_activity
    _driver_activity = state


def _mark_manual_resume_signal():
    """WebSocket cmd 'resume_driving_support' 受信時に呼ぶ。
    HANDOFF/INACTIVE 中の本人再搭乗確定シグナル。poll_iracing() が消費してクリア。"""
    global _manual_resume_pending
    _manual_resume_pending = True


def _consume_manual_resume_signal():
    """poll_iracing() が毎フレーム呼ぶ。フラグを読んでクリアし、値を返す。"""
    global _manual_resume_pending
    v = _manual_resume_pending
    _manual_resume_pending = False
    return v


# ★2026-07-26 Unit E0 v2 (Codex P0-4)：allow-list ゲート（deny-by-default）。
#   activity!=ACTIVE 中に通す type だけを明示列挙。radio / judge_call / pace_check
#   等の音声関連は全部 deny。PTT/接続/デバイス等の非音声メタと session_summary
#   （呼び出し側 should_fire_race_summary で判定）だけ通す。
ACTIVITY_ALLOWED_META_TYPES = frozenset({
    # 物理ハードウェア・システム
    'mic_error', 'mic_level',
    # ptt_text は本人が明示的に押した手動会話。非搭乗中も会話結果だけは届けるが、
    # activity を ACTIVE へ戻す根拠にはしない。自動無線の停止契約は維持する。
    'ptt', 'ptt_text', 'ptt_audio', 'ptt_error', 'ptt_diagnostic',
    'ptt_set', 'ptt_mismatch', 'ptt_config',
    'vol_set',
    # 接続状態
    'iracing_connected', 'iracing_disconnected',
    'session_info',
    # データのみ（音声化されない・renderer 内部で消費）
    'driver_state', 'driver_activity', 'speak_gate', 'lap_sectors', 'pit_timing',
    # session_summary は呼び出し側で should_fire_race_summary() ガード。
    # broadcast() は素通しし、broadcast() の戻り値で送信成功を確認する契約。
    'session_summary',
})


def _activity_allows_broadcast(event):
    """★2026-07-26 Unit E0 v2 (Codex P0-4)：allow-list ゲート。

    ACTIVE は全許可。それ以外は ACTIVITY_ALLOWED_META_TYPES に含まれる type のみ通す。
    radio/judge_call/pace_check 等の本人向け自動音声は deny-by-default で停止。
    """
    if driver_activity_mod.should_auto_fire(_driver_activity):
        return True
    etype = event.get('type')
    return etype in ACTIVITY_ALLOWED_META_TYPES

def set_quiet_mode(seconds=600):
    """ドライバーが『あんまり喋らなくていい』と言った時に呼ぶ。
       ★P3〜P5の予算を絞るだけで、P0/P1(安全)には一切効かない。
       2026-07-20のデブリーフでモデルが「言わなくていいと言われたから速いクラスを報告しなかった」
       と述べた事故の再発防止＝"静かに"の意味を構造で限定する。"""
    _director['quiet_until'] = time.time() + seconds
    log("DIRECTOR: quiet mode ON for %ds (P3-P5 budget x%.1f / safety unaffected)" % (seconds, QUIET_FACTOR))

def _director_allows(kind, prio, now):
    """発話してよいかを1箇所で決める。落とした時は必ず理由をログに残す（測れないものは直せない）。"""
    if prio <= 2:
        return True, None                       # 安全と手順は無条件で通す
    for p in range(0, prio):                    # 上位が直近に喋っていたらダック
        last = _director['last_by_prio'].get(p, 0)
        if now - last < DUCK_WINDOW.get(prio, 8.0):
            return False, 'ducked_by_P%d' % p
    quiet = now < _director['quiet_until']
    cap = BUDGET_MAX.get(prio, 2)
    if quiet:
        cap = max(1, int(cap * QUIET_FACTOR))
    _director['recent'] = [r for r in _director['recent'] if now - r[0] < BUDGET_WINDOW]
    used = sum(1 for r in _director['recent'] if r[1] == prio)
    if used >= cap:
        return False, 'budget_P%d_%d/%d%s' % (prio, used, cap, '_quiet' if quiet else '')
    return True, None

def director_commit(prio, kind='radio'):
    """rendererが実際に再生を開始した時に呼ぶ＝ここで初めて予算とダッキング基準を消費する。
       （通過時計上だと、黙った判断コールが下位を不当に抑制してしまう）"""
    try:
        now = time.time()
        _director['last_by_prio'][prio] = now
        _director['recent'].append((now, prio))
        log("DIRECTOR spoke: %s (P%d)" % (kind, prio))
    except Exception:
        pass

# ★P0（2026-07-21 Codexレビュー再々指摘・四度目の指摘で拡張）：SessionNum変更時に一括resetすべき
#   「セッション限定状態」をここに集約する。個別変数をmaybe_reset_on_session_num_changeへ都度書き足す
#   方式だと、新しい状態変数を追加した時に"resetし忘れ"が再発する——実際に二度起きた
#   （1回目：fuel_strategy_warned/fuel_per_lap_hist/fuel_at_lap_start/lap_time_hist/fuel_strategy。
#    2回目：pace_check_last_lap/lap_delta_hist/leader_lap_time_hist/leader_last_laptime_seen/
#    prev_session_state/race_start_time/pit_enter_time/pit_enter_pos——特にペース履歴と
#    リーダー周回履歴は、新セッションのペース判断・残り周回推定へ前セッションの値を混入させていた）。
#   新しいセッション限定状態を追加する時は、**必ずこの辞書にも足すこと**（単一の真実源）。
def _session_scoped_reset_values():
    return {
        'checker_out_notice_sent': False,
        'last_laps_remaining_est': None,
        'final_lap_notice_sent': {5: False, 3: False, 1: False},
        'fuel_strategy_warned': False,
        'fuel_per_lap_hist': [],
        'fuel_at_lap_start': None,
        'lap_time_hist': [],
        'fuel_strategy': None,
        'fuel_warning_band': None,
        'pit_this_lap': False,
        # ★2026-07-21 四度目の指摘で追加
        'pace_check_last_lap': -99,             # 初期値と同じ（3周に1回のペース判断間引きの基準）
        'lap_delta_hist': [],                   # 前セッションのペース傾向データを混入させない
        'leader_lap_time_hist': [],             # 前セッションのリーダー周回履歴を混入させない
        'leader_last_laptime_seen': None,
        'prev_session_state': 0,                # 初期値と同じ
        'race_start_time': None,
        'pit_enter_time': None,
        'pit_enter_pos': None,
        'pit_entry_announced_stop': False,
        # ★2026-07-21 五度目の指摘で追加
        'summary_sent': False,
        'checkered_pending': False,
        'session_racing_started': False,
        'session_laps': [],
        # ★2026-07-23 Codex再指摘 P1：予選で予算満杯のままレース開始→最初の警告が通らない
        #   事故を防ぐ。SessionNum変更時に候補予算をリセット（judge_llm_call_timesは他の
        #   セッション限定状態と同じくセッション毎に独立させる）。
        'judge_llm_call_times': [],
        # skipログの間引き用（kind -> 最後にskipログを出した時刻）。セッションを跨いだら
        # クリアしないと、前セッションの「もう最近ログ出した」状態が残って、新セッションの
        # 最初のskipログが出ないことがある＝一貫してセッション限定状態として扱う。
        'judge_llm_skip_log_last': {},
        # ★2026-07-24 Codex P1：接触監視状態はセッションを跨がないこと。
        #   予選中に接触→レースへセッション遷移→前セッションのSessionTime基準がレースへ持ち越し
        #   → 5秒後判定ロジックが破綻し誤発話 or 永久サイレント。ここに置いてsig/SessionNum両経路で強制リセット。
        'post_contact_watch_start': None,
        'post_contact_speed_ok': True,
        # ★2026-07-26 Unit E0（Codex指示）：Driver Handoff 状態もセッションを跨がない。
        #   前セッションで garage 帰還した状態が新セッションへ持ち越されると、レース開始時に
        #   INACTIVE_DRIVER 誤判定で自動発話が全停止する事故になる。新セッションは ACTIVE から始める。
        '_driver_activity_local': driver_activity_mod.ACTIVE,
        '_driver_activity_handoff_start': None,
        # ★v3 Codex P0-4：pending summary もセッションを跨がない。
        #   前セッションで送信失敗した summary を新セッションで送ると誤情報になる。
        '_pending_summary': None,
        '_pending_non_race_summary': None,
        '_pending_checker_notice': None,
    }


def maybe_reset_on_session_num_change(cur_snum, last_session_num, race_lifecycle_fsm):
    """★P0（2026-07-21 Codexレビュー・再々指摘で拡張）：SessionNumが変わっていたら
    race_lifecycle_fsmと、セッションをまたいではいけない全状態（_session_scoped_reset_values参照）を
    一括resetする。保留中(gate待ち)のradioイベントも前セッションの内容を持ち越さないよう捨てる。
    poll_iracing()から毎フレーム呼ばれる本番コード。単体テストからも直接呼べる。

    Returns: (changed: bool, reset_values: dict|None)
             changed=Trueの時、呼び出し側はreset_valuesの各キーで対応するローカル変数を上書きする
             こと。changed=Falseの時はNone（既存値をそのまま使う）。
    """
    if cur_snum is not None and last_session_num is not None and cur_snum != last_session_num:
        log("SESSION NUM CHANGED: %s -> %s — session-scoped state reset" % (last_session_num, cur_snum))
        race_lifecycle_fsm.reset()
        # ★保留中(gate待ち＝コーナー/ブレーキ中で発話を待たされているradio)も前セッションの内容。
        #   次のセッションへ持ち越すと、無関係になったタイミングで古い無線が飛ぶ事故になる。
        _gate_state['pending'] = None
        _gate_state['since'] = 0.0
        return True, _session_scoped_reset_values()
    return False, None


def evaluate_post_contact_watch(watch_start, speed_ok, now_time, current_speed,
                                watch_duration_sec=5.0, min_speed_mps=8.33):
    """★2026-07-24 Codex P0：post_contact_ok の5秒観察窓判定を純粋関数化。
    poll_iracing()から毎フレーム呼ばれる本番コード（切り出しただけ・ロジックは同一）。
    単体テストから直接呼べる。

    Args:
      watch_start:      監視開始時刻(SessionTime基準)。Noneで未監視
      speed_ok:         監視中にSpeed>min_speed_mpsを維持できているかフラグ
      now_time:         現在時刻(SessionTime)。Noneでデータ欠損
      current_speed:    現在の車速(m/s)。Noneでデータ欠損
      watch_duration_sec: 監視窓の長さ（デフォルト5秒＝Yuji仕様）
      min_speed_mps:    走行継続と判定する下限車速（デフォルト8.33m/s=30km/h）

    Returns:
      (should_broadcast: bool, new_watch_start: float|None, new_speed_ok: bool)
      - should_broadcast=True：呼び出し側は post_contact_ok radio を出す
      - new_watch_start=None：監視終了（判定確定・欠損・リセット）
      - new_speed_ok=True：次の crash_check 用にrearmされた状態
    """
    if watch_start is None:
        return False, None, True                              # 未監視ならそのまま
    if now_time is None or current_speed is None:
        return False, None, True                              # データ欠損は監視破棄
    if current_speed < min_speed_mps:
        speed_ok = False                                      # 途中で失速＝Pattern A(停止)判定
    elapsed = now_time - watch_start
    if elapsed >= watch_duration_sec:
        return speed_ok, None, True                           # 判定終了：Pattern Bだけ発話
    return False, watch_start, speed_ok                       # 監視継続


SPEECH_EVENT_TYPES = ('radio', 'judge_call', 'pace_check')
# ★P0（2026-07-21 Codexレビュー再々指摘）：発話につながる全イベント種別をここに列挙する。
#   旧実装は('radio','judge_call')のみで、'pace_check'（rendererのcheckPaceJudgmentがspeak()を
#   直接呼ぶ）がdirector_gate自体を素通りしていた＝DEBRIEF中でもpace判断の無線が発話されうる穴。
#   'driver_state'/'iracing_connected'/'session_info'/'lap_sectors'/'pit_timing'/mic系/ptt系/vol系は
#   データ通知またはUI操作で発話に繋がらないため対象外（renderer.htmlのws onmessage分岐で確認済み）。
#   'iracing_disconnected'/'ptt_mismatch'はbridgeVoice()経由で発話するが、レース内容ではなく
#   システム状態の通知のため、DEBRIEF中でも案内できる方が安全側と判断し対象外のまま。


def director_gate(event):
    """broadcast() の入口で全イベントを裁く。True=通す / False=捨てる。"""
    try:
        et = event.get('type')
        if et not in SPEECH_EVENT_TYPES:
            return True                          # テレメトリ等の非発話イベントは対象外
        kind = event.get('trigger') or event.get('kind') or ''
        # ★P0（2026-07-21 Codexレビュー再指摘）：DEBRIEFでは走行中ディレクターを停止する。
        #   許可リスト外のtrigger（通常のレース無線）は理由付きで捨てる。
        if not race_lifecycle.director_active(_lifecycle_state) and kind not in DEBRIEF_ALLOWED_TRIGGERS:
            log("DIRECTOR drop: %s reason=debrief_state" % kind)
            return False
        prio = PRIORITY.get(kind, DEFAULT_PRIORITY)
        # ★2026-07-20 Codexレビュー P0-1：bridgeで決めた優先度が renderer に伝わっておらず、
        #   crash_check以外の安全コールが全て既定のP4扱いになっていた（＝安全保証が成立していない）。
        #   イベント自体に載せて発話の最後まで運ぶ。
        event['prio'] = prio
        now = time.time()
        ok, why = _director_allows(kind, prio, now)
        if not ok:
            log("DIRECTOR drop: %s (P%d) reason=%s" % (kind, prio, why))
            return False
        # ★Codex指摘：ここで計上してはいけない。judge_callはNO_CALLで黙ることがあり、
        #   通過時に計上すると「黙ったのに予算を食い、下位をダックする」不正が起きる。
        #   計上は renderer が実際に再生を開始した時（cmd:'spoke'）に行う。
        log("DIRECTOR pass: %s (P%d)" % (kind, prio))
        return True
    except Exception as _de:
        log("DIRECTOR error (fail-open): " + str(_de))
        return True                              # 判断に失敗したら通す＝安全側

# ══ 後方から迫る同クラス集団の「形」を読む（2026-07-20 Yuji要望）══
#   台数だけでは対処が決められない。ドライバーの言葉：
#     「2台が3秒以内で接近時とか。仮に3台が10秒以内でも2+1台で来てるとか。
#       等間隔で来てる場合、"GTPが等間隔に7台くるぞ"」
#   固まって来る＝一度譲れば終わる／分かれて来る＝間に息継ぎがある／
#   等間隔の列車＝長時間付き合う覚悟が要る。対処が全く変わるので形を伝える。
MC_OBSERVE_SEC = 15.0     # 隊列を見るための観測窓（発話の引き金は近い5秒/2秒のまま）
MC_PACK_SEC    = 3.0      # この秒数以内に続いていれば「固まっている」
MC_REARM_SEC   = 8.0      # 発火は5秒。再武装はここまで離れた時だけ（境界振動での連呼防止）
MC_TRAIN_TOLERANCE = 0.5  # 等間隔判定：車間のばらつきが平均のこの割合以内なら「列車」

# ★2026-07-23 Codex設計：LLM頭脳・自動発火(judge_call)のコスト間引き。
#   各判定(danger/battle/catchup/defend等)には既に車単位の重複防止(再武装・段階管理)があるが、
#   パックレースで複数の異なる車が同時多発すると、車ごとの重複防止をすり抜けてLLM問い合わせが
#   積み上がる。ここでは「発話予算」でなく「LLMへ問い合わせる回数」自体に全体の上限を設ける
#   （NO_CALLで終わってもAPI課金は発生するため、間引きはLLMを呼ぶ前が本丸）。
#   dangerは安全直結の予告なので間引き対象外＝常に通す。
JUDGE_LLM_BUDGET_MAX = 6      # 直近JUDGE_LLM_BUDGET_WINDOW秒間に、間引き対象kindで最大この回数までLLMへ問い合わせる
JUDGE_LLM_BUDGET_WINDOW = 60.0
# ★2026-07-23 Codex再指摘 P0：セッション中1回きり・間引くと永久消失する種類は対象外にする。
#   dangerは危険ドライバー予告（同一車1回のみdanger_ever_warnedで永久ロック）。
#   間引くと通知そのものが失われるため常にTrueで通す（実API課金はサーバー側api_usage_log
#   が正・こちらは"候補予算"としてattempt回数を絞るだけ）。
# ★2026-07-24 towing削除に伴い、towingをこのセットから除去。
JUDGE_LLM_NEVER_THROTTLE = {'danger'}
# ★2026-07-23 Codex再指摘（運用問題）：予算切れ中、上位ロジックは~0.1秒毎に候補を再判定するため
#   1候補あたり最大約600回のcandidate-skipログになる。kind単位で最大この秒数に1回だけログを出す
#   （初回のskip→JUDGE_LLM_SKIP_LOG_DEDUP_SEC経過→次のskipが出た時のみログ。判定・返り値は不変）。
JUDGE_LLM_SKIP_LOG_DEDUP_SEC = 10.0


def _judge_llm_gate(kind, call_times, now, skip_log_last=None):
    """judge_call broadcast直前のローカル"候補"間引き（_director_allowsと同じくnowを引数で受け取りテスト可能にする）。

    True=このままLLMへ送ってよい / False=ローカルで沈黙(LLMを一切呼ばない=課金なし)。

    ★"候補"予算：本関数はbroadcast()の直前で消費する。broadcast()内のdirector_gate()が
      その後sendを破棄した場合、実際にはLLMは呼ばれないがcall_timesには残る。
      実API原価の集計はサーバー側api_usage_log（server.jsのrecordApiUsage）を正とし、
      本ゲートは「Bridge側がLLM呼び出しをattemptする回数」の候補予算として扱う。
      broadcast()自体を素通りする既存のdirector_gateとは別の関門（LLMを呼ぶ前 vs 喋る前）。

    call_timesは呼び出し元が持つ直近呼び出し時刻のlist（破壊的に操作する＝リストそのものを
    状態として使う）。SessionNum変更・sig変更時は_session_scoped_reset_values()で[]へリセット
    される（前セッションの候補予算を持ち越してレース最初のcallが通らなくなる事故を防ぐ）。

    skip_log_lastは省略可（dict：kind -> 最後にskipログを出した時刻）。渡されていれば、
    JUDGE_LLM_SKIP_LOG_DEDUP_SEC秒に1回だけログを出す（毎ポーリング=~600回/60秒の連呼を防ぐ）。
    """
    if kind in JUDGE_LLM_NEVER_THROTTLE:
        return True
    while call_times and now - call_times[0] > JUDGE_LLM_BUDGET_WINDOW:
        call_times.pop(0)
    if len(call_times) >= JUDGE_LLM_BUDGET_MAX:
        should_log = True
        if skip_log_last is not None:
            last = skip_log_last.get(kind, 0.0)
            if now - last < JUDGE_LLM_SKIP_LOG_DEDUP_SEC:
                should_log = False
            else:
                skip_log_last[kind] = now
        if should_log:
            log("JUDGE_LLM_GATE candidate-skip kind=%s (budget %d/%ds reached, no LLM attempt)"
                % (kind, JUDGE_LLM_BUDGET_MAX, int(JUDGE_LLM_BUDGET_WINDOW)))
        return False
    call_times.append(now)
    # 成功時はskip_log_lastから該当kindをクリア（次に予算切れになった時は改めて1回ログを出す）。
    if skip_log_last is not None:
        skip_log_last.pop(kind, None)
    log("JUDGE_LLM_GATE candidate-allow kind=%s (%d/%d used this window)"
        % (kind, len(call_times), JUDGE_LLM_BUDGET_MAX))
    return True

def _describe_traffic(gaps):
    """後方車のギャップ列(昇順)から形を返す。 -> (shape, clusters)
       shape: single / pack / split / train
       clusters: 各かたまりの台数（例 [2,1] = 2台の後にもう1台）"""
    n = len(gaps)
    if n <= 1:
        return 'single', [1]
    clusters, cur = [], 1
    for i in range(1, n):
        if gaps[i] - gaps[i-1] <= MC_PACK_SEC:
            cur += 1
        else:
            clusters.append(cur); cur = 1
    clusters.append(cur)
    if n >= 4 and len(clusters) == 1:
        # 全部繋がっている＝列車。間隔が揃っていれば「等間隔」と呼べる
        steps = [gaps[i] - gaps[i-1] for i in range(1, n)]
        avg = sum(steps) / len(steps)
        # ★2026-07-20 Codexレビュー P2-8：max(1.0, avg*0.5) は平均間隔が小さい時に1秒まで許容し、
        #   仕様「ばらつきが平均の50%以内」より大幅に緩かった。ゼロ除算対策と許容幅を分離する。
        if avg >= 0.2 and max(abs(x - avg) for x in steps) <= avg * MC_TRAIN_TOLERANCE:
            return 'train', clusters
    if len(clusters) == 1:
        return ('pack' if n > 1 else 'single'), clusters
    return 'split', clusters

def _mc_message_en(cls, nearest, gaps, shape, clusters, stage):
    """英語キャラ用の文言。日本語はrenderer側で組む。"""
    tail = ''
    if shape == 'train':
        return '%s, %d cars evenly spaced, first one %s behind.%s' % (cls, len(gaps), _fmt_gap(nearest), tail)
    if shape == 'pack':
        return '%s, %d together, %s behind.%s' % (cls, len(gaps), _fmt_gap(nearest), tail)
    if shape == 'split':
        return '%s, %s behind — %s.%s' % (cls, _fmt_gap(nearest),
                                          ' then '.join(str(c) for c in clusters) + ' in groups', tail)
    return '%s, %s behind.%s' % (cls, _fmt_gap(nearest), tail)

# ★v3 Codex P1：broadcast() 戻り値の三値契約。段階状態消費 / summary_sent の判定に使う。
BROADCAST_DISPATCHED = 'DISPATCHED'   # 実際に送信キューへ投入した
BROADCAST_HELD = 'HELD'               # 間合いゲートで pending へ保留（後で flush_radio が送る）
BROADCAST_DROPPED = 'DROPPED'         # 完全に破棄（activity/director/client 未接続）


def dispatch_pending_summary(pending_summary, summary_sent, dispatch_fn):
    """pending summaryを1回配送する純粋な状態遷移。

    dispatch_fn(event) は broadcast() と同じ三値契約を返す。
    DISPATCHEDの時だけ sent=True とpayload破棄を行い、HELD/DROPPEDなら同じpayloadを保持する。
    """
    if pending_summary is None or summary_sent:
        return pending_summary, summary_sent, None
    result = dispatch_fn(pending_summary)
    if result == BROADCAST_DISPATCHED:
        return None, True, result
    return pending_summary, False, result


def broadcast(event):
    """★v3 Codex P1：戻り値を 3値化。保留と破棄を区別できる契約。

    Returns:
      BROADCAST_DISPATCHED : dispatch 成功（送信キューへ投入完了）
      BROADCAST_HELD       : 間合いゲートで保留（flush_radio() が後で送る予定）
      BROADCAST_DROPPED    : 完全破棄（activity ゲート / director / client 未接続）

    段階状態消費（catchup_stage 等）は DISPATCHED のみで実施すべき。
    HELD は後で送信可能性があるため、二重発火防止のため呼び出し側で扱いを決める
    （現状 judge_call 系は GATEABLE_TRIGGERS に含まれないため HELD にならない）。

    戻り値は全て非空文字列なので truthy。呼び出し側は必ず定数と明示比較する。
    """
    # ★2026-07-26 Unit E0（Codex指示）：使用者非搭乗中は本人向け自動発話を抑止（最優先ゲート）。
    if not _activity_allows_broadcast(event):
        return BROADCAST_DROPPED
    # ★2026-07-20 director gate（優先度・ダッキング・予算）
    if not director_gate(event):
        return BROADCAST_DROPPED
    # ── 発話「間合い」ゲート ──
    try:
        if (event.get('type') == 'radio' and event.get('trigger') in GATEABLE_TRIGGERS
                and not event.get('_admitted')
                and _gate_active and not _gate_window_ok):
            event['_admitted'] = True
            _gate_state['pending'] = event
            _gate_state['since'] = time.time()
            log("RADIO gate: hold %s (braking/cornering)" % event.get('trigger'))
            return BROADCAST_HELD
    except Exception:
        pass

    # 診断ログ
    try:
        et = event.get('type')
        if et == 'radio':
            log("RADIO -> trigger=%s time=%s diff=%s delta=%s reason=%s (lap timing check)" %
                (event.get('trigger'), event.get('time'), event.get('diff'), event.get('delta'), event.get('reason')))
        elif et == 'ptt':
            log("PTT event -> " + str(event.get('state')))
    except Exception:
        pass
    if not connected_clients or loop is None:
        return BROADCAST_DROPPED
    msg = json.dumps(event)
    asyncio.run_coroutine_threadsafe(_broadcast_async(msg), loop)
    return BROADCAST_DISPATCHED

# ── 発話タイミング「間合い」ゲート（Version A）──
# broadcast()の一点でゲート：GATEABLE_TRIGGERS(=よく喋るプロアクティブ無線)は、レース中に発話窓が
# 閉じてる(ブレーキ/コーナリング中)なら送らず最新1件だけ保留し、flush_radioが窓の開いた瞬間に送る。
# 安全直結(隣接車/クラッシュ/損傷等)や非radioイベントはゲート対象外＝常に即。窓状態はループが毎サイクル更新。
GATEABLE_TRIGGERS = frozenset({
    'personal_best', 'first_lap', 'session_best', 'lap_consistent', 'lap_time', 'lap_slow',
    'rolling_gap',
})
_gate_state = {'pending': None, 'since': 0.0}
_gate_window_ok = True
_gate_active = False        # ゲートを効かせる状況か（＝オントラック走行中。ピット/ガレージでは効かせない）

def _set_speak_gate(window_ok, active):
    global _gate_window_ok, _gate_active
    changed = (window_ok != _gate_window_ok or active != _gate_active)
    _gate_window_ok = window_ok
    _gate_active = active
    # renderer直結の会話回答・LLM戦略発話も同じ安全窓へ入れる。
    # 状態が変わった時だけ送り、毎tickのWebSocket floodingを避ける。
    if changed:
        broadcast({'type': 'speak_gate',
                   'window_ok': bool(window_ok),
                   'active': bool(active)})

def flush_radio():
    """毎サイクル呼ぶ。窓が開いてて保留があれば送る。古すぎたら破棄（陳腐化防止）。
    ★v3 Codex P1：broadcast() が三値を返すようになったが、flush_radio() は
    「ゲート通過済みの pending を送る」役割なので DISPATCHED 期待。HELD にはならない
    （_admitted=True で二重ゲート判定を skip する既存契約）。"""
    p = _gate_state.get('pending')
    if not p:
        return
    if _gate_window_ok:
        _gate_state['pending'] = None
        broadcast(p)                     # 通過済み扱い・戻り値は現状使わず
    elif time.time() - _gate_state.get('since', 0.0) > SPEAK_HOLD_MAX:
        log("RADIO gate: dropped stale %s" % p.get('trigger'))
        _gate_state['pending'] = None

async def _broadcast_async(msg):
    dead = set()
    for client in connected_clients.copy():
        try:
            await client.send(msg)
        except Exception:
            dead.add(client)
    connected_clients.difference_update(dead)

class IRacingReader:
    # ヘッダーオフセットは irsdk_mem.py（共有・実走確認済み）から参照する。
    H_STATUS = irsdk_mem.H_STATUS
    H_SESSION_INFO_LEN = 16
    H_SESSION_INFO_OFFSET = 20
    H_NUM_VARS = irsdk_mem.H_NUM_VARS
    H_VAR_HEADER_OFFSET = irsdk_mem.H_VAR_HEADER_OFFSET
    H_NUM_BUF = irsdk_mem.H_NUM_BUF
    VARBUF_BASE = irsdk_mem.VARBUF_BASE
    VARBUF_STRIDE = irsdk_mem.VARBUF_STRIDE
    VAR_HEADER_SIZE = irsdk_mem.VAR_HEADER_SIZE
    VAR_NAME_OFF = irsdk_mem.VAR_NAME_OFF

    def __init__(self):
        self._k32 = None
        self._handle = None
        self._ptr = None
        self.var_cache = {}
        # ★2026-07-24 Codex差戻し対応 P1：_diag_last_signature はインスタンス属性。
        #   クラス属性だと再接続時に前回セッションの署名が残り、新規セッションで初回診断が抑止される。
        #   __init__ で必ずNone初期化し、Reader インスタンス生成の度に再診断できる契約を明示する。
        self._diag_last_signature = None

    def is_open(self):
        return self._ptr is not None

    def open(self):
        # 共有メモリの開閉は irsdk_mem.py に一本化（argtypes欠落によるFFI破損の再発防止）。
        k32, h, ptr = irsdk_mem.open_shared_mem()
        if not ptr:
            return False  # iRacing未起動、または非Windows
        self._k32 = k32
        self._handle = h
        self._ptr = ptr
        return True

    def close(self):
        irsdk_mem.close_shared_mem(self._k32, self._handle, self._ptr)
        self._k32 = None
        self._ptr = None
        self._handle = None
        self.var_cache = {}
        # ★2026-07-24 Codex差戻し対応 P1：再接続時の診断状態初期化。
        #   close() で dedup 署名をリセット→次回接続で初回診断ログが必ず出る（契約）。
        self._diag_last_signature = None

    def _bytes(self, offset, size):
        return ctypes.string_at(self._ptr + offset, size)

    def _read_int(self, off):
        return struct.unpack('i', self._bytes(off, 4))[0]

    def is_active(self):
        if not self._ptr:
            return False
        try:
            return self._read_int(self.H_STATUS) == 1
        except Exception:
            return False

    def get_buf_offset(self):
        try:
            off, _tick = irsdk_mem.get_buf_offset(self._ptr)
            return off
        except Exception:
            return 0

    def find_var(self, name):
        if name in self.var_cache:
            return self.var_cache[name]
        if not self._ptr:
            return None
        try:
            num_vars = self._read_int(self.H_NUM_VARS)
            var_hdr_off = self._read_int(self.H_VAR_HEADER_OFFSET)
            for i in range(min(num_vars, 600)):
                base = var_hdr_off + i * self.VAR_HEADER_SIZE
                vh = self._bytes(base, self.VAR_HEADER_SIZE)
                if len(vh) < self.VAR_HEADER_SIZE:
                    break
                vtype = struct.unpack_from('i', vh, 0)[0]
                voffset = struct.unpack_from('i', vh, 4)[0]
                raw_name = vh[self.VAR_NAME_OFF:self.VAR_NAME_OFF + 32]
                vname = raw_name.split(b'\x00')[0].decode('utf-8', errors='ignore')
                if vname == name:
                    result = (vtype, voffset)
                    self.var_cache[name] = result
                    return result
        except Exception:
            pass
        return None

    def dump_temp_vars(self):
        """診断(2026-07-16)：名前に temp を含む全変数と実値をダンプ。タイヤ温度の正しい変数を
        推測ゼロで特定するため。tempCM(=39.4)が何で、接地面80℃を示す変数がどれかを実走で確認する。"""
        out = {}
        if not self._ptr:
            return out
        try:
            num_vars = self._read_int(self.H_NUM_VARS)
            var_hdr_off = self._read_int(self.H_VAR_HEADER_OFFSET)
            buf = self.get_buf_offset()
            for i in range(min(num_vars, 600)):
                base = var_hdr_off + i * self.VAR_HEADER_SIZE
                vh = self._bytes(base, self.VAR_HEADER_SIZE)
                if len(vh) < self.VAR_HEADER_SIZE:
                    break
                voffset = struct.unpack_from('i', vh, 4)[0]
                raw_name = vh[self.VAR_NAME_OFF:self.VAR_NAME_OFF + 32]
                vname = raw_name.split(b'\x00')[0].decode('utf-8', errors='ignore')
                if 'temp' in vname.lower():
                    try:
                        val = struct.unpack('f', self._bytes(buf + voffset, 4))[0]
                        out[vname] = round(val, 1)
                    except Exception:
                        out[vname] = None
        except Exception:
            pass
        return out

    # ★2026-07-20 型を見て読む（実走で発覚した重大バグの根治）
    #   find_var は (vtype, voffset) を返しているのに read_float/read_double が vtype を無視し、
    #   常に4バイト/8バイトで固定解釈していた。iRacing SDK の SessionTimeRemain は double(型5) なので、
    #   read_float で読むと8バイト値の下位4バイトだけを float として解釈＝ゴミ値になる。
    #   実害：timeRem が全周 0.0（たまに778.6のような"それっぽい値"）→ 残り周回推定が崩壊し、
    #        燃料の完走可否計算が壊れていた（Interlagos 2026-07-20 のログで確認）。
    #   SDK 型：0=char 1=bool 2=int 3=bitField 4=float 5=double
    IRSDK_FLOAT = 4
    IRSDK_DOUBLE = 5

    def _read_num(self, name):
        """宣言された型に従って数値を読む。型が分かるので float/double を取り違えない。"""
        info = self.find_var(name)
        if not info:
            return None
        vtype, voffset = info[0], info[1]
        addr = self.get_buf_offset() + voffset
        if vtype == self.IRSDK_DOUBLE:
            return struct.unpack('d', self._bytes(addr, 8))[0]
        if vtype == self.IRSDK_FLOAT:
            return struct.unpack('f', self._bytes(addr, 4))[0]
        if vtype in (2, 3):          # int / bitField
            return struct.unpack('i', self._bytes(addr, 4))[0]
        if vtype in (0, 1):          # char / bool
            return struct.unpack('b', self._bytes(addr, 1))[0]
        return None

    def read_float(self, name):
        try:
            return self._read_num(name)
        except Exception:
            return None

    def read_double(self, name):
        try:
            return self._read_num(name)
        except Exception:
            return None

    def read_int(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return struct.unpack('i', self._bytes(self.get_buf_offset() + info[1], 4))[0]
        except Exception:
            return None

    def read_bool(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return self._bytes(self.get_buf_offset() + info[1], 1)[0] != 0
        except Exception:
            return None

    def read_float_array(self, name, count=64):
        try:
            info = self.find_var(name)
            if not info:
                return None
            data = self._bytes(self.get_buf_offset() + info[1], 4 * count)
            return list(struct.unpack('f' * count, data))
        except Exception:
            return None

    def read_int_array(self, name, count=64):
        try:
            info = self.find_var(name)
            if not info:
                return None
            data = self._bytes(self.get_buf_offset() + info[1], 4 * count)
            return list(struct.unpack('i' * count, data))
        except Exception:
            return None

    def read_session_info(self):
        try:
            si_len = self._read_int(self.H_SESSION_INFO_LEN)
            si_offset = self._read_int(self.H_SESSION_INFO_OFFSET)
            if si_len <= 0 or si_offset <= 0:
                return None
            _cap = 200000
            raw = self._bytes(si_offset, min(si_len, _cap))
            # ★2026-07-21 Codex指示R2「原因修正」：read-only診断（PowerShell不要・本体組み込み）。
            #   2026-07-21のMonza AIレース(約40台)でbridgeログが"drivers:1 / class空"を報告した。
            #   原因を推測せず、次回実走で①si_lenが200000キャップに達している(＝末尾切り詰めの疑い)
            #   ②実際にDrivers:ブロック内で何件parseできたかを突き合わせられるよう、生の長さを記録する。
            if si_len >= _cap:
                log("SESSION INFO DIAG: si_len=%d >= cap(%d) — 末尾が切り詰められている可能性がある" % (si_len, _cap))
            self._last_si_len = si_len

            # ★2026-07-24 Unit 0（Codex指示・診断計装）：
            #   7/24 IMSA Road America 実走ログで si_len=524288 >= cap(200000) が連発したが、
            #   524288が iRacing のバッファ最大サイズなのか実データ長なのかが不明。
            #   実データが200KB内に収まっていて末尾がNULパディングなら現行cap で問題ないが、
            #   200KB を超えて実データが続いているなら Positions/DriverInfo末尾が失われる。
            #   ここでは cap を変えず、cap 超えの probe（診断のみ・上限400KB）で
            #   ①先頭NUL位置 ②必須キーの実バイト位置 ③cap内外どちらに落ちてるかを判定して吐く。
            #   probe結果が変化した時だけログ（毎フレームspamさせない）。
            self._diag_session_info_extent(si_offset, si_len, _cap)

            return raw.decode('utf-8', errors='ignore')
        except Exception:
            return None

    # ── Unit 0 診断状態 ─────────────────────────────
    _DIAG_PROBE_MAX = 400000   # probeの上限バイト数（無条件si_len信用の防止・Codex指示）

    def _diag_session_info_extent(self, si_offset, si_len, cap):
        """Unit 0（Codex指示）診断専用：cap超えのprobeで実データ範囲と必須キー位置を確認する。
        cap自体は変更しない・operational readは既存動作のまま。probeが失敗しても本流に影響なし。

        ★2026-07-24 Codex差戻し対応 P0：共有メモリの物理境界を検証する。
        壊れた/遷移中のヘッダー値でマップ外を ctypes.string_at() すると Python 例外ではなく
        プロセスクラッシュになる（外側の try/except では守れない）。以下を全て検証してから probe：
          - si_offset > 0 かつ < MEM_SIZE
          - si_len > 0
          - probe_size = min(si_len, _DIAG_PROBE_MAX, MEM_SIZE - si_offset) > 0
        """
        # ★P0：物理境界の悪性値を弾く。1つでも失敗したら _bytes() を呼ばず即return。
        if si_offset is None or si_offset <= 0 or si_offset >= irsdk_mem.MEM_SIZE:
            return
        if si_len is None or si_len <= 0:
            return
        readable = irsdk_mem.MEM_SIZE - si_offset   # マップ内で残っている読み取り可能バイト数
        probe_size = min(si_len, self._DIAG_PROBE_MAX, readable)
        if probe_size <= 0:
            return
        try:
            probe = self._bytes(si_offset, probe_size)
            report = analyze_session_info_extent(probe, cap=cap, si_len_reported=si_len)
            # ★P1 dedup 署名は診断項目を網羅：Positions・CarScreenName先頭/末尾・si_len・probe_size を含む。
            #   PositionsがCap内→外へ移動したら新しい診断ログが出ること。
            _csn = report['key_positions'].get('CarScreenName:', [])
            sig = (
                si_len,
                probe_size,
                report['first_nul_pos'],
                report['content_ends_at'],
                report['cap_verdict'],
                report['key_positions'].get('DriverInfo:'),
                report['key_positions'].get('SessionResults:'),
                report['key_positions'].get('Sessions:'),
                report['key_positions'].get('Positions:'),
                _csn[0] if _csn else None,
                _csn[-1] if _csn else None,
                len(_csn),
            )
            if sig == self._diag_last_signature:
                return
            self._diag_last_signature = sig
            log("SESSION INFO EXTENT DIAG: si_len=%d probe=%d first_nul=%s content_ends=%s cap=%d verdict=%s" % (
                si_len, probe_size,
                str(report['first_nul_pos']), str(report['content_ends_at']),
                cap, report['cap_verdict']))
            for key, pos in report['key_positions'].items():
                if key == 'CarScreenName:':
                    csn_verdict = key_list_within_cap_verdict(pos, cap)
                    log("SESSION INFO EXTENT DIAG:   %s occurrences=%d first=%s last=%s within_cap=%s" % (
                        key, len(pos),
                        str(pos[0]) if pos else 'None',
                        str(pos[-1]) if pos else 'None',
                        csn_verdict))
                else:
                    log("SESSION INFO EXTENT DIAG:   %s pos=%s within_cap=%s" % (
                        key, str(pos), key_within_cap_verdict(pos, cap)))
        except Exception as _e:
            log("SESSION INFO EXTENT DIAG error: " + str(_e))


def key_within_cap_verdict(pos, cap):
    """★2026-07-24 Codex差戻し対応 P1：単一キーの cap 境界判定を純粋関数化。
    cap バイト読むと index 0..cap-1 が読める。position=cap のキーは範囲外なので p < cap で判定。

    Args:
      pos: キーの先頭バイト位置（None=未検出）
      cap: operational read cap
    Returns:
      'not_found' | 'yes' | 'no'
    """
    if pos is None:
        return 'not_found'
    return 'yes' if pos < cap else 'no'


def key_list_within_cap_verdict(positions, cap):
    """★2026-07-24 Codex差戻し対応 P1/P2：複数出現キー（CarScreenName等）の cap 境界判定を純粋関数化。

    P1：キー位置は < cap で判定（p=cap は cap 外）。
    P2：0件は 'mixed' でなく 'not_found' を返す（誤解を招く表示を防ぐ）。

    Args:
      positions: キーの先頭バイト位置のリスト（[]=未検出）
      cap: operational read cap
    Returns:
      'not_found' : 0件
      'all'       : 全件 cap 内
      'none'      : 全件 cap 外
      'mixed'     : cap 内外が混在
    """
    if not positions:
        return 'not_found'
    if all(p < cap for p in positions):
        return 'all'
    if all(p >= cap for p in positions):
        return 'none'
    return 'mixed'


def analyze_session_info_extent(raw_bytes, cap=200000, si_len_reported=None):
    """★2026-07-24 Unit 0（Codex指示）：SessionInfo生バイト列の実データ範囲と必須キー位置を解析する純粋関数。
    poll_iracing()/read_session_info()から呼ばれる本番コード。単体テストからも直接呼べる。

    診断のみ。何も改変しない・何も判断しない（cap拡張や再読み取りはこの関数の責務外）。

    ★2026-07-24 Codex差戻し対応：
      P1：NUL終端後の古いメモリまでキー検索する誤動作を修正。検索対象は raw_bytes[:content_ends_at]
          に限定する（前セッションの残骸が偽検出されないため）。
      P2：cap境界のoff-by-one。content_ends_at == cap は raw[:cap] に実データが全部収まっているので
          safe/padded 側に含める。< cap ではなく <= cap を安全境界とする。

    Args:
      raw_bytes: SessionInfo領域から probe した生バイト列（呼び出し側で上限を明示）
      cap: 現行の operational read cap（200000）。判定にのみ使用
      si_len_reported: iRacing 側が報告した si_len（int）。verdict の判定に使う

    Returns:
      dict {
        'raw_bytes_analyzed': int,
        'si_len_reported': int|None,
        'first_nul_pos': int|None,     # 先頭NULの位置（None=raw内にNULが無い）
        'last_nonzero_pos': int|None,  # 最後の非ゼロバイトの位置
        'content_ends_at': int,        # 実データの終端推定
                                       # (first_nul_posがあればそこ・無ければraw末尾)
        'key_positions': {             # 必須キーの先頭バイト位置（content_ends_at 以降は検索対象外）
          'DriverInfo:': int|None,
          'SessionResults:': int|None,
          'Sessions:': int|None,
          'Positions:': int|None,
          'CarScreenName:': [int]      # 複数出現の全リスト
        },
        'cap_verdict': str             # 'safe' / 'padded_after_cap' / 'truncated_at_cap' / 'no_content'
      }

    verdict の定義（<= 境界を採用・実データが raw[:cap] に完全に収まるかで判定）:
      'safe'                 : content_ends_at <= cap かつ si_len_reported が cap 未満
                              （実データが cap 内に収まっており、si_len も cap 未満）
      'padded_after_cap'     : content_ends_at <= cap かつ si_len_reported >= cap
                              （実データは cap 内で終わっており、cap超えは NUL パディング）
      'truncated_at_cap'     : content_ends_at > cap（実データが cap を超えて続いている・末尾が失われている）
      'no_content'           : rawが空、または最初のバイトが 0（実データなし）
    """
    result = {
        'raw_bytes_analyzed': len(raw_bytes),
        'si_len_reported': si_len_reported,
        'first_nul_pos': None,
        'last_nonzero_pos': None,
        'content_ends_at': 0,
        'key_positions': {
            'DriverInfo:': None,
            'SessionResults:': None,
            'Sessions:': None,
            'Positions:': None,
            'CarScreenName:': [],
        },
        'cap_verdict': 'no_content',
    }
    if not raw_bytes:
        return result

    # 先頭NUL位置
    nul_pos = raw_bytes.find(b'\x00')
    result['first_nul_pos'] = nul_pos if nul_pos >= 0 else None

    # 最後の非ゼロバイト位置（末尾からNUL連続をスキップして探す）
    last_nz = None
    for i in range(len(raw_bytes) - 1, -1, -1):
        if raw_bytes[i] != 0:
            last_nz = i
            break
    result['last_nonzero_pos'] = last_nz

    # 実データの終端推定
    if nul_pos == 0 and last_nz is None:
        result['content_ends_at'] = 0
    elif nul_pos is not None and nul_pos >= 0:
        result['content_ends_at'] = nul_pos
    else:
        result['content_ends_at'] = len(raw_bytes)

    # ★P1：キー検索は content_ends_at で切ったバイト列のみを対象にする。
    #   NUL 以降に前セッションの残骸が残っていても、それは今の実データではないので偽検出を防ぐ。
    content_bytes = raw_bytes[:result['content_ends_at']]

    # 必須キーの位置探索（content_bytes 内のみ）
    for key in ('DriverInfo:', 'SessionResults:', 'Sessions:', 'Positions:'):
        pos = content_bytes.find(key.encode('ascii'))
        result['key_positions'][key] = pos if pos >= 0 else None

    # CarScreenName は複数車分あるので全出現位置を集める（content_bytes 内のみ）
    csn_key = b'CarScreenName:'
    positions = []
    start = 0
    while True:
        p = content_bytes.find(csn_key, start)
        if p < 0:
            break
        positions.append(p)
        start = p + len(csn_key)
    result['key_positions']['CarScreenName:'] = positions

    # ★P2：cap verdict の判定（<= 境界を採用）。
    #   content_ends_at == cap は raw[:cap] に実データが全部入っているので safe/padded 側に含める。
    if result['content_ends_at'] == 0:
        result['cap_verdict'] = 'no_content'
    elif result['content_ends_at'] <= cap:
        # 実データが cap 内で終わっている
        if si_len_reported is not None and si_len_reported >= cap:
            result['cap_verdict'] = 'padded_after_cap'
        else:
            result['cap_verdict'] = 'safe'
    else:
        # 実データが cap を超えて続いている
        result['cap_verdict'] = 'truncated_at_cap'

    return result


def parse_session_info(yaml_str):
    result = {}
    if not yaml_str:
        return result
    try:
        # Track name
        for line in yaml_str.split('\n'):
            line = line.strip()
            if line.startswith('TrackLength:'):
                # ★2026-07-20 ピットボックスまでの距離換算用（例 "TrackLength: 5.793 km"）
                try:
                    _tl = line.split(':',1)[1].strip().split()[0]
                    result['track_length_m'] = float(_tl) * 1000.0
                except Exception:
                    pass
            elif line.startswith('TrackName:'):
                result['track'] = line.split(':', 1)[1].strip()
            elif line.startswith('TrackDisplayName:'):
                result['track_display'] = line.split(':', 1)[1].strip()
            elif line.startswith('EventType:'):
                result['event_type'] = line.split(':', 1)[1].strip()
            elif line.startswith('SeriesID:'):
                try:
                    result['series_id'] = int(line.split(':', 1)[1].strip())
                except Exception:
                    pass
            elif line.startswith('SeasonID:'):
                try:
                    result['season_id'] = int(line.split(':', 1)[1].strip())
                except Exception:
                    pass
            elif line.startswith('RaceWeek:'):
                try:
                    result['race_week'] = int(line.split(':', 1)[1].strip())
                except Exception:
                    pass
            elif line.startswith('Official:'):
                result['official'] = line.split(':', 1)[1].strip().lower() in ('1', 'true')
            elif line.startswith('IsFixedSetup:'):
                result['is_fixed_setup'] = line.split(':', 1)[1].strip().lower() in ('1', 'true')
            elif line.startswith('DriverCarFuelMaxLtr:'):
                try:
                    result['driver_car_fuel_max_ltr'] = float(line.split(':', 1)[1].strip())
                except Exception:
                    pass
            elif line.startswith('DriverCarMaxFuelPct:'):
                try:
                    result['driver_car_max_fuel_pct'] = float(line.split(':', 1)[1].strip())
                except Exception:
                    pass

        # iRacingの車両物理タンク容量と、シリーズ/Fixed setupで許可された割合を分離する。
        # DriverCarMaxFuelPct は通常0..1だが、将来/SDK差で0..100表記でも安全に扱う。
        _physical_l = result.get('driver_car_fuel_max_ltr')
        _allowed_pct = result.get('driver_car_max_fuel_pct')
        if isinstance(_physical_l, (int, float)) and _physical_l > 0:
            result['physical_tank_capacity_l'] = round(float(_physical_l), 3)
            if isinstance(_allowed_pct, (int, float)) and _allowed_pct > 0:
                _ratio = float(_allowed_pct) / 100.0 if _allowed_pct > 1.0 else float(_allowed_pct)
                if 0 < _ratio <= 1.0:
                    result['session_fuel_limit_ratio'] = round(_ratio, 6)
                    result['effective_fuel_capacity_l'] = round(float(_physical_l) * _ratio, 3)

        # Parse Sessions list. EventType is the weekend type, not the active session.
        #   EventTypeは"週末イベント全体の種別"(Race週末なら予選中でも Race)なので当てにならない。
        #   現在走ってるセッションの種別は SessionNum で Sessions リストを引く必要がある。
        sessions = {}
        session_details = {}
        cur_snum = None
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('- SessionNum:'):
                try:
                    cur_snum = int(s.split(':', 1)[1].strip())
                    session_details.setdefault(cur_snum, {})
                except:
                    cur_snum = None
            elif s.startswith('SessionType:') and cur_snum is not None:
                sessions[cur_snum] = s.split(':', 1)[1].strip()
                session_details[cur_snum]['session_type'] = sessions[cur_snum]
            elif s.startswith('SessionLaps:') and cur_snum is not None:
                raw = s.split(':', 1)[1].strip().strip('"').strip("'")
                try:
                    session_details[cur_snum]['session_laps'] = int(raw)
                except Exception:
                    if raw:
                        session_details[cur_snum]['session_laps_text'] = raw
            elif s.startswith('SessionTime:') and cur_snum is not None:
                session_details[cur_snum]['session_time'] = s.split(':', 1)[1].strip().strip('"').strip("'")
        result['sessions'] = sessions
        result['session_details'] = session_details

        # Parse drivers for iRating and SOF
        drivers = []
        in_drivers = False
        current_driver = {}
        player_car_idx = -1

        for line in yaml_str.split('\n'):
            stripped = line.strip()
            if 'Drivers:' in line and stripped.startswith('Drivers:'):
                in_drivers = True
                continue
            if in_drivers:
                # ★2026-07-21 Codex指示R2「原因修正」：このブロックには終端検出が無く、YAMLの
                #   最後まで in_drivers=True のままだった。Drivers:より後のトップレベルキー
                #   （インデント無し行）に達したら抜ける。次の行が別セクションの同名フィールド
                #   （例：他のリストのIRating:等）を最後のdriverへ誤って上書きする事故を防ぐ
                #   （SplitTimeInfo:ブロックの終端検出＝この関数の別の場所と同じパターン）。
                if line and stripped and not line[0].isspace() and ':' in stripped and not stripped.startswith('-'):
                    in_drivers = False
                    if current_driver:
                        drivers.append(current_driver)
                        current_driver = {}
                    continue
                if stripped.startswith('- CarIdx:'):
                    if current_driver:
                        drivers.append(current_driver)
                    current_driver = {'car_idx': int(stripped.split(':')[1].strip())}
                elif stripped.startswith('IRating:'):
                    try:
                        current_driver['irating'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('LicLevel:'):
                    try:
                        current_driver['lic_level'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('LicSubLevel:'):
                    try:
                        current_driver['lic_sublevel'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('UserName:'):
                    current_driver['name'] = stripped.split(':', 1)[1].strip()
                elif stripped.startswith('CarNumber:'):
                    current_driver['car_number'] = stripped.split(':', 1)[1].strip().strip('"').strip("'")
                elif stripped.startswith('IsSpectator:'):
                    try:
                        current_driver['spectator'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('CarIsPaceCar:'):
                    current_driver['pace_car'] = stripped.split(':', 1)[1].strip().lower() in ('1', 'true')
                elif stripped.startswith('CarClassID:'):
                    try:
                        current_driver['class_id'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('CarClassShortName:'):
                    current_driver['class_name'] = stripped.split(':', 1)[1].strip()
                elif stripped.startswith('CarScreenName:'):
                    current_driver['car_model'] = (
                        stripped.split(':', 1)[1].strip()
                        .strip('"').strip("'"))
                elif stripped.startswith('CarClassRelSpeed:'):
                    try:
                        current_driver['class_rel_speed'] = int(stripped.split(':')[1].strip())
                    except:
                        pass

        if current_driver:
            drivers.append(current_driver)

        # Get player car idx（iRacingの正式名は DriverCarIdx。PlayerCarIdxもフォールバック）
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('DriverCarIdx:'):
                try:
                    player_car_idx = int(s.split(':')[1].strip())
                    break
                except:
                    pass
        if player_car_idx < 0:
            for line in yaml_str.split('\n'):
                if 'PlayerCarIdx:' in line:
                    try:
                        player_car_idx = int(line.split(':')[1].strip())
                    except:
                        pass
                    break

        # Entry list authority and SOF have different membership rules:
        # AI cars can have no iRating but still occupy a real grid slot. Count every
        # non-spectator, non-pace-car entry; use rated humans only for SOF.
        entry_drivers = [
            d for d in drivers
            if d.get('spectator', 0) == 0
            and not d.get('pace_car', False)
            and str(d.get('name', '')).strip().lower() not in ('pace car', 'safety car')
        ]
        rated_drivers = [d for d in entry_drivers if d.get('irating', 0) > 0]
        if entry_drivers:
            result['num_drivers'] = len(entry_drivers)
            class_counts = {}
            for d in entry_drivers:
                class_name = str(d.get('class_name') or '').strip()
                if class_name:
                    class_counts[class_name] = class_counts.get(class_name, 0) + 1
            result['class_entry_counts'] = class_counts
        if rated_drivers:
            sof = int(sum(d['irating'] for d in rated_drivers) / len(rated_drivers))
            result['sof'] = sof

        # Store drivers and player_car_idx for class map
        result['drivers'] = drivers
        result['player_car_idx'] = player_car_idx

        # Get player info
        player = next((d for d in drivers if d.get('car_idx') == player_car_idx), None)
        if player:
            result['player_irating'] = player.get('irating', 0)
            result['player_car_class'] = player.get('class_name', '')  # 例"GT3"。記憶のキー(コース×車種)に使う
            result['player_car_model'] = player.get('car_model', '')
            lic_level = player.get('lic_level', 0)
            lic_sublevel = player.get('lic_sublevel', 0)
            # Convert to SR display (e.g., B 4.50)
            lic_names = {1: 'R', 2: 'D', 3: 'C', 4: 'B', 5: 'A'}
            lic_name = lic_names.get(lic_level, '?')
            sr_value = round(lic_sublevel / 100, 2)
            result['safety_rating'] = lic_name + ' ' + str(sr_value)
            result['safety_rating_raw'] = sr_value
            result['player_class_entry_count'] = result.get('class_entry_counts', {}).get(
                player.get('class_name', ''), 0)

        # QualifyResultsInfo is authoritative only when the player's row contains a
        # positive lap time. Never reinterpret live Position or iRating as a grid result.
        qualify_results = []
        in_qualify_results = False
        current_result = {}
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('QualifyResultsInfo:'):
                in_qualify_results = True
                continue
            if in_qualify_results:
                if line and s and not line[0].isspace() and ':' in s:
                    if current_result:
                        qualify_results.append(current_result)
                        current_result = {}
                    break
                if s.startswith('- Position:'):
                    if current_result:
                        qualify_results.append(current_result)
                    current_result = {}
                    try:
                        current_result['position_zero'] = int(s.split(':', 1)[1].strip())
                    except Exception:
                        pass
                elif s.startswith('ClassPosition:'):
                    try:
                        current_result['class_position_zero'] = int(s.split(':', 1)[1].strip())
                    except Exception:
                        pass
                elif s.startswith('CarIdx:'):
                    try:
                        current_result['car_idx'] = int(s.split(':', 1)[1].strip())
                    except Exception:
                        pass
                elif s.startswith('FastestTime:'):
                    try:
                        current_result['fastest_time'] = float(s.split(':', 1)[1].strip())
                    except Exception:
                        pass
        if in_qualify_results and current_result:
            qualify_results.append(current_result)
        player_qual = next((q for q in qualify_results if q.get('car_idx') == player_car_idx), None)
        if player_qual and player_qual.get('fastest_time', -1) > 0:
            # Do not assume whether SDK Position fields are zero- or one-based.
            # A zero row proves zero-based. Without one, position stays unavailable
            # until a real dump establishes a stronger contract.
            overall_zero_based = any(q.get('position_zero') == 0 for q in qualify_results)
            player_class = player.get('class_name', '') if player else ''
            class_zero_based = any(
                q.get('class_position_zero') == 0
                and next((d for d in drivers if d.get('car_idx') == q.get('car_idx')), {}).get('class_name', '') == player_class
                for q in qualify_results)
            result['qualifying_result'] = {
                'status': 'valid',
                'overall_position': player_qual.get('position_zero', -1) + 1
                    if overall_zero_based and player_qual.get('position_zero', -1) >= 0 else None,
                'class_position': player_qual.get('class_position_zero', -1) + 1
                    if class_zero_based and player_qual.get('class_position_zero', -1) >= 0 else None,
                'fastest_time': player_qual['fastest_time'],
                'source': 'QualifyResultsInfo',
                'position_base_verified': overall_zero_based,
                'class_position_base_verified': class_zero_based
            }
        elif in_qualify_results:
            result['qualifying_result'] = {
                'status': 'no_valid_time',
                'overall_position': None,
                'class_position': None,
                'fastest_time': None,
                'source': 'QualifyResultsInfo'
            }
        else:
            result['qualifying_result'] = {
                'status': 'unavailable',
                'overall_position': None,
                'class_position': None,
                'fastest_time': None,
                'source': None
            }

        # セクター構成（SplitTimeInfo > Sectors > SectorStartPct）
        sectors = []
        in_split = False
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('SplitTimeInfo:'):
                in_split = True
                continue
            if in_split:
                if s.startswith('SectorStartPct:'):
                    try:
                        sectors.append(float(s.split(':', 1)[1].strip()))
                    except:
                        pass
                # SplitTimeInfoブロックの終わり（次のトップレベルキー）で抜ける
                elif s and not s.startswith('-') and not s.startswith('Sector') and ':' in s and not line.startswith(' '):
                    in_split = False
        if sectors:
            result['sectors'] = sorted(sectors)
            result['num_sectors'] = len(sectors)

    except Exception as e:
        print('Session info parse error:', e)

    return result


def fmt_time(seconds):
    if seconds is None or seconds <= 0:
        return None
    m = int(seconds / 60)
    s = seconds % 60
    return "%d:%06.3f" % (m, s)

def fmt_radio(seconds):
    # 本物のF1無線方式：分は言わず「秒」だけ言う。ドライバーは自分が何分台かは分かっている。
    # 秒は必ず2桁ゼロ埋め：101.589(1:41.589) -> 「41.589」 / 121.567(2:01.567) -> 「01.567」 / 45.3 -> 「45.300」。
    # 【例外】00秒台（分ちょうど付近）だけは分を付ける：120.567(2:00.567) -> 「2:00.567」。
    #   ← 分を落とすと「0.567」になり“0秒5”と誤解させ危険なため、この時だけ分を残す。
    # タイムは1/1000秒（サウザンス）まで＝iRacing表示と一致。
    if seconds is None or seconds <= 0:
        return None
    m = int(seconds // 60)
    s = seconds - m * 60
    if m >= 1 and int(s) == 0:
        return "%d:%06.3f" % (m, s)   # 2:00.567（00秒台は分をつける・コロンありで時刻扱い＝日付誤読しない）
    # ★2026-07-19 日付誤読バグ根絶：秒部分が1桁だと従来の2桁ゼロ埋めが「06.630」を作り、
    #   Google TTSがこれを"日付"(6月…)として読む(まーぼー/YujiがRoadAmerica/Interlagosで発覚)。
    #   先頭ゼロを外して「6.630」にすれば数値として正しく読まれる。3桁小数は維持。
    return "%.3f" % s                 # 24.567 / 6.630 / 45.300（先頭ゼロ無し＝日付に誤読されない）


_str_type_logged = False   # SDK型診断を1回だけ出すためのフラグ（2026-07-20）
reader = IRacingReader()
session_info_sent = False
_iracing_mem_detected = False
_iracing_telemetry_active = False

def poll_iracing():
    global session_info_sent, _lifecycle_state
    global _iracing_mem_detected, _iracing_telemetry_active
    ir_was_connected = False
    inactive_diag_at = 0.0
    last_lap_time = None
    session_best = None
    personal_best = None
    prev_current_lap = None
    player_car_idx = -1
    player_class_id = -1
    car_class_map = {}          # car_idx -> class_id
    sessions_map = {}           # SessionNum -> SessionType（現在のセッション種別判定用）
    car_relspeed_map = {}       # car_idx -> rel speed
    car_irating_map = {}        # car_idx -> iRating（危険ドライバー警告用）
    car_sr_map = {}             # car_idx -> Safety Rating値（例 2.34）
    car_number_map = {}         # car_idx -> ゼッケン（危険ドライバー警告での認識度向上用）
    car_class_name_map = {}     # car_idx -> クラス名（例"GTP"。マルチクラス接近警告での読み上げ用）
    ahead_armed = {}            # car_idx -> bool（前方の危険ドライバー警告・再武装フラグ）
    danger_warned = {}          # car_idx -> last warned time（前後共通クールダウン）
    danger_ever_warned = set()  # car_idx -> このセッションで既に警告済みか（同じ危険ドライバーへの連呼を根絶。ギャップ往復での再発火を防ぐため再武装方式でなく永久に1回のみ）
    player_rel_speed = 0
    is_race_session = False
    inactive_since = None
    # ★2026-07-26 Unit E0：Driver Handoff/Inactive Driver 状態管理。
    #   純粋関数 driver_activity_mod.evaluate_driver_activity() の呼び出し用ローカル状態。
    #   session_scoped_reset にも登録し SessionNum/sig 両経路でリセットする。
    _driver_activity_local = driver_activity_mod.ACTIVE
    _driver_activity_handoff_start = None
    _force_driver_activity_broadcast = False
    # ★v3 Codex P0-4：summary pending 状態。broadcast() が dispatch 失敗した場合、
    #   payload をここに保持し、通常ポーリング位置で毎フレーム再試行する。
    #   trigger 条件が満たされた瞬間だけでなく、以降のフレームでも送信可能に。
    #   SessionNum 変更で破棄（次セッションへ持ち越さない）。summary_sent=True 後は None。
    _pending_summary = None
    _pending_non_race_summary = None
    _pending_checker_notice = None
    multiclass_warned = {}      # car_idx -> last warned time (5s stage)
    multiclass_2s_warned = {}   # car_idx -> last warned time (2s stage)
    multiclass_armed = {}       # car_idx -> bool（6秒より離れたら再武装。張り付き連呼防止）
    multiclass_stage = {}       # car_idx -> 速いクラス接近の直近段階(0=未/1=5秒/2=2秒)。段階を跨いだ時だけ発火＝連呼防止
    last_mc_diag_ts = 0.0       # マルチクラス「コールゼロ」診断ログの最終出力時刻
    battle_warned = {}          # car_idx -> last warned time
    last_battle_global = 0.0    # 全車共通のバトルコール間隔（連鎖スパム防止）
    behind_armed = {}           # car_idx -> bool（一度離れて再接近した時だけ1回警告する再武装フラグ）
    battle_ever_warned = set()  # car_idx -> このセッションで一度でもbattle_behindを鳴らした相手か（2回目以降は"再接近"の言い方にする）
    prev_session_state = 0      # previous SessionState value
    race_start_time = None      # wall time when Racing state began
    rolling_gap_warned_time = 0 # last rolling-start gap call time
    last_telem_ts = 0.0         # ライブテレメトリ・スナップショットの最終送信時刻
    nearest_ahead_gap = None    # 直前の車とのギャップ（秒）
    nearest_behind_gap = None   # 直後の車とのギャップ（秒）
    car_pos_hist = {}           # car_idx -> (LapDistPct, timestamp)（停止車両検知用）
    car_stopped_since = {}      # car_idx -> 停止し始めた時刻（動いていればキー無し）
    stopped_check_ts = 0.0      # 停止判定の最終サンプリング時刻
    stopped_armed = {}          # car_idx -> bool（7秒圏外まで離れたら再武装）
    stopped_warned = {}         # car_idx -> last warned time
    catchup_stage = {}          # car_idx -> 前方車両への段階的キャッチアップコール、直近で知らせた段階(0=未・1=7秒・2=4秒・3=3秒・4=1.5秒)
    defend_stage = {}           # car_idx -> 後方車両への段階的ディフェンスコール、同上
    judge_llm_call_times = []   # judge_call(間引き対象kind)がLLMへ問い合わせた直近の時刻（JUDGE_LLM_BUDGET_MAX判定用）
    judge_llm_skip_log_last = {}  # kind -> 最後にcandidate-skipログを出した時刻（毎ポーリング連呼の抑止）
    gap_pace_hist = {}          # car_idx -> 直前ラップでのpace_diff（トレンド判定・確度の高低に使う）
    dir_fix_seen = {}           # car_idx -> 直近ログ済みの前後食い違い状態（DIR FIX診断のログ肥大を防ぐ間引き用）
    in_corner = False           # コーナー単位サイドバイサイド検知：今コーナー中か
    corner_over_count = 0       # 舵角がCORNER_ENTRY_RADを超えた連続サンプル数
    corner_under_count = 0      # 舵角がCORNER_EXIT_RADを下回った連続サンプル数
    corner_sides_announced = set()  # 今のコーナーで既に知らせた側（'left'/'right'/'both'）。コーナー(ゾーン)が変わったらリセット
    straight_sbs_warned = 0.0   # ストレートでの3台以上並走、最終通知時刻（クールダウン用）
    side_zone_active = False    # ⑤ コーナー or 強ブレーキ中の「サイドカー通知ゾーン」に今いるか（立ち上がりで再武装）
    prev_limiter_on = False     # ⑥ 直前ループでピットリミッターが作動中だったか（ON→OFF検知用）
    limiter_off_announced_stop = False  # ⑥ 今回のピットストップで既に「リミッターオフ」を鳴らしたか（二重発火防止）
    # セッションサマリー蓄積
    session_laps = []           # [{lap, time, sectors, class_pos, incident_delta}]
    session_incidents_total = 0
    session_track = ''
    session_car_class = ''
    session_car_model = ''
    session_event_type = ''
    session_num_in_class = 0
    pit_enter_time = None   # ピットレーン進入時のSessionTime（所要時間実測用）
    pit_enter_pos = None    # 進入時のクラス順位（復帰順位の比較用）
    pit_entry_announced_stop = False  # SDK接近境界で先行通知済みか（1ストップ1回）
    summary_sent = False        # チェッカー後に1回だけ送る
    checkered_pending = False   # チェッカー(全体状態)は見えたが、自分はまだ完走してない待機フラグ
    session_racing_started = False  # SessionState 4(Racing)を確認した後のみサマリー送信
    fuel_strategy_warned = False
    fuel_warning_band = None
    # ★2026-07-21 Codex指示R1：レース終了状態機械（RACING/CHECKER_OUT/PLAYER_FINISHED/DEBRIEF）。
    #   詳細はrace_lifecycle.py参照。リーダーのチェッカーと自分の完走を区別できていなかった
    #   2026-07-21 Monza実走の誤発話（燃料警告誤爆・レース終了訂正）を受けて新設。
    race_lifecycle_fsm = race_lifecycle.RaceLifecycle()
    checker_out_notice_sent = False   # CHECKER_OUT中の一度きり通知（Codex指示§3）
    last_laps_remaining_est = None    # State5以後、残り周回推定値を増加させないためのクランプ基準
    _car_idx_lap_completed_checked = False  # CarIdxLapCompletedの実在確認（診断は1回だけ）
    last_session_num = None           # ★P0(2026-07-21 Codex再指示)：SessionNum変更検知の基準値
    final_lap_notice_sent = {5: False, 3: False, 1: False}  # ★P1：Last 5/3/1の一度きり通知
    fuel_at_lap_start = None    # 直近ラップ開始時点の燃料残量（ラップ消費量算出用）
    fuel_per_lap_hist = []      # 直近ラップ毎の消費量（外れ値を均すため直近5周の平均を使う）
    pit_this_lap = False        # この周でピットを通ったか（アウト/インラップは燃料学習から除外）
    lap_time_hist = []          # 直近ラップタイム履歴（時間制セッションの残り周回推定に使う・瞬間値の異常値対策）
    fuel_strategy = None        # 直近算出した燃料戦略(dict)。telemetry_liveで毎回同送する
    session_check_counter = 0
    last_session_sig = None
    consecutive_slow = 0       # (旧lap_slow用・2026-07-19のタイム読み上げ再設計で未使用化)
    consistent_lap_count = 0   # (旧lap_consistent用・同上)
    pace_check_last_lap = -99  # ペース判断を最後に投げた周回（3周に1回までに制限＝連呼防止）
    pit_box_pct = None         # 自分のピットボックスのLapDistPct（初回入庫で学習・以後カウントダウンに使う）
    pit_marks_called = set()   # 今回の入庫で読み上げ済みの距離マーカー
    pit_prev_dist_m = None     # 前サンプルのボックスまでの距離（閾値横断の判定用）
    track_length_m = None      # コース長(m)。ピット距離の換算用
    lap_delta_hist = []        # 直近ラップのsession_best差分履歴（AIペース判断用の生データ、直近8周）
    debug_counter = 0
    # ★2026-07-24 tow_active 削除：towing機能廃止（Yuji方針・ドライバー自発会話に任せる）
    # ★2026-07-24 post_contact_ok：crash_check発火から5秒間の走行継続監視
    #   接触後、5秒間 Speed>30km/h(=8.33m/s) を維持できたら「アライメント影響ある？」の第二声。
    #   途中で Speed<30km/h に落ちたら停止判定＝黙る（ドライバーの決定待ち）。
    post_contact_watch_start = None   # クラッシュ検知時刻（SessionTime基準）。Noneで未監視
    post_contact_speed_ok    = True   # 監視窓中に Speed>30 を維持できてるかフラグ
    prev_damage_s = 0.0        # 前回計測のdamage_s（義務+任意修理秒）。増えたら1回だけダメージ報告
    prev_incidents = None
    incident_times = []
    prev_driver_state = None
    leader_lap_time_hist = []       # 1位の直近ラップタイム履歴（タイムサーティン耐久の終了予測用）
    leader_last_laptime_seen = None # 同じラップタイム値を重複して履歴に積まないための直前値
    sector_bounds = []          # 例 [0.0, 0.333, 0.667]
    cur_sector = None
    sector_entry_time = None
    lap_sector_times = []
    best_sectors = []
    prev = {
        'pos': None, 'class_pos': None, 'fuel': None, 'lap': None,
        'lapsTot': None, 'onPit': None, 'tempLap': None
    }

    while True:
        if not reader.is_open():
            if reader.open():
                log("iRacing memory map opened (attached to iRacing)")
                _iracing_mem_detected = True
                _iracing_telemetry_active = False
                inactive_diag_at = 0.0
                broadcast({'type': 'iracing_detected', 'telemetry_active': False})
            else:
                _iracing_mem_detected = False
                _iracing_telemetry_active = False
                time.sleep(2)
                continue

        active = reader.is_active()

        if active and not ir_was_connected:
            log(">>> iRacing CONNECTED - telemetry flowing")
            session_info_sent = False
            reader.var_cache.clear()
            broadcast({'type': 'iracing_connected'})
            # rendererの初期値ACTIVEを引きずらせず、このloopで評価した現状態を必ず続けて通知する。
            _force_driver_activity_broadcast = True
            ir_was_connected = True
            _iracing_telemetry_active = True
            inactive_since = None
            prev_current_lap = None   # セッション移行後の誤検知防止
            last_lap_time   = None   # 次の本当のラップを必ず報告
            # ★コース/セッションが変わったら前のベストを引きずらない。
            #   でないと前コースのベストと比較して「2周続けて遅い」等の誤爆が出る。
            session_best        = None
            personal_best       = None
            consecutive_slow    = 0
            consistent_lap_count = 0
            pace_check_last_lap = -99
            # ★2026-07-20 セッションが変わったら燃料の完走判定を白紙に戻す。
            #   実走：レース終了直後に次セッションの時計(timeRem=678.5)が入り「あと7周」と誤認し、
            #   ファイナルラップで「燃料が持たない、ピット計画を決めよう」と誤警告した。
            fuel_strategy_warned = False
            fuel_warning_band = None
            leader_lap_time_hist.clear()
            lap_delta_hist.clear()
        if active:
            # 15秒未満のSDK瞬断から復帰した場合も内部スナップショットをActiveへ戻す。
            _iracing_telemetry_active = True
            inactive_since = None

        # 切断は15秒間ずっと非アクティブな時だけ（セッション移行・ロード中を含むブリップで初期化しない）
        if not active and ir_was_connected:
            _iracing_telemetry_active = False
            if inactive_since is None:
                inactive_since = time.time()
            elif time.time() - inactive_since >= 15.0:
                log("<<< iRacing DISCONNECTED (sustained 15s)")
                broadcast({'type': 'iracing_disconnected'})
                ir_was_connected = False
                _iracing_mem_detected = False
                _iracing_telemetry_active = False
                session_info_sent = False
                last_session_sig = None
                inactive_since = None
                # ベストタイム/セクターは保持する（週末を通して継続＝エンジニアの記憶）
                reader.close()
                time.sleep(2)
                continue
            # 15秒未満の中断：何もせず維持（記憶も接続も保つ）
            time.sleep(0.3)
            continue
        elif not active:
            # 共有メモリは見えているがStatus=0の状態を、10秒ごとに原因判定可能な形で残す。
            # 2026-07-27 八木氏Build 230ではopen後36秒間ここに留まり、従来ログでは
            # 「Waiting for iRacing」しか出ず、ロード中／SDK非Activeを区別できなかった。
            now_diag = time.time()
            if now_diag - inactive_diag_at >= 10.0:
                inactive_diag_at = now_diag
                try:
                    status_raw = reader._read_int(reader.H_STATUS)
                    _buf_off, tick = irsdk_mem.get_buf_offset(reader._ptr)
                    log("IRSDK WAIT: memory_open=1 status=%s tick=%s telemetry_active=0" %
                        (status_raw, tick))
                except Exception as diag_error:
                    log("IRSDK WAIT: memory_open=1 status=read_error telemetry_active=0 error=" +
                        str(diag_error))
            time.sleep(0.3)
            continue
        else:
            inactive_since = None

        if not active:
            time.sleep(1)
            continue

        # Send session info once per connection
        # セッション情報：初回送信＋10秒ごとに変更チェック（練習→レース移行を検知）
        session_check_counter += 1
        if not session_info_sent or session_check_counter >= 100:
            session_check_counter = 0
            yaml_str = reader.read_session_info()
            if yaml_str:
                info = parse_session_info(yaml_str)
                _authority_session_num = reader.read_int('SessionNum')
                _session_authority, sig = (
                    session_authority_mod.build_session_authority(
                        info, _authority_session_num))
                info['current_session_authority'] = _session_authority
                info['current_session_num'] = _session_authority['session_num']
                info['current_session_type'] = _session_authority['session_type']
                # ★2026-07-21 Codex指示R2「原因修正」：read-only診断。DriverInfoから解析できた人数と、
                #   実テレメトリ上に car_idx が見えている数を突き合わせる。大きく食い違えば
                #   YAML解析側（parse_session_info）の問題、一致していれば「iRatingフィルタで
                #   AI車が除外される」側の問題、と次回1回の実走ログで切り分けられる。
                try:
                    _diag_cls_pos = reader.read_int_array('CarIdxClassPosition', 64)
                    _diag_live_cars = sum(1 for v in (_diag_cls_pos or []) if v and v > 0)
                    log("SESSION INFO DIAG: parsed_drivers=%d (real_drivers filter=%d) vs live_telemetry_cars=%d"
                        % (len(info.get('drivers', [])), info.get('num_drivers', 0), _diag_live_cars))
                except Exception as _e:
                    log("SESSION INFO DIAG error: " + str(_e))
                if info.get('player_car_idx', -1) >= 0:
                    if info.get('sessions'):
                        sessions_map = info['sessions']   # {SessionNum: SessionType}
                        if info.get('track_length_m'):
                            track_length_m = info['track_length_m']
                    session_track = info.get('track', '')
                    session_car_class = info.get('player_car_class', '')
                    session_car_model = info.get('player_car_model', '')
                    session_event_type = info.get('event_type', '')
                    session_num_in_class = info.get('num_drivers', 0)
                    session_info_sent = True
                    # ── 本当に新しいセッションの時だけ：briefing送信＋状態リセット ──
                    if (sig != last_session_sig
                            and last_session_sig is not None
                            and sig[:2] == last_session_sig[:2]
                            and _authority_session_num == last_session_num):
                        broadcast({'type': 'session_info', 'data': info})
                        log("Session authority transition sent without duplicate reset: "
                            + str(last_session_sig) + " -> " + str(sig))
                        last_session_sig = sig
                    if sig != last_session_sig:
                        broadcast({'type': 'session_info', 'data': info})
                        log("Session info sent: " + str(info.get('event_type')) + " SOF:" + str(info.get('sof'))
                            + " class:" + str(info.get('player_car_class')) + " drivers:" + str(info.get('num_drivers'))
                            + " car:" + str(info.get('player_car_model'))
                            + " currentSession:" + str(info.get('current_session_type'))
                            + " track:" + str(info.get('track')) + " iR:" + str(info.get('player_irating'))
                            + " SR:" + str(info.get('safety_rating'))
                            + " fuelPhysicalL:" + str(info.get('physical_tank_capacity_l'))
                            + " fuelLimitRatio:" + str(info.get('session_fuel_limit_ratio'))
                            + " fuelEffectiveL:" + str(info.get('effective_fuel_capacity_l'))
                            + " series:" + str(info.get('series_id'))
                            + " season:" + str(info.get('season_id'))
                            + " week:" + str(info.get('race_week'))
                            + " fixed:" + str(info.get('is_fixed_setup')))
                        # ── 診断ログ：ゼッケンとSRの不一致調査（2026-07-14 Yuji IMSA実走）──────────
                        # #28のログSR2.23 vs 結果画面SR1.51の食い違いを次回切り分けるため、iRacingの
                        # DriverInfoが「セッション開始時点で」各車に何を報告しているかをそのまま吐く。
                        # ここの値=結果画面の最終値なら我々の紐付けバグ、違えば開始時スナップショット問題。
                        for _dd in info.get('drivers', []):
                            if _dd.get('spectator', 0) == 0 and _dd.get('irating', 0) > 0:
                                _srv = round(_dd.get('lic_sublevel', 0) / 100, 2)
                                log("  DRIVER idx=" + str(_dd.get('car_idx')) + " #" + str(_dd.get('car_number', '?'))
                                    + " '" + str(_dd.get('name', '?')) + "' LIC=" + str(_dd.get('lic_level', '?'))
                                    + "." + str(_dd.get('lic_sublevel', '?')) + "(SR " + str(_srv) + ")"
                                    + " iR=" + str(_dd.get('irating', '?')) + " class=" + str(_dd.get('class_name', '?')))
                        last_session_sig = sig
                        race_lifecycle_fsm.reset()
                        _sig_reset = _session_scoped_reset_values()
                        checker_out_notice_sent = _sig_reset['checker_out_notice_sent']
                        last_laps_remaining_est = _sig_reset['last_laps_remaining_est']
                        final_lap_notice_sent = _sig_reset['final_lap_notice_sent']
                        fuel_strategy_warned = _sig_reset['fuel_strategy_warned']
                        fuel_warning_band = _sig_reset['fuel_warning_band']
                        fuel_per_lap_hist = _sig_reset['fuel_per_lap_hist']
                        fuel_at_lap_start = _sig_reset['fuel_at_lap_start']
                        lap_time_hist = _sig_reset['lap_time_hist']
                        fuel_strategy = _sig_reset['fuel_strategy']
                        pit_this_lap = _sig_reset['pit_this_lap']
                        pace_check_last_lap = _sig_reset['pace_check_last_lap']
                        lap_delta_hist = _sig_reset['lap_delta_hist']
                        leader_lap_time_hist = _sig_reset['leader_lap_time_hist']
                        leader_last_laptime_seen = _sig_reset['leader_last_laptime_seen']
                        prev_session_state = _sig_reset['prev_session_state']
                        race_start_time = _sig_reset['race_start_time']
                        pit_enter_time = _sig_reset['pit_enter_time']
                        pit_enter_pos = _sig_reset['pit_enter_pos']
                        pit_entry_announced_stop = _sig_reset['pit_entry_announced_stop']
                        summary_sent = _sig_reset['summary_sent']
                        checkered_pending = _sig_reset['checkered_pending']
                        session_racing_started = _sig_reset['session_racing_started']
                        session_laps = _sig_reset['session_laps']
                        # ★2026-07-23 Codex再指摘 P1(2回目)：SessionNum経路と同じくsig経路でも
                        #   LLM候補予算をリセットしないと、trackやevent_typeが変わった瞬間に
                        #   前セッションの予算満杯を持ち越して最初のcallが通らない事故になる。
                        judge_llm_call_times = _sig_reset['judge_llm_call_times']
                        judge_llm_skip_log_last = _sig_reset['judge_llm_skip_log_last']
                        # ★2026-07-24 Codex P1：接触監視もsig変更で捨てる
                        post_contact_watch_start = _sig_reset['post_contact_watch_start']
                        post_contact_speed_ok = _sig_reset['post_contact_speed_ok']
                        # ★2026-07-26 Unit E0：Driver Handoff 状態もsig変更で捨てる
                        _driver_activity_local = _sig_reset['_driver_activity_local']
                        _driver_activity_handoff_start = _sig_reset['_driver_activity_handoff_start']
                        broadcast({'type': 'driver_activity', 'state': _driver_activity_local})
                        # ★v3 Codex P0-4：pending summary もsig変更で破棄
                        _pending_summary = _sig_reset['_pending_summary']
                        _pending_non_race_summary = _sig_reset['_pending_non_race_summary']
                        _pending_checker_notice = _sig_reset['_pending_checker_notice']
                        _gate_state['pending'] = None
                        _gate_state['since'] = 0.0
                        last_session_num = _authority_session_num
                if 'drivers' in info:
                    for d in info.get('drivers', []):
                        if 'car_idx' in d and 'class_id' in d:
                            car_class_map[d['car_idx']] = d['class_id']
                        if 'car_idx' in d and 'class_name' in d:
                            car_class_name_map[d['car_idx']] = d['class_name']
                        if 'car_idx' in d and 'car_number' in d:
                            car_number_map[d['car_idx']] = d['car_number']
                        if 'car_idx' in d and 'class_rel_speed' in d:
                            car_relspeed_map[d['car_idx']] = d['class_rel_speed']
                        if 'car_idx' in d and 'irating' in d:
                            car_irating_map[d['car_idx']] = d['irating']
                        if 'car_idx' in d and 'lic_level' in d:
                            # LicSubLevelは100倍値（例234→2.34）。無ければ中間値扱いで警告しない。
                            sub = d.get('lic_sublevel', 300)
                            car_sr_map[d['car_idx']] = round(sub / 100, 2)
                player_car_idx = info.get('player_car_idx', -1)
                player_class_id = car_class_map.get(player_car_idx, -1)
                player_rel_speed = car_relspeed_map.get(player_car_idx, 0)
                if info.get('sectors'):
                    sector_bounds = info['sectors']
                    best_sectors = [None] * len(sector_bounds)
                    log("Track sectors detected: " + str(len(sector_bounds)))

        pos         = reader.read_int('PlayerCarPosition')
        lapTime     = reader.read_float('LapLastLapTime')
        currentLap  = reader.read_float('LapCurrentLapTime')
        fuel        = reader.read_float('FuelLevel')
        lap         = reader.read_int('Lap')
        lapsTot     = reader.read_int('SessionLapsTotal')
        timeRemain  = reader.read_float('SessionTimeRemain')  # 時間制セッション用(秒)。周回制では巨大値/無関係
        # 診断（2026-07-20・1回だけ）：SessionTimeRemain の宣言型を実機で確定させる。
        #   型を見て読むよう直したが、「doubleだったはず」を推測で終わらせず実測で残す。
        global _str_type_logged
        if not _str_type_logged:
            _stinfo = reader.find_var('SessionTimeRemain')
            _lapsinfo = reader.find_var('SessionLapsRemain')
            log("SDK TYPE DIAG: SessionTimeRemain=%s (4=float,5=double) val=%s | SessionLapsRemain=%s val=%s"
                % (_stinfo[0] if _stinfo else 'n/a', timeRemain,
                   _lapsinfo[0] if _lapsinfo else 'n/a', reader.read_int('SessionLapsRemain')))
            _str_type_logged = True
        onPit       = reader.read_bool('OnPitRoad')
        onTrack     = reader.read_bool('IsOnTrack')
        incidents   = reader.read_int('PlayerCarMyIncidentCount')
        if onPit:
            pit_this_lap = True   # この周でピットを通った→燃料学習から除外（アウト/インラップ）
        cur_ss      = reader.read_int('SessionState') or 0
        class_pos   = reader.read_int('PlayerCarClassPosition') or pos

        # 現在のセッションが「レース」か毎ループ判定（予選/練習でレース用アラートを出さない）。
        # EventTypeでなく SessionNum→SessionType で現在走行中のセッション種別を引く。
        cur_snum        = reader.read_int('SessionNum')
        cur_sess_type   = sessions_map.get(cur_snum, '') if cur_snum is not None else ''
        _previous_is_race_session = is_race_session
        is_race_session = ('race' in cur_sess_type.lower())

        # ★P0（2026-07-21 Codexレビュー再指摘・再々指摘で拡張）：SessionNum変更を直接検知して
        #   race_lifecycle_fsmと燃料/ラップ計測のセッション限定状態を一括resetする。
        #   旧実装は event_type|track の"sig"が変わった時にしかresetしておらず、同じイベント内での
        #   セッション遷移（Practice→Qualify→Race、耐久のレース1→レース2等）でSessionNumだけが
        #   変わるケースを取りこぼしていた。さらに再々指摘：FSMと通知フラグしかresetしておらず、
        #   fuel_strategy_warned等の燃料状態が前セッションから持ち越されていた。
        _transition_summary = None
        _changed, _reset = maybe_reset_on_session_num_change(
            cur_snum, last_session_num, race_lifecycle_fsm)
        if _changed:
            # Practice/Qualify summaryはgarageで確定しない。SessionNum変更だけを権威ある終了
            # シグナルとして、reset前の旧セッション記録を一度送る。別ドライバーへのhandoff中でも
            # セッションそのものが切り替わった事実は確定しているため、安全にsummary化できる。
            if driver_activity_mod.should_finalize_non_race_summary(
                    _changed, _previous_is_race_session, bool(session_laps),
                    session_racing_started, summary_sent):
                _old_times = [r['time'] for r in session_laps if r['time'] > 0]
                if _old_times:
                    _old_summary = {
                        'type': 'session_summary',
                        'track': session_track,
                        'car_class': session_car_class,
                        'car_model': session_car_model,
                        'event_type': session_event_type,
                        'is_race': False,
                        'total_laps': len(session_laps),
                        'finish_pos': class_pos,
                        'best_lap': round(min(_old_times), 3),
                        'worst_lap': round(max(_old_times), 3),
                        'avg_lap': round(sum(_old_times) / len(_old_times), 3),
                        'avg_fuel_per_lap': (
                            round(sum(fuel_per_lap_hist) / len(fuel_per_lap_hist), 2)
                            if fuel_per_lap_hist else None),
                        'incidents': prev_incidents or 0,
                        'laps': list(session_laps),
                    }
                    _transition_summary = _old_summary
            checker_out_notice_sent = _reset['checker_out_notice_sent']
            last_laps_remaining_est = _reset['last_laps_remaining_est']
            final_lap_notice_sent = _reset['final_lap_notice_sent']
            fuel_strategy_warned = _reset['fuel_strategy_warned']
            fuel_warning_band = _reset['fuel_warning_band']
            fuel_per_lap_hist = _reset['fuel_per_lap_hist']
            fuel_at_lap_start = _reset['fuel_at_lap_start']
            lap_time_hist = _reset['lap_time_hist']
            fuel_strategy = _reset['fuel_strategy']
            pit_this_lap = _reset['pit_this_lap']
            pace_check_last_lap = _reset['pace_check_last_lap']
            lap_delta_hist = _reset['lap_delta_hist']
            leader_lap_time_hist = _reset['leader_lap_time_hist']
            leader_last_laptime_seen = _reset['leader_last_laptime_seen']
            prev_session_state = _reset['prev_session_state']
            race_start_time = _reset['race_start_time']
            pit_enter_time = _reset['pit_enter_time']
            pit_enter_pos = _reset['pit_enter_pos']
            pit_entry_announced_stop = _reset['pit_entry_announced_stop']
            summary_sent = _reset['summary_sent']
            checkered_pending = _reset['checkered_pending']
            session_racing_started = _reset['session_racing_started']
            session_laps = _reset['session_laps']
            judge_llm_call_times = _reset['judge_llm_call_times']
            judge_llm_skip_log_last = _reset['judge_llm_skip_log_last']
            # ★2026-07-24 Codex P1：接触監視もSessionNum変更で捨てる
            post_contact_watch_start = _reset['post_contact_watch_start']
            post_contact_speed_ok = _reset['post_contact_speed_ok']
            # ★2026-07-26 Unit E0：Driver Handoff 状態もSessionNum変更で捨てる
            _driver_activity_local = _reset['_driver_activity_local']
            _driver_activity_handoff_start = _reset['_driver_activity_handoff_start']
            broadcast({'type': 'driver_activity', 'state': _driver_activity_local})
            _force_driver_activity_broadcast = False
            # ★v3 Codex P0-4：pending summary もSessionNum変更で破棄
            _pending_summary = _reset['_pending_summary']
            _pending_non_race_summary = _reset['_pending_non_race_summary']
            _pending_checker_notice = _reset['_pending_checker_notice']
            if _transition_summary is not None:
                _pending_non_race_summary = _transition_summary
                log("Non-race summary pending at SessionNum transition: %d laps"
                    % _transition_summary.get('total_laps', 0))
        if cur_snum is not None:
            last_session_num = cur_snum

        # SessionState: 3=ParadeLaps(formation/rolling), 4=Racing
        if cur_ss == 4 and prev_session_state != 4:
            race_start_time = time.time()
        if cur_ss >= 2:  # Warmup以上 = 何らかのセッションで走行中
            if onTrack:
                session_racing_started = True
        prev_session_state = cur_ss
        in_formation  = (cur_ss == 3)   # ローリング中 = ギャップコール停止
        # スタート直後の密集でバトルコールが暴発するのを抑制。
        # 30秒＋「1周目まるごと」＝ロングコース(ニュル等・1周7-8分)でも密集が解けるまで黙る。
        in_start_rush = (cur_ss == 4 and (
                            (race_start_time is not None and time.time() - race_start_time < 30)
                            or (lap is not None and lap <= 1)))

        # ── ドライバーの現在地（走行中/ピット/ガレージ）──
        if onPit:
            driver_state = 'pit'
        elif onTrack:
            driver_state = 'track'
        else:
            driver_state = 'garage'

        # ★2026-07-21 Codex指示R1：レース終了状態機械を毎フレーム更新する。
        #   CarIdxLapCompletedは実在未確認の変数のため、find_varで存在を確認できた時だけ使う
        #   （「存在を記憶で断定しない」Codex指示）。1回だけ結果をログに残す。
        if not _car_idx_lap_completed_checked:
            _clc_info = reader.find_var('CarIdxLapCompleted')
            log("SDK VAR CHECK: CarIdxLapCompleted " + ("exists" if _clc_info else "NOT FOUND") +
                " (race_lifecycleの補助判定はNoneのまま安全にフォールバックする)")
            _car_idx_lap_completed_checked = True
        _car_idx_lap_completed = None
        try:
            _clc_arr = reader.read_int_array('CarIdxLapCompleted', 64)
            if _clc_arr and 0 <= player_car_idx < len(_clc_arr):
                _car_idx_lap_completed = _clc_arr[player_car_idx]
        except Exception:
            pass
        _previous_lifecycle_state = race_lifecycle_fsm.state
        lifecycle_state = race_lifecycle_fsm.update(
            session_state=cur_ss, lap_last_lap_time=lapTime, telemetry_active=active,
            driver_state=driver_state, car_idx_lap_completed=_car_idx_lap_completed)
        _lifecycle_state = lifecycle_state  # ★P0：director_gate（module-level）から参照できるようにする
        if final_lap.should_dispatch_checker_notice(
                _previous_lifecycle_state, lifecycle_state,
                bool(final_lap_notice_sent.get(1, False))):
            _notice_fuel = round(fuel, 1) if fuel is not None else None
            _pending_checker_notice = {
                'type': 'radio',
                'trigger': 'checker_out_notice',
                'fuel': _notice_fuel,
                'message': (
                    'Checkered flag is out. Fuel remaining '
                    + str(_notice_fuel) + '.'
                    if _notice_fuel is not None
                    else 'Checkered flag is out.'),
            }

        # ★2026-07-26 Unit E0 v2 (Codex差戻し対応)：Driver Handoff/Inactive Driver 認識。
        #   使用者本人が非搭乗中（garage 中でチームメイトが走ってる）に本人向け自動発話を
        #   抑止するため、activity を毎フレーム計算して module-level に保持する。
        #   純粋関数 driver_activity_mod.evaluate_driver_activity() が状態遷移を担当。
        try:
            _da_now_time = reader.read_double('SessionTime')
        except Exception:
            _da_now_time = None
        # ★v3 Codex P0-1：明示的「運転支援再開」CMD フラグを消費
        #   （PTT は activity 判定源にしない・観戦者会話でも押されるため）
        _manual_resume_signal = _consume_manual_resume_signal()
        _new_activity, _driver_activity_handoff_start, _da_reason = (
            driver_activity_mod.evaluate_driver_activity(
                driver_state=driver_state,
                prev_activity=_driver_activity_local,
                lifecycle_state=lifecycle_state,
                handoff_start_time_s=_driver_activity_handoff_start,
                current_time_s=_da_now_time,
                manual_resume_signal=_manual_resume_signal,
            ))
        if _new_activity != _driver_activity_local:
            _activity_before = _driver_activity_local
            log("DRIVER ACTIVITY: %s -> %s (reason=%s driver_state=%s lifecycle=%s manual_resume=%s)" % (
                _driver_activity_local, _new_activity, _da_reason,
                driver_state, lifecycle_state, _manual_resume_signal))
            _driver_activity_local = _new_activity
            # Cost Telemetry とUIが「チーム車が走行中」と「本人が搭乗中」を混同しないための
            # 非音声メタデータ。E0の権威状態をそのままrendererへ渡す。
            broadcast({'type': 'driver_activity', 'state': _driver_activity_local})
            # 非搭乗中もチーム車テレメトリは更新されるため、各候補のarmed/stage/historyを
            # そのまま残すと、本人復帰時に「チームメイト走行中に消費した段階」を引き継ぐ。
            # ACTIVE復帰を新しい本人スティント境界として、本人向け判断状態だけを初期化する。
            if (_new_activity == driver_activity_mod.ACTIVE
                    and _activity_before != driver_activity_mod.ACTIVE):
                fuel_at_lap_start = None
                fuel_per_lap_hist = []
                fuel_strategy = None
                fuel_strategy_warned = False
                fuel_warning_band = None
                checker_out_notice_sent = False
                last_laps_remaining_est = None
                final_lap_notice_sent = {5: False, 3: False, 1: False}
                post_contact_watch_start = None
                post_contact_speed_ok = True
                multiclass_warned.clear()
                multiclass_2s_warned.clear()
                multiclass_armed.clear()
                multiclass_stage.clear()
                battle_warned.clear()
                behind_armed.clear()
                battle_ever_warned.clear()
                catchup_stage.clear()
                defend_stage.clear()
                gap_pace_hist.clear()
                danger_warned.clear()
                danger_ever_warned.clear()
                ahead_armed.clear()
                stopped_armed.clear()
                stopped_warned.clear()
                log("DRIVER ACTIVITY: new active stint — driver-scoped call state reset")
        if _force_driver_activity_broadcast:
            broadcast({'type': 'driver_activity', 'state': _driver_activity_local})
            _force_driver_activity_broadcast = False
        _set_driver_activity(_driver_activity_local)

        if _pending_non_race_summary is not None:
            _non_race_result = broadcast(_pending_non_race_summary)
            if _non_race_result == BROADCAST_DISPATCHED:
                log("Non-race summary dispatched from transition pending: %d laps"
                    % _pending_non_race_summary.get('total_laps', 0))
                _pending_non_race_summary = None

        # Checker fallback is retried throughout CHECKER_OUT. E0 may reject
        # the edge frame while the user is inactive or no client is attached;
        # only a real DISPATCHED result consumes it.
        if (_pending_checker_notice is not None
                and not checker_out_notice_sent
                and lifecycle_state == race_lifecycle.CHECKER_OUT):
            _checker_result = broadcast(_pending_checker_notice)
            if _checker_result == BROADCAST_DISPATCHED:
                checker_out_notice_sent = True
                _pending_checker_notice = None
        elif lifecycle_state != race_lifecycle.CHECKER_OUT:
            _pending_checker_notice = None

        # ★v3 Codex P0-4：session_summary の pending 化＋通常ポーリング位置での再試行。
        #   従来は driver_state 変化ブロック内でのみ 1発 broadcast し、失敗しても再試行なし
        #   （次フレームは driver_state 変化イベントが来ないため）。
        #   ここで毎フレーム条件を判定し、pending payload を作って retry ループへ送る。

        # pending race summary を必要なら生成（同じ payload を再送するのに使う）。
        # Practice/Qualifyは上のSessionNum変更時だけ確定し、garage単独では生成しない。
        if _pending_summary is None and not summary_sent and session_laps and session_racing_started:
            _may_summary = False
            if is_race_session:
                # レース：真の完走のみ（activity=FINISHED × lifecycle=PLAYER_FINISHED）
                # lifecycle は最終S/F通過を検出したフレームで先に PLAYER_FINISHED になるが、
                # session_laps への最終ラップ追加はこの後の lap_time_changed ブロックで行われる。
                # last_lap_time が現値へ追いつく次フレームまで待ち、最終ラップ欠落を防ぐ。
                _latest_lap_recorded = bool(
                    session_laps
                    and session_laps[-1].get('lap') == lap
                    and session_laps[-1].get('time') == round(lapTime, 3))
                _may_summary = (
                    driver_activity_mod.should_fire_race_summary(
                        _driver_activity_local, lifecycle_state)
                    and last_lap_time == lapTime
                    and _latest_lap_recorded)
            if _may_summary:
                _times = [r['time'] for r in session_laps if r['time'] > 0]
                if _times:
                    _best_t = min(_times)
                    _worst_t = max(_times)
                    _avg_fuel_summary = (
                        round(sum(fuel_per_lap_hist) / len(fuel_per_lap_hist), 2)
                        if fuel_per_lap_hist else None)
                    if is_race_session:
                        _half = max(1, len(_times) // 2)
                        _pace_first = round(sum(_times[:_half]) / _half, 3)
                        _pace_last = round(sum(_times[_half:]) / max(1, len(_times) - _half), 3)
                    else:
                        _pace_first = _pace_last = None
                    _pending_summary = {
                        'type': 'session_summary',
                        'track': session_track,
                        'car_class': session_car_class,
                        'car_model': session_car_model,
                        'event_type': session_event_type,
                        'is_race': is_race_session,
                        'total_laps': len(session_laps),
                        'finish_pos': class_pos,
                        'best_lap': round(_best_t, 3),
                        'worst_lap': round(_worst_t, 3),
                        'avg_lap': round(sum(_times) / len(_times), 3),
                        'avg_fuel_per_lap': _avg_fuel_summary,
                        'pace_first_half': _pace_first,
                        'pace_last_half': _pace_last,
                        'incidents': prev_incidents or 0,
                        'laps': session_laps,
                    }
                    log('Session summary pending: %d laps, best %s (route=%s)' % (
                        len(session_laps), str(round(_best_t, 3)),
                        'race' if is_race_session else 'non_race'))

        # pending 再送ループ（毎フレーム走る・成功まで諦めない）
        if _pending_summary is not None and not summary_sent:
            # ★v3 Codex P1：DISPATCHED のみ成功。HELD/DROPPED は同じpayloadを保持。
            _summary_snapshot = _pending_summary
            _pending_summary, summary_sent, _summary_result = dispatch_pending_summary(
                _pending_summary, summary_sent, broadcast)
            if _summary_result == BROADCAST_DISPATCHED:
                log('Session summary dispatched (from pending): %d laps' %
                    _summary_snapshot.get('total_laps', 0))
                if _summary_snapshot.get('is_race'):
                    _rr_best = _summary_snapshot.get('best_lap')
                    _rr_avg = _summary_snapshot.get('avg_lap')
                    log('===== RACE RESULT ===== '
                        + 'track=' + str(_summary_snapshot.get('track'))
                        + ' finish_pos(class)=' + str(_summary_snapshot.get('finish_pos'))
                        + ' laps=' + str(_summary_snapshot.get('total_laps'))
                        + ' best=' + str(_rr_best)
                        + ' avg=' + str(_rr_avg)
                        + ' pace_first_half=' + str(_summary_snapshot.get('pace_first_half'))
                        + ' pace_last_half=' + str(_summary_snapshot.get('pace_last_half'))
                        + ' incidents=' + str(_summary_snapshot.get('incidents'))
                        + ' ======================')
                checkered_pending = False

        if driver_state != prev_driver_state:
            broadcast({'type': 'driver_state', 'state': driver_state})
            # ガレージから復帰＝新しいスティント開始（耐久レースのドライバー交代・給油の可能性が高い）。
            #   古いスティントの燃料消費履歴（fuel_per_lap_hist）を持ち越すと、交代直後に「あと何周」を
            #   聞かれた時、前任ドライバーの消費率×今のスティントの残燃料で計算してしまい数字が破綻する
            #   （2026-07-11の耐久レースログで実際に発生：交代直後に燃料0/聞き返しが起きた）。
            #   ここでリセットすれば、以後はこのスティントの実測だけで再計算が始まる
            #   （clean_laps_sampledが2-3周の時点でも平均は出るので、5周貯まるのを待たず答えられる）。
            # 燃料履歴等の本人スティントresetは、上のdriver_activity ACTIVE復帰で一元実行する。
            # 単純なgarage→pitは交代先ドライバーでも観測されるため、ここではresetしない。
            # ★v3 Codex P0-2：garage 単独では Practice/Qualify の終了証拠にならない。
            #   HANDOFF/INACTIVE で summary を出さない。ここでは payload の準備のみを
            #   別ブロック（下記 session_end_confirmed 判定）に移す。
            #   ドライバー交代の garage 遷移では summary_sent は立てない。
            log('driver state -> ' + driver_state)
            prev_driver_state = driver_state

        lfTemp      = reader.read_float('LFtempCM')
        rfTemp      = reader.read_float('RFtempCM')
        lrTemp      = reader.read_float('LRtempCM')
        rrTemp      = reader.read_float('RRtempCM')

        # ── 気象データ（八木さん実走で「路面温度データ来てない」が判明→追加） ──
        # iRacing SDKは摂氏で返す。ドライバーは華氏派も多いが、まず数字を渡してAI側でどちら派にも対応。
        # None判定はvalue is not None で厳密に（0℃も有効値なので truthy判定はダメ）。
        track_temp_c = reader.read_float('TrackTempCrew')   # 路面温度（クルーが報告する路面表面温度・耐久で刻々変わる主要変数）
        if track_temp_c is None:
            track_temp_c = reader.read_float('TrackTemp')   # フォールバック（TrackTempCrewが無い/Noneのセッション用）
        air_temp_c   = reader.read_float('AirTemp')         # 気温
        rel_humidity = reader.read_float('RelativeHumidity') # 湿度 0..1
        track_wet    = reader.read_float('TrackWetness')     # 路面ウェット度 0..1(乾) - iRacing 2024+
        weather = {
            'track_temp_c': round(track_temp_c, 1) if track_temp_c is not None else None,
            'air_temp_c':   round(air_temp_c, 1)   if air_temp_c is not None   else None,
            'humidity':     round(rel_humidity * 100, 0) if rel_humidity is not None else None,
            'track_wetness': round(track_wet, 2) if track_wet is not None else None,
        }

        # ── コーナー単位サイドバイサイド検知（新規・2026-07-14 Yuji設計）──
        # 舵角(SteeringWheelAngle)でコーナー進入/脱出を検知し、その間だけiRacing公式スポッター値
        # (CarLeftRight)を見て「隣に車がいるか」を判定する。左右の物理位置はiRacing自身が計算済みの
        # 値をそのまま使う(自前で推定する必要なし・CarLeftRight: 0=off 1=clear 2=左 3=右 4=両側 5=左2台 6=右2台)。
        # ヒステリシスで閾値ギリギリのふらつきによる誤検知/連続発火を防ぐ(3サンプル連続で判定)。
        steering_angle = reader.read_float('SteeringWheelAngle')
        car_left_right = reader.read_int('CarLeftRight')
        brake_val = reader.read_float('Brake')

        # ── 発話「間合い」窓の判定（Version A・毎サイクル）──
        # ほぼ直進(舵角小)かつブレーキ踏んでない＝プロアクティブ無線を"開始"して良い窓。
        # 保留があれば窓が開いた瞬間に送る（flush）。安全直結はemit_radioでゲート無視。
        _steer_abs = abs(steering_angle) if steering_angle is not None else 0.0
        _brake_now = brake_val if brake_val is not None else 0.0
        _speech_controls_known = steering_angle is not None and brake_val is not None
        speak_window_ok = (
            _speech_controls_known
            and (_steer_abs < SPEAK_STEER_RAD)
            and (_brake_now < SPEAK_BRAKE_TH))
        _speech_speed = reader.read_float('Speed')
        # グリッド停止・停止中の会話をコーナー用安全窓で長時間保留しない。
        # 約18km/h未満は運転負荷が低く、通常会話を即時に返してよい。
        # Speed欠損を「停止」と解釈してfail-openしない。走行状態ならゲートを維持し、
        # 操舵/ブレーキも欠損していればwindow_ok=falseとして安全無線以外を保留する。
        _speech_gate_active = (
            driver_state == 'track'
            and (_speech_speed is None or _speech_speed >= 5.0))
        _set_speak_gate(speak_window_ok, _speech_gate_active)
        flush_radio()
        if steering_angle is not None and is_race_session and not in_start_rush:
            _sa = abs(steering_angle)
            if _sa > CORNER_ENTRY_RAD:
                corner_over_count += 1
                corner_under_count = 0
            elif _sa < CORNER_EXIT_RAD:
                corner_under_count += 1
                corner_over_count = 0
            else:
                corner_over_count = 0
                corner_under_count = 0

            # ⑤ ラグ対策：進入は即(1サンプル)で確定する。追い抜きはコーナー手前から始まり、以前は
            # 「舵角が3サンプル(0.3秒)乗るまで待つ」せいで相手が1/4前に出てからのコールになっていた。
            # 脱出はヒステリシスで3サンプル継続（コーナー中の一瞬の戻し舵での誤脱出を防ぐ）。
            if not in_corner and corner_over_count >= 1:
                in_corner = True
                corner_over_count = 0
            elif in_corner and corner_under_count >= 3:
                in_corner = False
                corner_under_count = 0

            # ⑤ 「サイドカー通知ゾーン」＝コーナー中 or 強めのブレーキ中。追い抜きはブレーキング勝負で
            # 始まり、舵角が乗る前にCarLeftRight(公式スポッター)は既に隣を検知している。舵角ロックを
            # 待たずブレーキ検知で前倒しすることで「相手が並ぶ前」にコールする。ゾーン立ち上がりで再武装。
            braking = brake_val is not None and brake_val > 0.35
            in_side_zone = in_corner or braking
            if in_side_zone and not side_zone_active:
                side_zone_active = True
                corner_sides_announced = set()  # 新しいゾーン＝再武装
            elif not in_side_zone and side_zone_active:
                side_zone_active = False

            _now3 = time.time()
            if in_side_zone and car_left_right is not None and car_left_right >= 2:
                _side = {2: 'left', 5: 'left', 3: 'right', 6: 'right', 4: 'both'}.get(car_left_right)
                if _side and _side not in corner_sides_announced:
                    corner_sides_announced.add(_side)
                    if True:  # サイドコールは安全直結＝短めのクールダウン。側ごとにdedup済み。
                        _side_msg = {'left': 'Car left.', 'right': 'Car right.', 'both': 'Cars both sides.'}[_side]
                        broadcast({'type': 'radio', 'trigger': 'side_by_side', 'side': _side, 'message': _side_msg})
                        last_battle_global = _now3
            # ストレート(ゾーン外)で3台以上並走の検知。CarLeftRight=4(両側)/5/6(片側2台)を代用
            # (自分+両側1台ずつ、または自分+片側2台＝どちらも計3台)。2台までは自分で見えるのでスルー。
            elif not in_side_zone and car_left_right in (4, 5, 6):
                if _now3 - straight_sbs_warned > 20:
                    broadcast({'type': 'radio', 'trigger': 'multi_car_straight', 'message': 'Three wide. Watch the space.'})
                    straight_sbs_warned = _now3
                    last_battle_global = _now3

        # ── タイヤ詳細（4輪×内中外温度＋摩耗）と損傷代理(修理所要秒) ──
        # 項目7：「右フロント垂れてる」「損傷は？」に実データで答えるため。聞かれた時だけ使う。
        def _tire(corner):
            # 温度[内,中,外]と摩耗残%[内,中,外]。%は0-1で来るので100倍。
            t = [reader.read_float(corner+'tempCL'), reader.read_float(corner+'tempCM'), reader.read_float(corner+'tempCR')]
            w = [reader.read_float(corner+'wearL'), reader.read_float(corner+'wearM'), reader.read_float(corner+'wearR')]
            # ★2026-07-16：iRacingは走行中はタイヤ温度を出さず、内中外すべて完全同一のデフォルト値
            #   (≈39.4)を返す。本物はピット入庫時のみで、必ず内≠中≠外のグラデーションを持つ。
            #   3点が完全一致＝デフォルト＝「未取得」とみなし温度はNoneにする（39.4の捏造報告を根絶）。
            if t[0] is not None and t[0] == t[1] == t[2]:
                t = [None, None, None]
            t = [round(x,1) if x is not None else None for x in t]
            w = [round(x*100,1) if x is not None else None for x in w]
            return {'t': t, 'w': w}
        tires = {'lf': _tire('LF'), 'rf': _tire('RF'), 'lr': _tire('LR'), 'rr': _tire('RR')}
        repair_mand = reader.read_float('PitRepairLeft')      # 義務修理の残り秒（>0=要修理の損傷あり）
        repair_opt  = reader.read_float('PitOptRepairLeft')   # 任意修理の残り秒
        damage_s = round((repair_mand or 0) + (repair_opt or 0), 1)

        # ── 1位のペース追跡（タイムサーティン耐久レースの終了予測用・2026-07-12 Yujiと設計合意） ──
        # 時間制レース（3時間耐久等）は、1位が残り時間内にあと何周走ってチェッカーを受けるかで
        # 初めて最終周回数が決まる。自分がピット中で戦略判断している時こそ知りたい数字なので、
        # 自分のonTrack状態に関係なく毎周期更新する（下のfuel_strategy計算で使う）。
        car_positions = reader.read_int_array('CarIdxPosition', 64)
        car_laps_all  = reader.read_int_array('CarIdxLap', 64)
        car_dist_all = reader.read_float_array('CarIdxLapDistPct', 64)
        car_on_pitroad_all = reader.read_int_array('CarIdxOnPitRoad', 64)
        car_surface_all = reader.read_int_array('CarIdxTrackSurface', 64)
        # Final Lap authorityは総合順位1位のみ。クラス順位や
        # max(CarIdxLap)フォールバックを混ぜると時間制混走で1周早くなる。
        overall_leader_idx = None
        if car_positions and car_laps_all:
            for _pidx, _ppos in enumerate(car_positions):
                if (_ppos == 1 and _pidx < len(car_laps_all)
                        and car_laps_all[_pidx] is not None
                        and car_laps_all[_pidx] > 0):
                    overall_leader_idx = _pidx
                    break
        # ★2026-07-19 リーダー検出の堅牢化：位置1が"幽霊"(CarIdxLap<=0=コース上に居ない)を指すことがある
        #   (Interlagos実走でleader_lap=-1が連発)。位置1でも周回が有効な車を優先し、ダメなら
        #   「コース上で最も進んでる車(max CarIdxLap)」を実質リーダーとして採用してNoneを避ける。
        leader_idx = None
        if car_positions:
            for _pidx, _ppos in enumerate(car_positions):
                if _ppos == 1 and car_laps_all and _pidx < len(car_laps_all) and car_laps_all[_pidx] is not None and car_laps_all[_pidx] > 0:
                    leader_idx = _pidx
                    break
            if leader_idx is None:   # 位置1が無効→コース上で最も周回が進んだ車を実質リーダーに
                for _pidx, _ppos in enumerate(car_positions):
                    if _ppos == 1:
                        leader_idx = _pidx   # 診断用に位置1のindexは拾っておく（leader_lapは下で無効化される）
                        break
                if car_laps_all:
                    _best_lap, _best_idx = 0, None
                    for _ci, _cl in enumerate(car_laps_all):
                        if _cl is not None and _cl > _best_lap:
                            _best_lap, _best_idx = _cl, _ci
                    if _best_idx is not None:
                        leader_idx = _best_idx
        leader_lap = None
        if leader_idx is not None and car_laps_all and leader_idx < len(car_laps_all):
            _ll = car_laps_all[leader_idx]
            # ★2026-07-19 leader_lap=-1根絶：CarIdxLapが-1＝その車はコース上に居ない(ペースカー/未接続/ガレージ)。
            #   位置1がそういう"幽霊"を指すと leader_lap=-1 が残り周回推定を全部0に毒す(Interlagos実走で発覚)。
            #   0以下は無効としてNoneのままにし、下でown-paceフォールバックへ落とす。
            if _ll is not None and _ll > 0:
                leader_lap = _ll
            else:
                log("LEADER DIAG: pos1 idx=%s but CarIdxLap=%s (幽霊/ペースカー疑い) -> leader_lap無効化" % (leader_idx, _ll))
        if leader_idx is not None:
            _leader_llt = reader.read_float_array('CarIdxLastLapTime', 64)
            if _leader_llt and leader_idx < len(_leader_llt):
                _llt = _leader_llt[leader_idx]
                # 20〜600秒の妥当範囲のみ・同じ値の重複積み上げ防止（他の履歴と同じ異常値対策）
                if _llt and 20 < _llt < 600 and _llt != leader_last_laptime_seen:
                    leader_lap_time_hist.append(_llt)
                    if len(leader_lap_time_hist) > 5:
                        leader_lap_time_hist.pop(0)
                    leader_last_laptime_seen = _llt

        # ── 診断ログ：データが実際に読めているか5秒ごとに表示 ──
        debug_counter += 1
        if debug_counter >= 50:
            debug_counter = 0
            spd = reader.read_float('Speed')
            # ★2026-07-12追加（耐久データログ）：OnTrack:Falseのまま実は走行中だった謎の固着
            #   （八木さんの耐久ログで発覚・約56分間Speed/Pos/LapTimeは動いてるのにOnTrack/Lapだけ
            #   固着）を次回再現時に切り分けられるよう、生のOnPit/SessionState/driver_state/燃料も出す。
            log("DATA CHECK -> Lap:" + str(lap) + " Pos:" + str(pos) +
                " LastLap:" + str(lapTime) + " Speed:" + str(round(spd,1) if spd else None) +
                " OnTrack:" + str(onTrack) + " OnPit:" + str(onPit) +
                " SessState:" + str(cur_ss) + " DriverState:" + str(driver_state) +
                " Fuel:" + str(round(fuel,1) if fuel is not None else None) +
                " CarIdx:" + str(player_car_idx) +   # 担当車の把握確認用
                " gapAhead:" + str(nearest_ahead_gap) + " gapBehind:" + str(nearest_behind_gap) +
                " TrackT:" + str(track_temp_c) + " AirT:" + str(air_temp_c) +   # 天候読み取り確認用
                # ★2026-07-16追加：タイヤ温度誤読(Yuji/まーぼー指摘)の切り分け。carcass温度(CM)が周回で
                #   上がるか毎周期ログ→「固着なら本当のバグ」「上昇するならカーカス物理で正常(表面と別物)」を確定させる。
                " TireCM(LF/RF/LR/RR):" + str(lfTemp) + "/" + str(rfTemp) + "/" + str(lrTemp) + "/" + str(rrTemp))

            # ★2026-07-16診断：走行中に「temp」を含む全変数を実値付きで吐く。tempCM(=39.4)が何で、
            #   接地面の70-85℃を示す変数がどれかを推測ゼロで特定するため（Yujiの正しい指摘の裏取り）。
            #   走行中のみ・DATA CHECKと同じ5秒間隔。正解変数が判明したら削除する。
            if onTrack:
                try:
                    tv = reader.dump_temp_vars()
                    if tv:
                        log("TEMP VARS -> " + " ".join(k + "=" + str(v) for k, v in tv.items()))
                except Exception as _e:
                    log("TEMP VARS dump error: " + str(_e))


        # ── ラップ完了検知：LapLastLapTime の「値が変わった瞬間」で発火 ──
        # 【重要】Lapカウンター増加で発火すると、iRacingのLapLastLapTime更新が
        #   1tick遅れるため「1周前のタイムを1周遅れて」報告する旧バグが出る。
        #   LapLastLapTime が新しい有効値に変わった瞬間なら、それが今完了したラップ＝ズレも遅延もゼロ。
        lap_time_changed = (
            lapTime is not None and lapTime > 0 and
            (last_lap_time is None or abs(lapTime - last_lap_time) > 0.001)
        )
        prev_current_lap = currentLap  # 互換性のため残す（使用しない）

        # ── セクター計測（走行中は黙る・ラップ完了時にデータのみ送信）──
        if sector_bounds and onTrack:
            try:
                dist = reader.read_float('LapDistPct')
                stime = reader.read_double('SessionTime')
                if dist is not None and stime is not None and dist >= 0:
                    # 現在のセクター番号（dist以下で最大の境界のindex）
                    idx = 0
                    for i, b in enumerate(sector_bounds):
                        if dist >= b:
                            idx = i
                    if cur_sector is None:
                        cur_sector = idx
                        sector_entry_time = stime
                    elif idx != cur_sector:
                        st = stime - sector_entry_time if sector_entry_time is not None else 0
                        if 0 < st < 600:
                            while len(lap_sector_times) <= cur_sector:
                                lap_sector_times.append(None)
                            lap_sector_times[cur_sector] = st
                        sector_entry_time = stime
                        # スタート地点に戻った（idx < cur_sector）= ラップ完了 → データ送信
                        if idx < cur_sector and lap_sector_times:
                            secs = []
                            for i, t_ in enumerate(lap_sector_times):
                                if t_ is None:
                                    continue
                                pb = best_sectors[i] if i < len(best_sectors) else None
                                delta = round(t_ - pb, 2) if pb else 0.0
                                is_best = (pb is None or t_ < pb)
                                if is_best and i < len(best_sectors):
                                    best_sectors[i] = t_
                                secs.append({'sector': i + 1, 'time': round(t_, 2),
                                             'delta': delta, 'best': is_best})
                            if secs:
                                broadcast({'type': 'lap_sectors', 'sectors': secs})
                            lap_sector_times = []
                        cur_sector = idx
            except Exception:
                pass

        # ── ラップタイム処理（LapLastLapTimeの値変化＝ライン通過直後に即発火）──
        # スタートライン通過で上がったタイムは、コースに関係なく即座にそのまま読み上げる。
        # （最初の1本もアウトラップ扱いで握りつぶさない。1周目はfirst_lap=Baselineとしてコール）
        # ※onTrack必須：ガレージ/グリッド/牽引中(OnTrack:False)のゴミラップ値を弾く。
        # ── 燃料to-フィニッシュ戦略計算（ラップ完了ごとに更新）──
        # 直近5周の平均消費量から、残り周回を走り切れるかを算出。数値は捏造せずここで計算した
        # 実測値のみをClaudeへ渡す(prompts.jsのliveNote経由)。
        if lap_time_changed and onTrack:
            if fuel is not None:
                if fuel_at_lap_start is not None:
                    used = fuel_at_lap_start - fuel
                    # アウト/インラップ(ピット通過周)はピットレーン低速でクリーンラップより消費が
                    # 少なく、平均を過小評価する(2026/7/7実走で2.5L誤表示・実3.8Lの主因)。除外する。
                    if 0 < used < 20 and not pit_this_lap:
                        fuel_per_lap_hist.append(used)
                        if len(fuel_per_lap_hist) > 5:
                            fuel_per_lap_hist.pop(0)
                fuel_at_lap_start = fuel
            pit_this_lap = False  # 次の周の判定用にリセット

            # ⚠️2026/7/5判明バグ：ラップ切り替わり直後の瞬間的なlapTime単発値をそのまま使うと、
            # 稀に異常に小さい値を拾って「20分で78周」のような物理的にありえない残り周回数を
            # 算出してしまう(Yuji実走IMSAテストで発覚・致命的)。妥当な範囲(20秒〜600秒)のラップ
            # タイムだけ履歴に積み、直近3周の平均を使うことで単発の異常値に引きずられなくする。
            if lapTime and 20 < lapTime < 600:
                lap_time_hist.append(lapTime)
                if len(lap_time_hist) > 5:
                    lap_time_hist.pop(0)

            # ── Final Lap / Last 5-3-1（燃料履歴とは独立）────────────────
            # 時間制マルチクラスでは総合首位のチェッカー時刻と、自車が次に
            # S/Fを通る時刻を壁時計上で比較する。周回番号の差し引きや
            # ceil(timeRemain / own pace) は、ラップダウン車を1周早くするため
            # Final Lapの根拠には使わない。
            _laps_total_ok = (
                lap is not None and lapsTot is not None
                and 0 < lapsTot < 3000 and lapsTot > lap + 1)
            _is_time_race = bool(
                is_race_session and not _laps_total_ok
                and timeRemain is not None and 0 <= timeRemain < 100000)
            _legacy_laps_remaining = (
                max(0, lapsTot - lap) if _laps_total_ok else None)

            _driver_dist = None
            _leader_dist = None
            if (car_dist_all and 0 <= player_car_idx < len(car_dist_all)):
                _driver_dist = car_dist_all[player_car_idx]
            if (car_dist_all and overall_leader_idx is not None
                    and overall_leader_idx < len(car_dist_all)):
                _leader_dist = car_dist_all[overall_leader_idx]

            _leader_on_pit = True
            if overall_leader_idx is not None:
                _leader_pit_flag = (
                    bool(car_on_pitroad_all[overall_leader_idx])
                    if car_on_pitroad_all
                    and overall_leader_idx < len(car_on_pitroad_all)
                    else False)
                _leader_surface = (
                    car_surface_all[overall_leader_idx]
                    if car_surface_all
                    and overall_leader_idx < len(car_surface_all)
                    else None)
                # TrackSurface 2=ApproachingPits, 3=OnTrack.  Missing surface
                # is not authoritative enough for a Final Lap call.
                _leader_on_pit = (
                    _leader_pit_flag or _leader_surface not in (2, 3))

            _driver_avg_lap = (
                sum(lap_time_hist) / len(lap_time_hist)
                if lap_time_hist else None)
            _leader_avg_lap = (
                sum(leader_lap_time_hist) / len(leader_lap_time_hist)
                if leader_lap_time_hist else None)
            _timed_final_eval = final_lap.evaluate_final_lap_for_driver(
                driver_lap_dist_pct=_driver_dist,
                leader_lap_dist_pct=_leader_dist,
                driver_avg_lap_s=_driver_avg_lap,
                leader_avg_lap_s=_leader_avg_lap,
                session_time_remain_s=timeRemain,
                session_laps_remain_for_leader=reader.read_int('SessionLapsRemain'),
                is_time_race=_is_time_race,
                lifecycle_state=lifecycle_state,
                final_lap_already_announced=bool(
                    final_lap_notice_sent.get(1, False)),
                is_driver_overall_leader=(
                    overall_leader_idx is not None
                    and player_car_idx == overall_leader_idx),
                driver_pace_sample_count=len(lap_time_hist),
                leader_pace_sample_count=len(leader_lap_time_hist),
                driver_in_pit_or_garage=(
                    bool(onPit) or driver_state == 'garage'),
                leader_in_pit_or_garage=_leader_on_pit,
                driver_lap=lap,
                leader_lap=leader_lap)

            _milestone_laps = final_lap.select_milestone_laps(
                _is_time_race, _timed_final_eval, _legacy_laps_remaining)
            _milestone, _crossed = final_lap.select_milestone(
                _milestone_laps, lifecycle_state, final_lap_notice_sent)
            if _milestone is not None:
                _msg = ('Final lap.' if _milestone == 1
                        else '%d laps to go.' % _milestone)
                _final_result = broadcast({
                    'type': 'radio',
                    'trigger': 'final_lap_notice',
                    'laps_remaining': _milestone,
                    'pos': pos,
                    'message': _msg,
                })
                final_lap_notice_sent = (
                    final_lap.commit_milestone_after_dispatch(
                        final_lap_notice_sent, _crossed, _final_result))
            if _is_time_race:
                log("FINAL LAP DIAG lap=%s leaderIdx=%s driverDist=%s leaderDist=%s "
                    "driverAvg=%s leaderAvg=%s timeRem=%s crossings=%s reason=%s confidence=%s"
                    % (
                        lap, overall_leader_idx, _driver_dist, _leader_dist,
                        round(_driver_avg_lap, 2)
                        if _driver_avg_lap is not None else None,
                        round(_leader_avg_lap, 2)
                        if _leader_avg_lap is not None else None,
                        round(timeRemain, 2)
                        if timeRemain is not None else None,
                        _timed_final_eval.get(
                            'estimated_crossings_to_finish'),
                        _timed_final_eval.get('reason'),
                        _timed_final_eval.get('confidence')))

            if fuel_per_lap_hist and fuel is not None:
                avg_fuel_lap = sum(fuel_per_lap_hist) / len(fuel_per_lap_hist)
                # ── ①消費量は「クリーンラップ1本でも」即Lunaへ送る（短いレース対応・2-4周で読めるように）──
                # レース長(残り周回)が分からなくても、燃料残量÷消費量で「あと何周走れるか」は出せる。
                # これを常に持たせることで、練習/テストドライブや序盤でも燃料を把握できる（捏造防止）。
                laps_of_fuel_left = round(fuel / avg_fuel_lap, 1) if avg_fuel_lap > 0 else None
                fuel_strategy = {
                    'avg_fuel_per_lap': round(avg_fuel_lap, 2),
                    'laps_of_fuel_left': laps_of_fuel_left,   # 現燃料であと何周走れるか（レース長不要）
                    'clean_laps_sampled': len(fuel_per_lap_hist),  # 何周分の実測から出したか（信頼度の目安）
                }
                # ── ② to-finish authorityはFinal Lap Unitと完全共有 ──
                # 時間制でモデルが不成立なら _milestone_laps=None のまま。
                # own-paceや周回番号差へ戻して「分からない」を数字に変換しない。
                _fuel_eval = fuel_strategy_mod.evaluate_fuel_to_finish(
                    fuel_level_l=fuel,
                    avg_fuel_per_lap_l=avg_fuel_lap,
                    estimated_crossings_to_finish=_milestone_laps,
                    clean_laps_sampled=len(fuel_per_lap_hist),
                    lifecycle_state=lifecycle_state,
                    previous_band=fuel_warning_band)
                if _fuel_eval.get('available'):
                    fuel_strategy.update({
                        'estimated_crossings_to_finish': _milestone_laps,
                        'laps_remaining_est': _milestone_laps,
                        'finish_basis': (
                            'overall_leader_clock'
                            if _is_time_race else 'laps_total'),
                        'required_fuel_l': _fuel_eval['required_fuel_l'],
                        'fuel_needed': _fuel_eval['required_fuel_l'],
                        'margin_l': _fuel_eval['margin_l'],
                        'reserve_l': _fuel_eval['reserve_l'],
                        'fuel_band': _fuel_eval['band'],
                        'pit_required': (
                            _fuel_eval['band']
                            == fuel_strategy_mod.CRITICAL),
                    })

                _fuel_dispatch_result = None
                if _fuel_eval.get('should_warn') and not onPit:
                    _fuel_band = _fuel_eval['band']
                    _fuel_margin = _fuel_eval['margin_l']
                    _fuel_message = (
                        'Fuel margin is under half a liter. Save fuel now.'
                        if _fuel_band == fuel_strategy_mod.TIGHT
                        else 'Fuel is short by %.1f liters. We need the pit.'
                        % abs(_fuel_margin))
                    _fuel_dispatch_result = broadcast({
                        'type': 'radio',
                        'trigger': 'fuel_strategy_warning',
                        'fuel_band': _fuel_band,
                        'margin_l': _fuel_margin,
                        'required_fuel_l': _fuel_eval['required_fuel_l'],
                        'estimated_crossings_to_finish': _milestone_laps,
                        'message': _fuel_message,
                    })
                elif (_fuel_eval.get('transition') == 'critical_to_safe'
                      and not onPit):
                    # 給油後に「不足」が解消した事実を一度だけ返す。
                    # 計算成功を黙ったままにせず、通常の戦略情報(P3)として安全窓で発話する。
                    _fuel_dispatch_result = broadcast({
                        'type': 'radio',
                        'trigger': 'fuel_strategy_safe',
                        'margin_l': _fuel_eval['margin_l'],
                        'required_fuel_l': _fuel_eval['required_fuel_l'],
                        'estimated_crossings_to_finish': _milestone_laps,
                        'message': 'Fuel is good. %.1f liters margin to finish.'
                                   % _fuel_eval['margin_l'],
                    })
                fuel_warning_band = (
                    fuel_strategy_mod.commit_band_after_dispatch(
                        fuel_warning_band, _fuel_eval,
                        _fuel_dispatch_result))
                fuel_strategy_warned = (
                    fuel_warning_band
                    in (fuel_strategy_mod.TIGHT,
                        fuel_strategy_mod.CRITICAL))
                log("FUEL BAND DIAG lap=%s fuel=%.2f avg=%.3f crossings=%s "
                    "required=%s marginL=%s band=%s prev=%s transition=%s "
                    "warn=%s dispatch=%s reason=%s clean=%s"
                    % (
                        lap, fuel, avg_fuel_lap, _milestone_laps,
                        _fuel_eval.get('required_fuel_l'),
                        _fuel_eval.get('margin_l'),
                        _fuel_eval.get('band'),
                        _fuel_eval.get('previous_band'),
                        _fuel_eval.get('transition'),
                        _fuel_eval.get('should_warn'),
                        _fuel_dispatch_result,
                        _fuel_eval.get('reason'),
                        len(fuel_per_lap_hist)))

        if lap_time_changed and onTrack:
            t = fmt_radio(lapTime)
            if t:
                is_session_best = (session_best is None or lapTime < session_best)
                is_personal_best = (personal_best is None or lapTime < personal_best)

                if is_personal_best:
                    if personal_best is not None:
                        diff = personal_best - lapTime
                        # ★★2026-07-20 判断層→確定コールへ（Yuji「自己ベストを出した時にコールが
                        #   なかったのが、ちょっとテンションが上がらなかった」）。
                        #   判断層に預けた項目は繰り返し沈黙する（ディレクターは通過しているのに発話0）。
                        #   ベスト更新は"祝う瞬間"であり、黙る判断を許す種類のものではない。
                        #   機械音を避けるため言い回しは複数から回す。
                        _bl = ['Personal best. ', 'That\'s your best. ', 'New best. ', 'Best of the day. ']
                        broadcast({'type': 'radio', 'trigger': 'personal_best',
                            'time': t, 'diff': round(diff, 2),
                            'message': _bl[int(time.time()) % len(_bl)] + t + '.'})
                    else:
                        broadcast({'type': 'radio', 'trigger': 'first_lap', 'time': t,
                            'message': t + '. Baseline lap.'})
                    personal_best = lapTime
                    session_best = lapTime

                elif is_session_best:
                    broadcast({'type': 'radio', 'trigger': 'session_best', 'time': t,
                        'message': 'Session best. ' + t + '.'})
                    session_best = lapTime

                else:
                    diff = lapTime - session_best
                    # ── ペース推移の生データ蓄積（AI文脈判断用・直近8周）──
                    lap_delta_hist.append(round(diff, 2))
                    if len(lap_delta_hist) > 8:
                        lap_delta_hist.pop(0)

                    # ── ペース向上パターン（2026/7/5追加・Yuji発案）──
                    # 直近3周平均 vs その前3周平均で、はっきり速くなってる時だけ声をかける対象にする
                    # （1周だけの偶然でなく、本当に上げてきてるかを均して判定）。
                    # ここも固定の褒め言葉でなく、文脈込みでClaudeに「褒める価値があるか」判断させる。
                    # ★★2026-07-19 タイム読み上げの全面再設計（Yuji・F1TVを見ての判断）★★
                    #   旧：0.3〜1.0秒落ちの"全周"で lap_time が発火＝毎周かならず何か喋る機械。
                    #       まーぼー(Indy)「毎回言われると結構うるさい」／Yuji「F1でも読み上げは要らない」。
                    #   新：毎周の読み上げ(lap_time/lap_slow/lap_consistent)を全廃し、
                    #       ①3周平均 vs その前3周平均で"本物の傾向"が出た時だけ pace_check(LLM判断)
                    #       ②単発の大きなタイムロス(ミス/トラブル)は"尋ねる"側に回る
                    #       ③ベスト更新は言う(上の best_lap)
                    #   → 「読み上げ機」から「気づいて聞いてくるエンジニア」へ。
                    _paced = False
                    if len(lap_delta_hist) >= 6 and (lap - pace_check_last_lap) >= 3:
                        recent3 = sum(lap_delta_hist[-3:]) / 3
                        prev3 = sum(lap_delta_hist[-6:-3]) / 3
                        _dir = None
                        if prev3 - recent3 >= 0.3:      # 3周平均で0.3秒以上速い＝本物の向上
                            _dir = 'improving'
                        elif recent3 - prev3 >= 0.3:    # 3周平均で0.3秒以上遅い＝本物の劣化
                            _dir = 'degrading'          # (旧「2周連続スロー」より誤検知に強い)
                        if _dir:
                            _paced = True
                            pace_check_last_lap = lap
                            broadcast({'type': 'pace_check', 'direction': _dir,
                                'recent_deltas': lap_delta_hist[:],
                                'pos': pos, 'class_pos': class_pos,
                                'gap_ahead': round(nearest_ahead_gap, 2) if nearest_ahead_gap is not None else None,
                                'gap_behind': round(nearest_behind_gap, 2) if nearest_behind_gap is not None else None,
                                'fuel_strategy': fuel_strategy,
                            })

                    # ②単発の大きなタイムロス＝ミスかトラブル。データで気づけるので"尋ねる"
                    #   （Yuji「ミスしたりタイムロスした際はデータ来てるんだよね？それ尋ねてもいい」）。
                    #   直近4周の平均より1.5秒以上落ちた1周だけを拾う（傾向劣化とは別物）。
                    if not _paced:
                        _prev = lap_delta_hist[:-1][-4:]
                        if _prev:
                            _typ = sum(_prev) / len(_prev)
                            if (diff - _typ) >= 1.5 and _judge_llm_gate('time_loss', judge_llm_call_times, time.time(), judge_llm_skip_log_last):
                                broadcast({'type': 'judge_call', 'kind': 'time_loss',
                                    'lost': round(diff - _typ, 1), 'time': t})

                last_lap_time = lapTime
                # ── セッションサマリー用にラップデータを積算 ──
                lap_record = {
                    'lap': lap,
                    'time': round(lapTime, 3),
                    'class_pos': class_pos,
                    'pb': is_personal_best,
                }
                if lap_sector_times:
                    lap_record['sectors'] = [round(s, 2) for s in lap_sector_times]
                # Team-car telemetry continues while another driver is in the
                # car. PITWALL supports the configured user only, so teammate
                # laps must not enter the user's summary/readiness evidence.
                if _driver_activity_local == driver_activity_mod.ACTIVE:
                    session_laps.append(lap_record)

                # ── チェッカー後、自分がこのラップ(S/Fライン通過)を終えた＝本当の完走タイミング ──
                # checkered_pendingは上で「セッション全体がチェッカーになった」時に立てたフラグ。
                # ここは自分のLapLastLapTimeが更新された瞬間＝自分が実際にS/Fラインを通過した瞬間なので、
                # リーダー基準でなく自分基準の完走判定になる。
                # ★v3 Codex P0-4：checkered 経路のインライン summary broadcast は削除。
                #   session_summary の pending 化＋再試行は上の共通ループ (B)(C) に統合。
                #   ここでは checkered_pending フラグが立ってればループが拾って送る。
                pass  # summary はループが処理

        # ── ローリングスタート中：前走車ギャップが7秒超なら5秒ごとにコール ──
        if in_formation and player_car_idx >= 0:
            car_est_times_roll = reader.read_float_array('CarIdxEstTime', 64)
            if car_est_times_roll and player_car_idx < len(car_est_times_roll):
                player_t = car_est_times_roll[player_car_idx]
                best_ahead = None  # 同クラスで最も近い前方車のギャップ
                # ★2026-07-21 Codex指示R2：同クラス判定はclass_map.evaluate_class_map経由でfail-closed。
                #   旧実装は car_class_map.get(idx2,-1) != player_class_id で、両者ともClassID不明(-1)の
                #   時に「同クラス」と誤判定する穴があった。
                _active_roll = set(i for i, et in enumerate(car_est_times_roll) if et and et > 0)
                _same_class_roll = class_map.evaluate_class_map(
                    _active_roll, player_car_idx, car_class_map)['same_class_car_idxs'] or set()
                for idx2, et2 in enumerate(car_est_times_roll):
                    if idx2 == player_car_idx or et2 <= 0:
                        continue
                    if idx2 not in _same_class_roll:
                        continue
                    d2 = et2 - player_t  # 前方はマイナス(est_timeが小さい)
                    if -30 < d2 < 0:    # 前方30秒以内
                        gap = abs(d2)
                        if best_ahead is None or gap < best_ahead:
                            best_ahead = gap
                now_r = time.time()
                if (best_ahead is not None and best_ahead > 7.0 and
                        now_r - rolling_gap_warned_time > 5.0):
                    broadcast({'type': 'radio', 'trigger': 'rolling_gap',
                        'gap': round(best_ahead, 1),
                        'message': 'Gap ' + str(round(best_ahead, 1)) + '. Reel them in.'})
                    rolling_gap_warned_time = now_r

        # ── インシデント検知（コースオフ/接触/クラッシュ） ──────────────
        if incidents is not None:
            if prev_incidents is not None and incidents > prev_incidents:
                delta = incidents - prev_incidents
                now = time.time()
                incident_times = [t for t in incident_times if now - t < 90]
                incident_times.append(now)
                recent = len(incident_times)
                if recent >= 3:
                    msg = random.choice([
                        'Too many incidents. Calm down. Forget position — just finish.',
                        'That is enough. Reset your head. Clean laps to the flag.',
                        'Stop the risks now. Bring this car home in one piece.'])
                    broadcast({'type': 'radio', 'trigger': 'incident', 'delta': delta, 'recent': recent,
                        'message': msg})
                elif delta >= 4:
                    # 大クラッシュ＝まず身体を気遣う「Are you OK?」を最優先で。ダイレクトドライブの
                    # 強力なモーターはクラッシュ時にハンドルを持っていき、手首の捻挫/怪我が実際に起きる。
                    # 順位やレース運びより先に、ドライバーの安否を確認するのが本物のエンジニア(Yuji方針)。
                    broadcast({'type': 'radio', 'trigger': 'crash_check', 'delta': delta, 'recent': recent,
                        'message': 'Are you okay? Any injury to your hands? Can the car still drive? If not, take the tow back and we will regroup from there.'})
                    # ★2026-07-24 post_contact_ok 監視開始（Yuji方針）：
                    #   5秒間の観察窓を開き、Speed>30km/h を維持できたら Pattern B（走行継続）と判定して
                    #   「アライメント影響ある？」の第二声を出す。途中で減速したら Pattern A（停止）と判定して黙る。
                    _pcs_now = reader.read_double('SessionTime')
                    if _pcs_now is not None:
                        post_contact_watch_start = _pcs_now
                        post_contact_speed_ok = True
                elif delta >= 2:
                    msg = random.choice([
                        'Watch it. Bring it back.',
                        'Spin. Collect yourself. We are okay.',
                        'Easy. Settle it down.'])
                    broadcast({'type': 'radio', 'trigger': 'incident', 'delta': delta, 'recent': recent,
                        'message': msg})
                # delta==1（コースオフ）は基本黙る。連発時のみ上のrecent>=3で拾う
            prev_incidents = incidents

        # ★2026-07-24 towing 完全削除（Yuji方針）──
        # 走行できてないのに Luna が「トーイング中」と話しかけるのは奇妙、かつ
        # 実観察で走行継続中でも tow_time が一瞬>0になり誤発話するケースが起きていた。
        # 牽引中はドライバー側から自然に会話が始まる（「あー、やっちゃった」）＝AIは黙る設計。
        # tow_active フラグと PlayerCarTowTime 読み取りごと廃止。post_contact_ok に責務移管。

        # ── post_contact_ok（2026-07-24 Yuji設計）──
        # crash_check 発火から5秒の観察窓。判定ロジックはevaluate_post_contact_watch()に切り出し済み
        # （単体テスト対応）。ここは本番の"読み取り→評価→broadcast"の配線のみ。
        if post_contact_watch_start is not None:
            _pcs_now = reader.read_double('SessionTime')
            _pcs_spd = reader.read_float('Speed')
            _pcs_fire, post_contact_watch_start, post_contact_speed_ok = evaluate_post_contact_watch(
                post_contact_watch_start, post_contact_speed_ok, _pcs_now, _pcs_spd)
            if _pcs_fire:
                broadcast({'type': 'radio', 'trigger': 'post_contact_ok',
                    'message': 'Still driving? Alignment or handling — any effect?'})

        # ── ダメージレポート（2026-07-12マーボー要望：損傷度合い・走行継続可否を知りたい）──
        # crash_checkは「大丈夫か・車は動くか」という安否確認の問いかけであって実データではない。
        # ここではdamage_s(=PitRepairLeft+PitOptRepairLeft、義務+任意修理の残り秒)の増分を見て、
        # 実際に損傷が発生した時だけ1回報告する。義務修理あり=要ピットの本物の損傷、
        # 義務修理なしで任意修理のみ=見た目だけの軽微な損傷、と区別して伝える。
        # ※IRSDKに「どのパーツが脱落したか」を示す変数は無いため、部品単位の特定はできない
        #   （修理所要秒からの重大度推定のみ）。
        if damage_s > prev_damage_s + 0.5:
            mandatory = (repair_mand or 0) > 0
            if mandatory:
                dmg_msg = ('Damage confirmed — mandatory repair, about ' +
                    str(round(repair_mand)) + ' seconds. Box next lap.')
            else:
                dmg_msg = 'If it does not affect performance, keep going. Watch the state, but let us avoid another incident.'
            broadcast({'type': 'radio', 'trigger': 'damage_report', 'mandatory': mandatory,
                'repair_mand': round(repair_mand or 0, 1), 'repair_opt': round(repair_opt or 0, 1),
                'message': dmg_msg})
        prev_damage_s = damage_s

        # Position change（クラス内順位ベース。レースセッション＆コース走行中のみ。
        #   グリッド整列中(OnTrack:False)は順位がシャッフルするので黙る）
        if is_race_session and onTrack and class_pos is not None and prev['class_pos'] is not None and class_pos != prev['class_pos']:
            gained = prev['class_pos'] - class_pos
            if gained > 0:
                _pu_msg = random.choice(['P' + str(class_pos) + '.', 'P' + str(class_pos) + ', good pass.',
                    'Position gained. P' + str(class_pos) + '.'])
                broadcast({'type': 'radio', 'trigger': 'position_up', 'pos': class_pos, 'message': _pu_msg})
            else:
                _pd_msg = random.choice(['P' + str(class_pos) + '. Lost one.', 'P' + str(class_pos) + '. He got you — still reachable.',
                    'Down to P' + str(class_pos) + '. You\'re fine, pace is there.'])
                broadcast({'type': 'radio', 'trigger': 'position_down', 'pos': class_pos, 'message': _pd_msg})

        # ★2026-07-20 順位コールの連発対策（実走で16秒に5回＝ピットアウト直後の順位激変）。
        #   ドライバーは前レースでも「そういうのはいらない」と明言。1周に1回までに制限し、
        #   ピット退出直後の順位が定まらない30秒は黙る。
        # Fuel warning
        # ※実際にトラック走行中＆燃料が有効な数値の時だけ警告する。
        #   ガレージ/ピット/セッション開始直後は燃料0やデータ未取得で誤発火するため除外。
        # ★2026-07-20 Yuji指摘「残り5Lでセーブと言われたが、周回数的に確実に持つ場面だった。
        #   燃料セーブのコールは本当に必要な時だけ」→ 残量の絶対値だけで鳴らすのをやめ、
        #   残り周回が分かっていて足りるなら黙る。残り周回が不明な時だけ従来通り"本当に危ない量"で鳴らす。
        _fuel_ok_to_finish = False
        try:
            _fs = fuel_strategy if isinstance(fuel_strategy, dict) else {}
            _rem = _fs.get('laps_remaining_est')
            _lft = _fs.get('laps_of_fuel_left')
            if _rem is not None and _lft is not None:
                _fuel_ok_to_finish = (_lft >= _rem)   # 完走できる見込み＝セーブを促す必要がない
        except Exception:
            pass
        if driver_state == 'track' and fuel is not None and 0.5 < fuel < 5 \
                and not _fuel_ok_to_finish \
                and (prev['fuel'] is None or prev['fuel'] >= 5):
            _fuel_margin_l = _fs.get('margin_l')
            _fuel_pit_required = bool(_fs.get('pit_required')) or (
                isinstance(_fuel_margin_l, (int, float)) and _fuel_margin_l < 0)
            broadcast({'type': 'radio', 'trigger': 'fuel_warning', 'fuel': round(fuel, 1),
                'pit_required': _fuel_pit_required,
                'margin_l': _fuel_margin_l,
                'message': (
                    'Fuel ' + str(round(fuel, 1)) + '. Box this lap.'
                    if _fuel_pit_required
                    else 'Fuel ' + str(round(fuel, 1)) + '. Save mode now.')})

        # Tyre temps: 自動警告は無効化（読んでる変数がカーカス温度で不正確。較正後に復活予定）
        # データ自体は将来デブリーフで参照可能にする

        # 旧'final_lap'トリガー（lap==lapsTot）は削除済み。
        # Final Lap / Last 5-3-1 は上の final_lap モジュールだけを真実源とする。

        # ── セッションサマリー：チェッカーは「見えた」だけ記録し、送信は自分の完走まで待つ ──
        # SessionState 5=Checkered/6=Cooldownはセッション全体で共有される値——リーダーがチェッカーを
        # 受けた瞬間、まだ走行中の自分も含めて全員が同時にこの状態になる(2026-07-05実走+2026-07-13
        # 再指摘・Yuji確認)。ここで即送信すると自分がまだ周回/半周残っていてもデブリーフに切り替わる。
        # フラグだけ立てて、実際の送信は下のlap_time_changedブロック（＝自分がS/Fラインを実際に
        # 通過した瞬間）まで待つ。レースセッションのみ対象（予選/練習は対象外＝上のガレージ帰還時の
        # 別ルートでサマリーのみ送信、デブリーフ誘導はis_raceフラグでクライアント側が判断する）。
        if is_race_session and cur_ss in (5, 6) and not summary_sent:
            checkered_pending = True

        # ── ⑥ ピットリミッター解除コール（新規・2026-07-14 Yuji要望）──────────────
        # ピットアウトでスピード制限解除ライン(=リミッターが切れる瞬間)に「リミッターオフ」を知らせる。
        # EngineWarningsのpitSpeedLimiterビット(0x10)がON→OFFに落ちた瞬間が実際の解除タイミングで、
        # OnPitRoad判定より正確。ビットが取れない環境でも下のピットアウト転移でフォールバック発火する。
        # ★2026-07-24 誤発火ガード：ボックス出発直後にリミッタービットが一瞬OFFになる誤検知
        #   （7/23実走 20:22:04: LapDistPct=0.0326・Speed=2.8m/s(10km/h)で「リミッターオフ」が誤発火）
        #   を防ぐため、Speed>8.33m/s(=30km/h)を必須条件にする。正常発火は約20m/s(72km/h)なので影響なし。
        engine_warnings = reader.read_int('EngineWarnings')
        limiter_on = bool(engine_warnings & 0x10) if engine_warnings is not None else False
        _spd_limit = reader.read_float('Speed')
        _spd_ok    = (_spd_limit is not None and _spd_limit > 8.33)   # 30 km/h ゲート
        if prev_limiter_on and not limiter_on and onTrack and not limiter_off_announced_stop and _spd_ok:
            broadcast({'type': 'radio', 'trigger': 'limiter_off',
                'message': 'Limiter off. Watch tyre temps and pick up the pace.'})
            limiter_off_announced_stop = True
        prev_limiter_on = limiter_on

        # Pit in/out
        # ★2026-07-27 Yuji実走：OnPitRoad=True は制限ライン通過後になるコースがある。
        # PlayerTrackSurface 3(track)→2(approaching pits) を先行通知に使う。
        # これはピット進入車だけに出るSDK境界なので、座標だけの30m判定のように毎周誤発火しない。
        # 2を通知しないコース/車両では、下のOnPitRoad遷移をフォールバックにする。
        _pit_surface_now = reader.read_int('PlayerTrackSurface')
        _pit_surface_prev = prev.get('_psurf')
        _spd_pit = reader.read_float('Speed')
        _pit_entry_speed_ok = (_spd_pit is not None and _spd_pit > 5.0)
        if (_pit_surface_prev == 3 and _pit_surface_now == 2
                and not onPit and not pit_entry_announced_stop and _pit_entry_speed_ok):
            broadcast({'type': 'radio', 'trigger': 'pit_entry',
                'message': 'Watch the limit line, limiter on.'})
            pit_entry_announced_stop = True
        elif (_pit_surface_prev == 2 and _pit_surface_now == 3 and not onPit):
            pit_entry_announced_stop = False  # 進入を中止した場合は次回に備えて再武装

        # ★2026-07-24 pit_entry 誤発火対策（Yuji方針）:
        #   (1) 従来 `not prev['onPit']` は None→True（起動時spawn）でも発火して "ピットインだな" 誤爆。
        #       `prev['onPit'] is False` に変更＝genuine False→True 遷移だけを許可。
        #   (2) ボックス出発直後の onPit=True 継続中に一瞬 False→True が起きる場合の保険で
        #       Speed>5m/s（≒18km/h以上）を"発話"の必須条件にする（7/23 Marboログ Speed=0.2 誤発火の根絶）。
        #       ★2026-07-24 Codex P1：Speedガードは"radio broadcast"だけに適用。
        #       状態更新（pit_enter_time / pit_enter_pos / limiter_off_announced_stop の再武装）は
        #       低速の正規ピット進入（ダメージで這うように入るケース等）でも必ず走らせる。
        #       これを忘れると limiter_off_announced_stopがTrueのまま次ストップに持ち越し＝リミッターオフ消失＋
        #       pit_lane_secが計測不能＝ピットタイミング学習も消える連鎖崩壊が起きる。
        #   (3) 発話は上のSDK接近境界で先行。ここは境界が取れない環境のフォールバックだけ。
        if onPit and prev['onPit'] is False:
            # 状態更新は無条件（低速の正規進入でも必ず走らせる）
            pit_enter_time = reader.read_double('SessionTime')   # 進入時刻を記録
            pit_enter_pos = class_pos
            limiter_off_announced_stop = False   # 新しいピットストップ＝リミッターオフ再武装
            # 先行通知済みなら重複させない。未通知環境のみここでフォールバック。
            if not pit_entry_announced_stop and _pit_entry_speed_ok:
                broadcast({'type': 'radio', 'trigger': 'pit_entry',
                    'message': 'Watch the limit line, limiter on.'})
                pit_entry_announced_stop = True

        if prev['onPit'] and not onPit and onTrack:
            # ── ピットレーン所要時間を実測（進入→退出のSessionTime差）──
            # 耐久のピットウィンドウ予測(復帰順位・トラフィック回避)の土台。1階記憶に残す。
            pit_lane_sec = None
            if pit_enter_time is not None:
                _now = reader.read_double('SessionTime')
                if _now is not None:
                    pit_lane_sec = round(_now - pit_enter_time, 1)
                pit_enter_time = None
            # ⑥ フォールバック：EngineWarningsのリミッタービットが未検知でこのストップでまだ鳴らして
            # いなければ、ピットレーン退出(OnPitRoad False)の瞬間に「リミッターオフ」を鳴らす。
            if not limiter_off_announced_stop:
                broadcast({'type': 'radio', 'trigger': 'limiter_off',
                    'message': 'Limiter off. Watch tyre temps and pick up the pace.'})
                limiter_off_announced_stop = True
            # 出口直後の二重コールは廃止。ここでは limiter_off だけを発話する。
            pit_entry_announced_stop = False
            if pit_lane_sec is not None and 5 < pit_lane_sec < 300:  # 妥当範囲のみ(誤検知除外)
                broadcast({'type': 'pit_timing', 'pit_lane_sec': pit_lane_sec,
                           'track': session_track, 'car_class': session_car_class,
                           'car_model': session_car_model,
                           'pos_in': pit_enter_pos, 'pos_out': class_pos})
                log('PIT timing: lane ' + str(pit_lane_sec) + 's  P' + str(pit_enter_pos) + '->P' + str(class_pos))

        # ── ピット秒読み診断 v2（2026-07-17）──
        # iRacing公式スポッター相当の「Your box」信号を出してるSDK変数を推測ゼロで特定するため、
        # ピット関連の全候補変数(PlayerTrackSurface/PlayerCarPitSvStatus/PitsOpen等)を実値付きでダンプ。
        # 値が変わった瞬間だけ吐く(前回のonPit条件で500行超の垂れ流し反省)。次のピット1回で正解確定。
        # ── ピット秒読み（ダート要望）★実装：iRacing公式スポッター相当を PlayerCarPitSvStatus で再現 ──
        # 診断ログ(20260717-1411)で決定的：PlayerCarPitSvStatus が 0→1 に変わる瞬間＝iRacing自身が
        # 「自分のボックスに完全停止＝サービス開始」と判定した瞬間。これが公式スポッターの「your box」信号。
        # 加えて PlayerTrackSurface: 2(接近中) → 1(ボックス位置) の遷移で「ボックス目前」も通知できる。
        try:
            _psurf   = reader.read_int('PlayerTrackSurface')
            _pss     = reader.read_int('PlayerCarPitSvStatus')
            _po      = reader.read_bool('PitsOpen')
            _ldp     = reader.read_float('LapDistPct')
            _spd_now = reader.read_float('Speed')
            _prev_psurf = prev.get('_psurf')
            _prev_pss   = prev.get('_pss')
            # ★★2026-07-20 ピットボックスまでの距離カウントダウン（Yuji要望）★★
            #   iRacingはボックス位置を直接くれないので、**自分のボックスを学習**する：
            #   最初の入庫で「到達した瞬間のLapDistPct」を記録し、次からそこまでの距離を数える。
            #   走るほど正確になる＝この製品の思想と同じ。Monzaのように短いピットでは
            #   間に合わない距離は自動的に飛ばされる（近い方から順に、まだ先の距離だけ言う）。
            if onPit and _ldp is not None and _ldp >= 0 and pit_box_pct is not None and track_length_m:
                _dpct = pit_box_pct - _ldp
                if _dpct > 0.5: _dpct -= 1.0
                elif _dpct < -0.5: _dpct += 1.0
                _dist_m = _dpct * track_length_m
                # ★2026-07-20 Codexレビュー P0-4：「現在距離 <= mark」だと、90m地点で初検出した時に
                #   150mを読み、10m地点からだと150/100/50/20を一気に読み上げてしまう。
                #   前回距離を持ち「previous > mark >= current」の**横断時だけ**鳴らす。
                #   最初の有効サンプルで既に通過済みのmarkは消化済みとして黙って捨てる。
                if 0 < _dist_m < 400:
                    if pit_prev_dist_m is None:
                        for _mark in (100, 50, 20):
                            if _dist_m <= _mark:
                                pit_marks_called.add(_mark)   # 既に通過＝読まない
                    elif _dist_m < pit_prev_dist_m and (pit_prev_dist_m - _dist_m) < 120:
                        # 近づいている時のみ（距離の逆行やラップ跨ぎの飛びでは鳴らさない）
                        for _mark in (100, 50, 20):
                            if pit_prev_dist_m > _mark >= _dist_m and _mark not in pit_marks_called:
                                pit_marks_called.add(_mark)
                                broadcast({'type': 'radio', 'trigger': 'pit_box_countdown',
                                    'meters': _mark, 'message': str(_mark) + ' metres.'})
                                break
                    pit_prev_dist_m = _dist_m
                else:
                    pit_prev_dist_m = None
            # ① ピットレーン内で"ボックス位置に到達"＝PlayerTrackSurface 2→1
            if (not onPit) and (pit_marks_called or pit_prev_dist_m is not None):
                pit_marks_called.clear(); pit_prev_dist_m = None   # コース復帰＝次の入庫に備え白紙化
            if onPit and _prev_psurf == 2 and _psurf == 1:
                if _ldp is not None and _ldp >= 0:
                    pit_box_pct = _ldp        # ★自分のボックス位置を学習（次回から秒読みできる）
                    log("PIT BOX learned at LapDistPct=%.4f (track=%.0fm)" % (_ldp, track_length_m or 0))
                pit_marks_called.clear()
                broadcast({'type': 'radio', 'trigger': 'pit_box_here', 'message': 'Box here.'})
            # ② ★決定シグナル＝サービス開始(完全停止)。PlayerCarPitSvStatus 0→非0
            # 完全停止後の追加コールは遅い。最後の案内は「Box here.」で終える。
            # 値が変わった時だけ診断ログ（1541行の垂れ流し反省）
            _key = "%s|%s|%s|%s" % (_psurf, _pss, _po, onPit)
            if _key != prev.get('_pit_key'):
                log("PIT DIAG -> PlayerTrackSurface=%s(1=box/2=approach/3=track) PlayerCarPitSvStatus=%s PitsOpen=%s OnPitRoad=%s LapDistPct=%s Speed=%s" % (
                    str(_psurf), str(_pss), str(_po), str(onPit),
                    str(round(_ldp, 4) if _ldp is not None else None),
                    str(round(_spd_now, 1) if _spd_now is not None else None)))
                prev['_pit_key'] = _key
            prev['_psurf'] = _psurf
            prev['_pss']   = _pss
        except Exception as _pe:
            log("PIT DIAG error: " + str(_pe))

        # ── マルチクラス・バトル検知 ────────────────────────────────────
        # CarIdxF2Time = iRacingダッシュボードと同じ相対タイム（EstTimeより正確）
        nearest_ahead_gap = None    # 毎ループ更新（前後の最近接ギャップ）
        nearest_behind_gap = None
        if player_car_idx >= 0 and onTrack and not onPit and not in_formation:
            car_f2_times   = reader.read_float_array('CarIdxF2Time', 64)
            car_last_laps  = reader.read_float_array('CarIdxLastLapTime', 64)
            car_on_track   = reader.read_int_array('CarIdxTrackSurface', 64)
            # CarIdxTrackSurface: -1=NotInWorld, 0=OffTrack, 1=InPitStall, 2=ApproachingPits, 3=OnTrack

            # ── 前後ギャップは CarIdxEstTime（コース上位置を時間で表す）で計算する ──
            # ⚠️旧実装はCarIdxF2Timeの差で計算してたが、F2Timeは「レースはリーダー差・練習/予選は
            #   自己ベストラップ」というiRacing仕様。練習だと"ベストラップの近い車との差"になり、
            #   実際のコース上車間と無関係な値(例0.02秒)が出るバグだった(2026/7/7 実走ログで判明)。
            #   EstTime差なら全セッション種別で"物理的にコース上で一番近い車"との時間差になる。
            car_est_times = reader.read_float_array('CarIdxEstTime', 64)
            if car_est_times and player_car_idx < len(car_est_times):
                p_et = car_est_times[player_car_idx]
                if p_et and p_et > 0:
                    for _ei, _et in enumerate(car_est_times):
                        if _ei == player_car_idx or not _et or _et <= 0:
                            continue
                        if car_on_track and car_on_track[_ei] not in (2, 3):  # コース上/ピット接近のみ
                            continue
                        # ★2026-07-12実走で発覚：CarIdxEstTimeは「今の周回内の経過時間」で周回ごとに
                        #   リセットされる値。周回数が違う(ラップダウン)車同士でも、たまたま周回内の
                        #   同じような位置にいると差が小さく出て「0.3秒差」等の誤検知になる
                        #   （実測：15.5秒離れた車が1秒後に0.0秒と誤警告）。同一周回の車同士でしか使わない。
                        if car_laps_all and lap is not None and _ei < len(car_laps_all) and car_laps_all[_ei] != lap:
                            continue
                        _gd = _et - p_et  # 負=前方(est_timeが小さい), 正=後方
                        if _gd < 0 and -_gd < 30 and (nearest_ahead_gap is None or -_gd < nearest_ahead_gap):
                            nearest_ahead_gap = -_gd
                        elif _gd > 0 and _gd < 30 and (nearest_behind_gap is None or _gd < nearest_behind_gap):
                            nearest_behind_gap = _gd

            # ── 停止/クラッシュ車両検知（コース上・オフトラックで動きが止まってる車）──
            # 1秒おきにLapDistPctの変化をサンプリングし、ほぼ動いてなければ「停止」とみなす。
            car_dist_pct = reader.read_float_array('CarIdxLapDistPct', 64)
            _snow = time.time()
            # CarIdxOnPitRoad: ピットレーン上の車を確実に除外（ホームストレート沿いのピットで
            # 停車中の車をコース上の停止車両と誤検知しないための保険。無ければNoneで無視される）
            car_on_pitroad = reader.read_int_array('CarIdxOnPitRoad', 64)
            if car_dist_pct and _snow - stopped_check_ts > 1.0:
                for _i, _dist in enumerate(car_dist_pct):
                    if _i == player_car_idx or _dist is None or _dist < 0:
                        continue
                    _surf = car_on_track[_i] if car_on_track and _i < len(car_on_track) else -1
                    _onpit = bool(car_on_pitroad[_i]) if car_on_pitroad and _i < len(car_on_pitroad) else False
                    if _surf not in (0, 3) or _onpit:  # ピット関連/未使用の車は対象外
                        car_pos_hist.pop(_i, None); car_stopped_since.pop(_i, None)
                        continue
                    _prev = car_pos_hist.get(_i)
                    if _prev is not None and abs(_dist - _prev[0]) < 0.0004:
                        if _i not in car_stopped_since:
                            car_stopped_since[_i] = _snow
                    else:
                        car_stopped_since.pop(_i, None)
                    car_pos_hist[_i] = (_dist, _snow)
                stopped_check_ts = _snow

            # ── 停止/クラッシュ車両の警告（前方のみ、2秒以上停止確定）──
            # Yuji方針：5秒圏内に入ったら1回だけ知らせる。IR側スポッターと同じ役割。
            # ⚠️2026-07-13実走で一度も発火しないバグが発覚：上のバトル検知ループは
            #   「同一周回の車同士でしか判定しない」フィルターが掛かっており（EstTimeが
            #   周回ごとにリセットされる値のため、異なる周回の車を比較すると誤検知するのが理由）、
            #   前方でスピン/クラッシュした車は高確率で周回数がズレるため、まさに検知したい瞬間に
            #   そのフィルターで弾かれて黙っていた。停止車検知はEstTimeでなくLapDistPct（周回内の
            #   位置%、周回数と無関係）の差で距離を測ることで、周回フィルターを使わずに済む形に分離した。
            # ⚠️後方(stopped_behind)は2026/7/5に廃止。元々はドライバーの心理的プレッシャーを
            # 和らげる目的だったが、武装/解除方式の検知漏れリスクがある機能を安全上クリティカル
            # でない用途に使うのはリスクに見合わない判断。前方(衝突リスクに直結)のみ残す。
            if car_stopped_since and car_dist_pct and player_car_idx < len(car_dist_pct):
                player_pct = car_dist_pct[player_car_idx]
                _car_last_laps_stopped = reader.read_float_array('CarIdxLastLapTime', 64)
                player_last_lap_stopped = (_car_last_laps_stopped[player_car_idx]
                                            if _car_last_laps_stopped and player_car_idx < len(_car_last_laps_stopped) else 0) or 0
                if player_pct is not None and player_pct >= 0 and player_last_lap_stopped > 0:
                    _now2 = time.time()
                    for idx in list(car_stopped_since.keys()):
                        if idx == player_car_idx or idx >= len(car_dist_pct):
                            continue
                        other_pct = car_dist_pct[idx]
                        if other_pct is None or other_pct < 0:
                            continue
                        _stopped_dur = _now2 - car_stopped_since.get(idx, _now2)
                        if _stopped_dur < 2.0:
                            continue
                        pct_diff = other_pct - player_pct  # 正=相手が前方（周回内の位置で判定、周回数は無視）
                        if pct_diff > 0.5: pct_diff -= 1.0
                        elif pct_diff < -0.5: pct_diff += 1.0
                        if pct_diff <= 0:  # 前方でなければ対象外
                            continue
                        _sdist = pct_diff * player_last_lap_stopped
                        if _sdist > 6.0:
                            stopped_armed[idx] = True
                        # ★2026-07-19 停止車警告が一度も鳴らない2つの穴を塞ぐ（Yuji: Monza/Interlagosで
                        #   GT3が数台止まってたのに無言＝クレーム）。
                        #   穴1: last_battle_global(15秒)の抑制。接近コールが15秒以内にあると黙る仕様だったが、
                        #        Monzaはマルチクラスが12秒毎に94回鳴っており窓が永久に開かなかった＝構造的に発火不能。
                        #        衝突リスク直結の警告を雑談のクールダウンで殺すのは本末転倒なので撤廃。
                        #   穴2: stopped_armed（6秒圏外で一度"武装"が必要）。目の前でスピンした車は遠距離の観測
                        #        履歴が無く永久に武装できない＝一番危ない瞬間に黙る。未警告の車は武装なしでも鳴らす。
                        elif _sdist <= 5.0 and (stopped_armed.get(idx, False) or idx not in stopped_warned):
                            _lastw = stopped_warned.get(idx, 0)
                            if _now2 - _lastw > 20:
                                broadcast({'type': 'radio', 'trigger': 'stopped_ahead',
                                    'delta': round(_sdist, 1),
                                    'message': 'Stopped car ahead, ' + _fmt_gap(_sdist) + '.'})
                                stopped_armed[idx] = False
                                stopped_warned[idx] = _now2
                                last_battle_global = _now2

            _same_class_main = set()  # ★R2：下のstandings_gapsブロックからも参照するため、分岐の外で既定値を持つ
            if car_f2_times and player_car_idx < len(car_f2_times):
                player_time     = car_f2_times[player_car_idx]
                player_last_lap = car_last_laps[player_car_idx] if car_last_laps else 0
                now = time.time()
                # ⚠️接近判定(バトル/危険/停止車)は EstTime(コース上位置)で車間を測る。
                #   F2Timeは練習/予選だと各車の自己ベスト差になり、実際の車間と無関係(8秒/15秒等の
                #   デタラメ警告の原因・2026/7/7 Yuji指摘)。EstTime差なら全セッションで正しい車間。
                player_est = car_est_times[player_car_idx] if (car_est_times and player_car_idx < len(car_est_times)) else None
                # クラス内順位（車の識別をゼッケンでなく「クラス名+順位」で言うため・Yuji方針2026-07-14）
                car_class_pos_arr = reader.read_int_array('CarIdxClassPosition', 64)

                # ★2026-07-21 Codex指示R2：同クラス集合はclass_map.evaluate_class_map経由でfail-closed。
                #   CarIdxClassPositionの値そのもの(順位番号)は使わず、「値がある＝アクティブな車」の
                #   判定だけに使う（クラスごとに1,2,3...と重複するため、順位番号から所属クラスは
                #   推測できない＝Codex指示）。旧実装のother_class==player_class_idは、両者が
                #   ClassID不明(-1)の時に誤って「同クラス」と判定する穴があった。
                _active_main = set(i for i, v in enumerate(car_class_pos_arr or []) if v and v > 0)
                _class_map_result = class_map.evaluate_class_map(_active_main, player_car_idx, car_class_map)
                _same_class_main = _class_map_result['same_class_car_idxs'] or set()

                for idx, f2_time in enumerate(car_f2_times):
                    if idx == player_car_idx or f2_time <= 0:
                        continue
                    # ★同一周回の車同士でしか接近判定しない（上のnearest_gapブロックと同じ理由・
                    #   2026-07-12実走で発覚したEstTimeの周回またぎ誤検知対策）。
                    if car_laps_all and lap is not None and idx < len(car_laps_all) and car_laps_all[idx] != lap:
                        continue
                    # ※前後ギャップ(nearest_ahead/behind_gap)は上のCarIdxEstTimeブロックで計算済み。
                    #   このループはバトル/接近/停止車検知に使う。車間はEstTime差で測る。
                    other_est = car_est_times[idx] if (car_est_times and idx < len(car_est_times)) else None
                    if not player_est or player_est <= 0 or not other_est or other_est <= 0:
                        continue  # コース上位置が不明な車は接近判定しない（誤警告防止）
                    _d = other_est - player_est  # 負=前方, 正=後方

                    # ピット/ガレージの車は完全除外（接近警告を出さない）
                    if car_on_track:
                        surf = car_on_track[idx]
                        if surf not in (2, 3):  # 2=ApproachingPits, 3=OnTrack のみ対象
                            continue

                    # コース上の車間（EstTime差）。プラス=相手が後方、マイナス=相手が前方。
                    delta = _d
                    est_time = f2_time  # 後続コードの互換性のため（未使用でも残す）

                    other_rel   = car_relspeed_map.get(idx, 0)

                    # ── マルチクラス(速いクラス)接近警告は、このループの外で別ロジックに移設 ──
                    #   （EstTime差はクロスクラスで狂うため、LapDistPct物理ギャップで測り直す。下記参照）

                    # ── 危険ドライバー警告（低iRating/低SR、前後どちらも）──────────
                    # Yuji方針：バトル警告と同じタイミング(0.55→0.3の急接近で1回だけ)に乗せる。
                    other_irating = car_irating_map.get(idx, 0)
                    other_sr = car_sr_map.get(idx)
                    # ★2026-07-19 Yuji方針：最低ラインを下げて"本当に危ない相手"だけに絞る
                    #   （旧 iR<1500 / SR<=2.5 は広すぎて鳴りすぎた）。SR2.0以下・iR1300以下。
                    is_risky = (0 < other_irating <= 1300) or (other_sr is not None and 1.0 <= other_sr <= 2.0)
                    # ★同時に「直前＆直後の1台だけ」に限定（同クラスでクラス順位が隣接）。
                    #   離れた順位の危険ドライバーまで拾うと結局うるさくなる＝Yuji方針「少ない方がいい」。
                    _dpos_pre = (car_class_pos_arr[idx] if (car_class_pos_arr and idx < len(car_class_pos_arr)) else None)
                    _adjacent = (idx in _same_class_main and _dpos_pre is not None
                                 and class_pos is not None and abs(_dpos_pre - class_pos) == 1)
                    if is_risky and _adjacent and not in_start_rush and idx not in danger_ever_warned:
                        # 危険ドライバーは早めの安全予告なので3秒圏内で1回（バトルの0.3秒より広い）
                        # ⚠️このドライバーへの警告はセッション中1回のみ(danger_ever_warned)。
                        # 再武装方式だとギャップが4秒→3秒を何度も往復するだけで同じ相手に何度も鳴ってしまい
                        # 鬱陶しい(Yuji実走指摘・2026/7/5)。同一車には二度と警告しない。
                        adist = abs(delta)
                        if adist > 4.0:
                            ahead_armed[idx] = True
                        elif adist <= 3.0 and ahead_armed.get(idx, False):
                            last_warn = danger_warned.get(idx, 0)
                            if now - last_warn > 20:
                                reason = 'SR ' + str(other_sr) if (other_sr is not None and other_sr <= 2.5) else 'iR ' + str(other_irating)
                                # ゼッケンが取れてれば認識度アップのため文言に含める(Yuji方針・2026/7/14)。
                                # 無ければ黙って省略(ゼッケン無し表記で捏造しない)。
                                num = car_number_map.get(idx)
                                car_tag = (' car #' + num) if num else ''
                                # ★2026-07-19 前後判定：同クラスはクラス順位で確定（EstTime符号反転の根絶）。
                                #   別クラスは物差し(LapDistPct)の符号がコード内で未確定なためEstTime差のまま暫定とし、
                                #   下の診断ログで実走の実値を残す→次ラウンドで別クラス方向も確定させる。
                                _dpos = (car_class_pos_arr[idx] if (car_class_pos_arr and idx < len(car_class_pos_arr)) else None)
                                _same_cls = (idx in _same_class_main)
                                if _same_cls and _dpos is not None and class_pos is not None:
                                    _behind = _dpos > class_pos          # 順位が下＝後方（真実・符号推測不要）
                                else:
                                    _behind = delta > 0                  # 別クラス：暫定（EstTime）
                                # 診断：番号/SR/iR紐付け＋前後の物差し食い違い（EstTime vs クラス順位）を残す
                                _est_dir = 'behind' if delta > 0 else 'ahead'
                                _pos_dir = ('behind' if _dpos > class_pos else 'ahead') if (_same_cls and _dpos is not None and class_pos is not None) else 'n/a'
                                log("DANGER fire idx=%s #%s SR=%s iR=%s clsP=%s myP=%s sameCls=%s EstTime=%s pos=%s -> %s (reason:%s)"
                                    % (idx, num, other_sr, other_irating, _dpos, class_pos, _same_cls, _est_dir, _pos_dir,
                                       'behind' if _behind else 'ahead', reason))
                                # ★2026-07-19 反射テンプレ→LLM判断へ卒業。旧文言は「気をつけろ」の命令調で
                                #   Yujiの「命令口調をやめる」方針に反していた（実走ログで4回発話）。
                                #   危険予告は数秒かけて接近する＝判断の"間"がある。セッション中1台1回のまま。
                                _judge_llm_gate('danger', judge_llm_call_times, time.time(), judge_llm_skip_log_last)  # 安全直結＝常にTrue。計測のためだけに通す
                                broadcast({'type': 'judge_call', 'kind': 'danger',
                                    'behind': bool(_behind), 'gap': round(abs(delta), 1),
                                    'reason': reason, 'car_number': num})
                                ahead_armed[idx] = False
                                danger_warned[idx] = now
                                danger_ever_warned.add(idx)
                                last_battle_global = now

                    # ── 同クラス：後ろが"急接近した瞬間"だけ1回警告（連呼しない）──────────
                    # 前方の車は離れても迫っても見えてるので黙る（Yuji方針）。
                    # 後ろは死角。一度クリア(>3.0=本当に引き離した)だった車が接近(<=0.3)した最初の1回だけ「後ろ注意」。
                    # ⚠️再武装の閾値は元々0.55秒だったが、同じバトルの中で車間が一瞬開閉するだけで
                    #   再発火して連呼になる問題が実走で判明(Yuji指摘・2026/7/14)。「本当に引き離した」と
                    #   言えるレベルまで閾値を上げて、ただの車間の揺らぎでは再武装しないようにした。
                    #   同じ相手が一度クリアな状態を経て再接近した場合(＝ミスで下がって終盤また来た等)は
                    #   "再接近"として言い方を変える(battle_ever_warned)。
                    if is_race_session and idx in _same_class_main and not in_start_rush and delta > 0:
                        if delta > 3.0:
                            behind_armed[idx] = True  # 本当に引き離した＝次の接近で警告できる状態に
                        elif delta <= 0.3 and behind_armed.get(idx, False):
                            if True:   # 抑制はディレクターが一元管理（旧last_battle_globalの自前ゲートは撤去）
                                other_last_lap = car_last_laps[idx] if car_last_laps else 0
                                pace_diff = (other_last_lap - player_last_lap
                                             if other_last_lap > 0 and player_last_lap > 0 else 0)
                                is_repeat = idx in battle_ever_warned
                                num = car_number_map.get(idx)
                                car_tag = (' car #' + num) if num else ''
                                again_tag = ' again' if is_repeat else ''
                                # ★2026-07-19 LLM判断層へ：後方急接近を"完成文"でなく"判断候補"として送る。
                                #   「後ろのバトルでも自分に迫った時だけ・文脈で言うか黙るか」をAIが決める(Yuji定義)。
                                #   前後はクラス順位で確認（EstTime符号事故の防止）。位置が前方＝誤検知なら送らない。
                                _bpos = car_class_pos_arr[idx] if (car_class_pos_arr and idx < len(car_class_pos_arr)) else None
                                _pos_says_ahead = (_bpos is not None and class_pos is not None and _bpos < class_pos)
                                if not _pos_says_ahead:
                                    # ★2026-07-23 Codex再指摘 P1：段階消費(behind_armed=False等)は
                                    #   ゲート通過時のみ行う。間引きで送れなかったcandidateを
                                    #   永久消失させない＝予算復活後に最新状態でリトライされる。
                                    if _judge_llm_gate('battle', judge_llm_call_times, time.time(), judge_llm_skip_log_last):
                                        # ★v3 Codex P1：DISPATCHED のみ段階消費。HELD/DROPPED は消費しない。
                                        #   HELD は将来 flush_radio() が送るが judge_call は
                                        #   GATEABLE_TRIGGERS に含まれないため実際は HELD にならない。
                                        _br = broadcast({'type': 'judge_call', 'kind': 'battle',
                                                'gap': round(delta, 1), 'faster': bool(pace_diff < -1.5),
                                                'pace': round(abs(pace_diff), 2), 'repeat': is_repeat,
                                                'car_number': num, 'class_pos': _bpos,
                                                'message': 'Behind' + car_tag + again_tag + '. ' + _fmt_gap(delta) + '.'})
                                        if _br == BROADCAST_DISPATCHED:
                                            behind_armed[idx] = False   # 1回判断に回したら再武装まで黙る
                                            battle_ever_warned.add(idx)
                                            last_battle_global = now

                    # ── 段階的キャッチアップ/ディフェンスコール（2026-07-14 Yuji設計→同日実走で再調整）──
                    # 単純な車間だけでなく「本当に追いつけそうか」をペース差(pace_diff)で判定してから、
                    # 10→7→3→1.5秒の閾値を跨いだ最初の瞬間だけ1回鳴らす。
                    # ⚠️実走(IMSA Fixed)で1レース59回発火の大惨事が判明・2点を修正:
                    #   ①別クラス車も対象にしてたため、既存のmulticlass_approaching/imminentと完全に重複
                    #     (GTPが専用の仕組みを差し置いてこっちで発火してた)。同クラス限定に変更。
                    #   ②再武装の閾値(10秒で仕切り直し)が敏感すぎて、パックレースで車間が9〜11秒を
                    #     うろつくたびに何度も再発火。15秒まで引き離すまで待つよう変更(battle_behindと同じ教訓)。
                    # あと「後方7.3秒でミラー確認」のような、実際の緊急度と釣り合わないアドバイスも指摘された。
                    # 遠い段階(10/7秒)は数字だけ、行動の指示(ミラー確認・仕掛けろ)は1.5秒以下でのみ言う。
                    # ⚠️③自分のクラス内順位から見て「隣の順位」の車だけを対象にする(Yuji方針・2026-07-14再調整)。
                    #   同じクラスで車間閾値内の車全部を追跡すると、パックレースで複数台が同時に
                    #   引っかかって「乱れ打ち」になる。隣の順位＝実質的に一番意味のあるライバルなので
                    #   これ1台に絞れば粒度も自然に落ち着く。識別もゼッケンでなく「クラス名+順位」に統一
                    #   (例:GT3 1位)——ゼッケンは覚えにくいが順位は文脈的にすぐ分かるとの指摘。
                    other_cls_pos = car_class_pos_arr[idx] if car_class_pos_arr and idx < len(car_class_pos_arr) else None
                    is_adjacent_rival = (other_cls_pos is not None and class_pos is not None
                                          and other_cls_pos in (class_pos - 1, class_pos + 1))
                    if is_race_session and idx in _same_class_main and not in_start_rush and is_adjacent_rival:
                        other_last_lap2 = car_last_laps[idx] if car_last_laps else 0
                        pace_diff2 = (other_last_lap2 - player_last_lap
                                      if other_last_lap2 > 0 and player_last_lap > 0 else None)
                        # 同クラス(GT3同士)の識別は号車=車番号で（Yuji方針2026-07-14夜：クラス名でなく「12号車」）。
                        # 番号が取れなければクラス+順位にフォールバック(捏造しない)。英語は "car #12"。
                        _num2 = car_number_map.get(idx)
                        car_tag2 = ('car #' + _num2 + ', ') if _num2 else (_class_id_txt_en(car_class_name_map.get(idx), other_cls_pos) + ', ')

                        # ★2026-07-19 前後の物差しをEstTimeから「クラス順位そのもの」へ根絶変更。
                        #   Yuji Monza実走で大松が前方#17を「behind」と取り違えた根本原因＝EstTime差(delta)は
                        #   同一ラップ内・S/Fライン跨ぎで符号が反転しうる(gap値がF2Timeへ・マルチクラスがLapDistPctへ
                        #   既に移ったのと同じ病巣)。同クラスの"隣の順位"なら前後の絶対的な真実はクラス順位：
                        #   位置が1つ上(class_pos-1)＝前方＝キャッチアップ、1つ下(class_pos+1)＝後方＝ディフェンス。
                        #   曖昧さゼロ。ギャップ値はレース中のF2Time差(=iRacingダッシュボードと同じ・7/15実走で検証済)。
                        _f2gap = (abs(f2_time - player_time)
                                  if (player_time is not None and player_time >= 0 and f2_time >= 0) else None)
                        gap = _f2gap if _f2gap is not None else abs(delta)  # F2Time優先・欠損時のみEstTimeフォールバック
                        _is_ahead_rival = (other_cls_pos == class_pos - 1)  # 順位が1つ上＝前方（真実・符号推測不要）
                        # 診断：前後判定がEstTime(旧)とクラス順位(新)で食い違った瞬間を残す＝根絶の効きを実走で確認
                        _old_dir = 'ahead' if delta < 0 else 'behind'
                        _new_dir = 'ahead' if _is_ahead_rival else 'behind'
                        # 間引き：同じ食い違い状態を毎サイクル吐かない（1車につき状態が変わった時だけ1回）
                        if _old_dir != _new_dir and dir_fix_seen.get(idx) != (_old_dir, _new_dir):
                            dir_fix_seen[idx] = (_old_dir, _new_dir)
                            log("DIR FIX: car#%s clsP%s vs myP%s -> EstTime said %s, position says %s (gap %.1f)"
                                % (_num2, other_cls_pos, class_pos, _old_dir, _new_dir, gap))

                        if _is_ahead_rival:  # 相手が前方（順位が1つ上）＝キャッチアップ対象
                            if gap > 15.0:
                                catchup_stage[idx] = 0
                            elif pace_diff2 is not None and pace_diff2 > 0.3:
                                prev_pace = gap_pace_hist.get(('ahead', idx))
                                gap_pace_hist[('ahead', idx)] = pace_diff2
                                confident = prev_pace is not None and prev_pace > 0.3
                                stage = _catchup_stage_of(gap)
                                if stage > catchup_stage.get(idx, 0):
                                    # ★2026-07-19 LLM判断層へ：完成文でなく"判断候補"を送る。AIが言うか黙るか決める。
                                    #   前後はクラス順位ベースの正しい値。messageはLLM失敗時のフォールバック用に残す。
                                    # ★2026-07-23 Codex再指摘 P1：段階消費(catchup_stage[idx]=stage)は
                                    #   ゲート通過時のみ。予算満杯で保留された段階は失われず、予算復活後の
                                    #   次フレームで最新のstageで送り直される（gapが7→3→1.5と進んだ場合、
                                    #   復活時は最新の1.5秒段階が最大1回送られる＝Codex受入条件の実現）。
                                    if _judge_llm_gate('catchup', judge_llm_call_times, time.time(), judge_llm_skip_log_last):
                                        # ★v3 Codex P1：DISPATCHED のみ段階消費。
                                        _br = broadcast({'type': 'judge_call', 'kind': 'catchup', 'stage': stage,
                                                'gap': round(gap, 1), 'car_number': _num2, 'class_name': _norm_class_name(car_class_name_map.get(idx)), 'class_pos': other_cls_pos, 'confident': confident,
                                                'message': 'Ahead, ' + car_tag2 + 'within ' + _fmt_gap(gap) + '.'})
                                        if _br == BROADCAST_DISPATCHED:
                                            catchup_stage[idx] = stage
                                            last_battle_global = now
                        else:  # 相手が後方（順位が1つ下）＝ディフェンス対象
                            if gap > 15.0:
                                defend_stage[idx] = 0
                            elif pace_diff2 is not None and pace_diff2 < -0.3:
                                prev_pace = gap_pace_hist.get(('behind', idx))
                                gap_pace_hist[('behind', idx)] = pace_diff2
                                confident = prev_pace is not None and prev_pace < -0.3
                                stage = _catchup_stage_of(gap)
                                if stage > defend_stage.get(idx, 0):
                                    # ★2026-07-19 LLM判断層へ（上のcatchupと同じ）
                                    # ★2026-07-23 Codex再指摘 P1：段階消費はゲート通過時のみ（catchupと同じ理由）。
                                    if _judge_llm_gate('defend', judge_llm_call_times, time.time(), judge_llm_skip_log_last):
                                        # ★v3 Codex P1：DISPATCHED のみ段階消費。
                                        _br = broadcast({'type': 'judge_call', 'kind': 'defend', 'stage': stage,
                                                'gap': round(gap, 1), 'car_number': _num2, 'class_name': _norm_class_name(car_class_name_map.get(idx)), 'class_pos': other_cls_pos, 'confident': confident,
                                                'message': 'Behind, ' + car_tag2 + 'within ' + _fmt_gap(gap) + '.'})
                                        if _br == BROADCAST_DISPATCHED:
                                            defend_stage[idx] = stage
                                            last_battle_global = now

                # ══ マルチクラス(速いクラス)接近警告 ══
                # ⚠️2026-07-14：EstTimeはクラス毎の想定ラップで秒換算する値でクロスクラスでは狂うため、
                #   クラス非依存の LapDistPct(0-1のコース内位置)差 × 自分のラップタイムで物理車間を測る。
                # ⚠️2026-07-20：符号が逆で「抜かれた車を後方と報告し、迫る車を無視」していた（根治済み）。
                # ★★2026-07-20 ドライバー要求により「1台ずつ叫ぶ」→「クラス単位でまとめる」へ★★
                #   実走で82回発話し、Yuji「その言葉が全部一緒のことを言うから分からない」
                #   「2台続いてる、3台続いてるって言ってくれた方が。回数は君が答えなくていい」
                #   「クラス名を言ってくれた方がいい。GTPとP217では近づいてくる速さが違う」←最高評価
                #   よって：最も近い1台を代表に、同クラスで近接している台数を添えて【1クラス1コール】。
                #   秒数も言う（符号が直り物理ギャップが正しくなったため。以前は不正確なので伏せていた）。
                if car_dist_pct and player_car_idx < len(car_dist_pct) and player_last_lap and player_last_lap > 0:
                    _ppct = car_dist_pct[player_car_idx]
                    _cls_pos_mc = reader.read_int_array('CarIdxClassPosition', 64)
                    # ★2026-07-21 Codex指示R2：自車のClassIDが不明ならマルチクラス判定そのものを
                    #   行わない（"速いクラス"かどうかは自車のクラスが分かって初めて言える）。
                    if _ppct is not None and _ppct >= 0 and player_class_id != -1:
                        _mc_groups = {}     # クラス名 -> {'gap':最近接の秒, 'count':近接台数, 'pos':代表の順位}
                        for _mi in range(len(car_dist_pct)):
                            if _mi == player_car_idx:
                                continue
                            _mcls = car_class_map.get(_mi, -1)
                            _mrel = car_relspeed_map.get(_mi, 0)
                            if _mcls == -1 or _mcls == player_class_id or _mrel <= player_rel_speed:
                                continue  # 速いクラス(別クラス かつ 相対速度が上)のみ
                            # ★2026-07-20 Codexレビュー P1-7：iRacingの 2=approaching pits, 3=on track。
                            #   旧実装は2も許容しており、ピットへ向かう車を「後方から迫る速いクラス」と
                            #   数える可能性があった。安全コールは on-track の車だけを対象にする。
                            if not (car_on_track and _mi < len(car_on_track) and car_on_track[_mi] == 3):
                                continue
                            _opct = car_dist_pct[_mi]
                            if _opct is None or _opct < 0:
                                continue
                            _pd = _opct - _ppct
                            if _pd > 0.5: _pd -= 1.0
                            elif _pd < -0.5: _pd += 1.0
                            _mcgap = -_pd * player_last_lap   # 正=後方(迫っている) / 負=前方(抜かれ済み)
                            # ★観測窓は広く(隊列の形を見るため)、発話の引き金は近い車だけ(5秒/2秒)。
                            if _mcgap <= 0 or _mcgap > MC_OBSERVE_SEC:
                                continue                       # 前方 or 観測範囲外
                            _cn = _norm_class_name(car_class_name_map.get(_mi)) or 'faster class'
                            _mc_groups.setdefault(_cn, []).append(_mcgap)

                        _seen_classes = set()
                        for _cn, _gaps in _mc_groups.items():
                            _gaps.sort()
                            _near = _gaps[0]
                            if _near > 5.0:
                                continue                        # まだ引き金の距離に入っていない
                            _seen_classes.add(_cn)
                            _stg = 2 if _near <= 2.0 else 1     # 2秒後方=今譲る / 5秒後方=備える
                            if _stg > multiclass_stage.get(_cn, 0):
                                multiclass_stage[_cn] = _stg
                                _shape, _clusters = _describe_traffic(_gaps)
                                log("MC fire class=%s nearest=%.1fs gaps=%s shape=%s clusters=%s stage=%d"
                                    % (_cn, _near, [round(g,1) for g in _gaps], _shape, _clusters, _stg))
                                broadcast({'type': 'radio', 'trigger': 'multiclass',
                                    'stage': _stg, 'class_name': _cn,
                                    'delta': round(_near, 1), 'count': len(_gaps),
                                    'shape': _shape, 'clusters': _clusters,
                                    'message': _mc_message_en(_cn, _near, _gaps, _shape, _clusters, _stg)})
                        # ★2026-07-20 Codexレビュー P1-6：発火(5秒)と再武装が同じ境界に依存しており、
                        #   4.9↔5.1秒を揺れるだけで再発火できた。再武装は8秒超に離れた時だけにする。
                        for _cn in list(multiclass_stage.keys()):
                            _g2 = _mc_groups.get(_cn)
                            if _g2 is None or min(_g2) > MC_REARM_SEC:
                                multiclass_stage.pop(_cn, None)     # 十分離れた/消えた＝再武装

        # ── クラス内・任意順位とのギャップ（項目：まーぼー要望「3rd/5thとのギャップ」2026-07-14）──
        # 今までは「直前直後の車」としか比較できず、離れた順位を聞かれると答えられなかった。
        # CarIdxF2Timeはレースセッション中は「リーダーからの遅れ」を表す値(iRacingダッシュボードと同じ)で、
        # 周回数が違う車同士でも(EstTimeと違って)そのまま引き算して正しいギャップになる。
        # なのでレース中のみ、クラス内の全順位について{順位: 自分とのギャップ秒}を作って毎回同送する。
        standings_gaps = None
        if is_race_session and player_car_idx >= 0:
            _cls_pos_arr = reader.read_int_array('CarIdxClassPosition', 64)
            _f2_arr = reader.read_float_array('CarIdxF2Time', 64)
            if _cls_pos_arr and _f2_arr and player_car_idx < len(_f2_arr):
                _player_f2 = _f2_arr[player_car_idx]
                if _player_f2 is not None and _player_f2 >= 0:
                    standings_gaps = {}
                    for _si, _spos in enumerate(_cls_pos_arr):
                        # ★2026-07-21 Codex指示R2：同クラス判定はfail-closedな_same_class_mainを使う。
                        if not _spos or _spos <= 0 or _si not in _same_class_main:
                            continue
                        if _si >= len(_f2_arr) or _f2_arr[_si] is None or _f2_arr[_si] < 0:
                            continue
                        standings_gaps[str(_spos)] = round(_f2_arr[_si] - _player_f2, 1)

                    # ── レース中の前後ギャップは F2Time（iRacingダッシュボードと同じリーダー相対）で
                    #    「隣の順位」から取り直す。EstTimeの同一周回フィルターだと接近戦でS/Fライン跨ぎに
                    #    真後ろの車が別周回扱いで弾かれ gap_behind=None が頻発し、値もドライバーのオーバーレイと
                    #    食い違っていた（Yuji 2026-07-15 Monza実走で「0.4じゃなく1.1-1.2だろ」と指摘）。
                    #    レース中はこれで上書き。練習/予選はF2Timeが自己ベスト差になるのでEstTimeのまま。
                    if class_pos and class_pos > 0:
                        _adj_ahead = standings_gaps.get(str(class_pos - 1))
                        _adj_behind = standings_gaps.get(str(class_pos + 1))
                        if _adj_ahead is not None:
                            nearest_ahead_gap = abs(_adj_ahead)
                        if _adj_behind is not None:
                            nearest_behind_gap = abs(_adj_behind)

        # ── ライブテレメトリ・スナップショット（数秒おき・エンジニアが実値で答えるため）──
        # これが無いと「順位は？」「燃料残量は？」に推測（捏造）で答えてしまう。実値を脳へ渡す。
        # ※onTrack限定にしない：ピット/ガレージでの直後デブリーフでもデータが古くなり
        #   すぎないよう、走行中でなくても(session接続中は)更新し続ける。
        _tnow = time.time()
        if player_car_idx >= 0 and _tnow - last_telem_ts > 3:
            broadcast({
                'type': 'telemetry_live',
                'class_pos': class_pos,
                'pos': pos,
                'fuel': round(fuel, 1) if fuel is not None else None,
                'best': round(personal_best, 3) if personal_best else None,
                'last': round(lapTime, 3) if (lapTime and lapTime > 0) else None,
                'lap': lap,
                'laps_total': lapsTot if (lapsTot and lapsTot > 0) else None,
                'gap_ahead': round(nearest_ahead_gap, 2) if nearest_ahead_gap is not None else None,
                'gap_behind': round(nearest_behind_gap, 2) if nearest_behind_gap is not None else None,
                'on_track': onTrack,
                'fuel_strategy': fuel_strategy,
                'tires': tires,
                'damage_s': damage_s,
                'weather': weather,
                'standings_gaps': standings_gaps,
            })
            last_telem_ts = _tnow

        prev.update({'pos': pos, 'class_pos': class_pos, 'fuel': fuel, 'lap': lap,
                     'lapsTot': lapsTot, 'onPit': onPit})
        time.sleep(0.1)  # 0.1秒ポーリング = コントロールライン通過を0.1秒以内に検知


# 保存済みのボタン割当を「今接続されているジョイスティック」から解決する。
#   index（接続順）だけで照合すると、機材を増やしたりUSB挿し直しで順番が変わった時に
#   別デバイスのボタンを静かに監視し続けてしまい、押しても何も起きない“無言の故障”になる
#   （2026-07-11の耐久レースで実際に発生：4時間PTTが一度も発火せず気づかれなかった）。
#   デバイス名が保存されていれば名前で優先照合し、順番が変わっても壊れないようにする。
#   旧形式（nameフィールドが無い設定ファイル）は今まで通りindexを信頼（後方互換）。
def _resolve_bound_joy(binding, sticks):
    if not binding:
        return None
    bname = binding.get("name")
    if bname:
        for idx, js in sticks.items():
            if js.get_name() == bname:
                return idx
        return None
    bjoy = binding.get("joy")
    return bjoy if bjoy in sticks else None


# ── ジョイスティック/ハンドル監視（PTT用・フルスクリーン裏でも動く）──
# pygameでボタンを直接読む。フォーカス不要＝iRacingがフルスクリーンでも検出できる。
def poll_joystick():
    global ptt_capturing, ptt_pressed, ptt_binding, vol_capturing, ptt_mismatch_warned
    try:
        os.environ.setdefault("SDL_VIDEODRIVER", "dummy")  # 画面不要
        # フォーカスが無く（iRacingがフルスクリーン前面）てもジョイスティック入力を受け取る
        os.environ["SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS"] = "1"
        import pygame
        pygame.init()
        pygame.joystick.init()
    except Exception as e:
        log("PTT joystick disabled (pygame unavailable): " + str(e))
        return

    sticks = {}
    last_scan = 0
    log("PTT joystick monitor started")

    # ジョイスティック一覧をゼロから作り直す。
    # ★2026-07-19 まーぼー12h走行で発覚した根本対策：MOZA等のベースが長時間走行中に一瞬USB再列挙
    #   すると、pygameの古いJoystickハンドルは「全ボタン0を返すだけの死体」になる（エラーも出ない）。
    #   従来のスキャンは追加しかしないため死んだハンドルが残り続け、PTTも再設定モードも永久に無反応だった。
    #   quit()→init()でSDLのデバイス列挙ごと刷新し、ハンドルを全部作り直すのが唯一確実な蘇生手段。
    def _rebuild_sticks(reason):
        out = {}
        try:
            pygame.joystick.quit()
            pygame.joystick.init()
            for i in range(pygame.joystick.get_count()):
                try:
                    js = pygame.joystick.Joystick(i)
                    js.init()
                    out[i] = js
                    log("PTT: joystick %d connected: %s (%d buttons) [%s]" % (i, js.get_name(), js.get_numbuttons(), reason))
                except Exception:
                    pass
        except Exception as e:
            log("PTT: joystick rebuild failed (%s): %s" % (reason, e))
        # ★2026-07-19 まーぼー実機で発覚した無限ループの根絶：quit()→init() 自体が
        #   JOYDEVICEADDED を再生成する。それを次ループのgetが拾ってまた作り直し…と自己増殖し、
        #   ハンドルが毎フレーム破壊再生成されてPTTが誤動作(押しっぱなし・再登録不可)になっていた。
        #   自分が生んだデバイスイベントをここで破棄して連鎖を断つ。
        try:
            pygame.event.pump()
            pygame.event.clear([pygame.JOYDEVICEADDED, pygame.JOYDEVICEREMOVED])
        except Exception:
            pass
        return out

    REBUILD_DEBOUNCE = 3.0   # 再構築は最短3秒に1回まで（自己増殖ループの二重安全網）
    # 起動時に一度スキャン（接続済みデバイスを即バインド。イベント待ちにしない）
    sticks = _rebuild_sticks("startup")
    last_rebuild = time.time()
    while True:
        try:
            try:
                pygame.event.pump()
            except Exception:
                pass
            now = time.time()
            # デバイスの抜き差しイベントを検知したら一覧を全再構築（本命の蘇生経路）。
            # ★デバウンス必須：quit/initの自己生成イベント＋MOZA等が周期的に出すイベントで
            #   毎フレーム再構築される事故を防ぐ（get自体はイベントを消費するので溜まらない）。
            try:
                dev_events = pygame.event.get([pygame.JOYDEVICEADDED, pygame.JOYDEVICEREMOVED])
                if dev_events and now - last_rebuild > REBUILD_DEBOUNCE:
                    sticks = _rebuild_sticks("device change")
                    last_rebuild = time.time()
            except Exception:
                pass
            # 接続スキャン（2秒ごと）：本数の食い違い or 死んだハンドルを検知したら全再構築。
            # デバイスイベントを取り逃した場合の保険（イベント＋ポーリングの二重防御）。同じくデバウンス。
            if now - last_scan > 2:
                last_scan = now
                try:
                    cnt = pygame.joystick.get_count()
                except Exception:
                    cnt = 0
                dead = False
                for i, js in list(sticks.items()):
                    try:
                        js.get_numbuttons()   # 死んだハンドルはここで例外を吐く（吐かずに0を返す型はイベント側が拾う）
                    except Exception:
                        dead = True
                        break
                if (dead or cnt != len(sticks)) and now - last_rebuild > REBUILD_DEBOUNCE:
                    sticks = _rebuild_sticks("health check")
                    last_rebuild = time.time()

            # 各ジョイスティックのボタン読み取り
            for i, js in list(sticks.items()):
                try:
                    nb = js.get_numbuttons()
                except Exception:
                    continue
                for b in range(nb):
                    try:
                        pressed = js.get_button(b) == 1
                    except Exception:
                        continue
                    if not pressed:
                        continue
                    # 設定モード：押された最初のボタンを登録
                    if ptt_capturing:
                        ptt_binding = {"joy": i, "button": b, "name": js.get_name()}
                        save_ptt_config()
                        ptt_capturing = False
                        ptt_mismatch_warned = False
                        broadcast({'type': 'ptt_set', 'joy': i, 'button': b})
                        log("PTT bound: joystick %d button %d (%s)" % (i, b, js.get_name()))
                    # 音量ボタン設定モード（up/down）：押されたボタンをその方向に登録
                    elif vol_capturing in ("up", "down"):
                        vol_binding[vol_capturing] = {"joy": i, "button": b, "name": js.get_name()}
                        save_vol_config()
                        broadcast({'type': 'vol_set', 'dir': vol_capturing, 'joy': i, 'button': b})
                        log("VOL bound: %s -> joystick %d button %d (%s)" % (vol_capturing, i, b, js.get_name()))
                        vol_capturing = None

            # 登録済みボタンの押下/離しを監視 → PTTイベント送信（デバイス名優先で解決）
            resolved_joy = _resolve_bound_joy(ptt_binding, sticks)
            if ptt_binding:
                if resolved_joy is not None:
                    ptt_mismatch_warned = False
                elif ptt_binding.get("name") and not ptt_mismatch_warned:
                    # 登録した名前のデバイスが見つからない＝押しても永久に無反応になる状態。
                    # ここで黙らず必ず知らせる（無言の故障が一番怖い）。
                    broadcast({'type': 'ptt_mismatch', 'expected_name': ptt_binding.get("name")})
                    log("PTT: bound device not found (" + ptt_binding.get("name") + ") — rebind needed")
                    ptt_mismatch_warned = True
            if resolved_joy is not None:
                js = sticks[resolved_joy]
                try:
                    cur = js.get_button(ptt_binding["button"]) == 1
                except Exception:
                    cur = False
                if cur and not ptt_pressed:
                    ptt_pressed = True
                    # ★v3 Codex P0-1：PTT を activity 判定から完全削除。
                    #   非搭乗中も本人が観戦しつつ PTT で会話するのは正常操作のため、
                    #   PTT 押下を再搭乗信号にすると誤活性する。activity 変更は行わない。
                    # ★2026-07-27：renderer往復を待たず、この入力エッジで録音開始。
                    #   短い第一声がストリームopen前に欠けて STT empty になる窓を最小化する。
                    start_ptt_record()
                    broadcast({'type': 'ptt', 'state': 'down'})
                elif not cur and ptt_pressed:
                    ptt_pressed = False
                    # 離したエッジでも即停止。rendererから戻る重複CMDは関数側で無害化する。
                    stop_ptt_record()
                    broadcast({'type': 'ptt', 'state': 'up'})

            # 音量ボタン監視：押した瞬間（立ち上がりエッジ）に1段変更を送る。
            # ダイヤル（ロータリー）は1クリック=1パルスなので、回すたびに1段動く。
            for d in ("up", "down"):
                bind = vol_binding.get(d)
                rj = _resolve_bound_joy(bind, sticks)
                if rj is not None:
                    js = sticks[rj]
                    try:
                        cur = js.get_button(bind["button"]) == 1
                    except Exception:
                        cur = False
                    if cur and not vol_pressed[d]:
                        vol_pressed[d] = True
                        broadcast({'type': 'volume', 'dir': d})
                    elif not cur and vol_pressed[d]:
                        vol_pressed[d] = False

            time.sleep(0.03)  # 約33Hzで監視（押下を即検知）
        except Exception:
            time.sleep(0.2)


async def handler(websocket):
    global ptt_capturing, ptt_lang, vol_capturing, selected_mic_index, ptt_test_active, usage_session_id
    connected_clients.add(websocket)
    log("Browser connected (" + str(len(connected_clients)) + " client)")
    try:
        await websocket.send(json.dumps({'type': 'connected'}))
        # Browser late join時の副作用なし状態同期。Activeならrendererを即座に緑へ、
        # memory open/status 0なら「Telemetry待ち」へする。iracing_connectedを再送すると
        # usage session再発行・briefing再実行を起こすため、専用snapshotを使う。
        await websocket.send(json.dumps({'type': 'iracing_status',
                                         'detected': bool(_iracing_mem_detected),
                                         'telemetry_active': bool(_iracing_telemetry_active)}))
        # 現在のPTT設定・音量ボタン設定を通知
        await websocket.send(json.dumps({'type': 'ptt_config', 'binding': ptt_binding}))
        await websocket.send(json.dumps({'type': 'vol_config', 'binding': vol_binding}))
        # renderer再接続時も、その瞬間の走行安全窓を必ず同期する。
        await websocket.send(json.dumps({'type': 'speak_gate',
                                         'window_ok': bool(_gate_window_ok),
                                         'active': bool(_gate_active)}))
        # マイク一覧＋現在の選択を通知（UIのマイク選択UI初期化用）
        await websocket.send(json.dumps({'type': 'mic_list', 'devices': list_input_devices(), 'selected': selected_mic_index}))
        # クライアントからのコマンド受信（PTT設定など）
        async for raw in websocket:
            try:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                cmd = msg.get('cmd')

                # log_line = rendererからの会話ログ転送。デバッグログに会話(AI返答含む)を残す。
                # スクショ無しで後から会話を追えるように(Yuji時短)。CMDノイズは出さない。
                if cmd == 'spoke':
                    # rendererが実際に再生を開始した通知。ここで予算を消費する（Codex指摘の修正）。
                    # ⚠️2026-07-20 このスコープの受信メッセージは msg。data と書いて NameError を投げ、
                    #   発話のたびに websocket ハンドラごと落ちて接続が切れていた（実走で発覚）。
                    director_commit(int(msg.get('prio', 4)), str(msg.get('kind', 'radio')))
                    continue
                if cmd == 'quiet_mode':
                    # ★2026-07-20 ドライバーの「あんまり喋らなくていい」を構造で受ける。
                    #   P3〜P5(戦略/情報/雑談)の予算を絞るだけで、P0/P1(安全)には一切効かない。
                    #   実走でモデルが「言わなくていいと言われたから速いクラスを報告しなかった」と述べた
                    #   事故の再発防止＝"静かに"の意味をプロンプトでなく仕組みで限定する。
                    set_quiet_mode(int(msg.get('seconds', 600)))
                    continue
                if cmd == 'log_line':
                    log("CONVO " + str(msg.get('text', '')))
                    continue
                if cmd == 'usage_session':
                    # コスト計測用session_id。64文字以内・認証やログ機微情報には使わない。
                    sid = msg.get('session_id')
                    if isinstance(sid, str) and 0 < len(sid) <= 64:
                        usage_session_id = sid
                        log("USAGE_SESSION " + sid)
                    continue
                log("CMD received: " + str(cmd))
                if cmd == "ptt_start":
                    lang = msg.get('lang')
                    if lang:
                        ptt_lang = lang
                        log("PTT STT language -> " + str(lang))
                    # ★v3 Codex P0-1：PTT は activity 変更源にしない（観戦者会話でも押されるため）
                    start_ptt_record()
                elif cmd == "ptt_abort":
                    abort_ptt_record()
                elif cmd == "resume_driving_support":
                    # ★v3 Codex P0-1：明示的な運転支援再開 CMD。renderer UI から手動発火する。
                    #   通常 PTT と兼用不可・独立操作。HANDOFF/INACTIVE から ACTIVE 復帰の唯一の
                    #   確定シグナル。将来 UI ボタン追加まで renderer から直接送信可能。
                    _mark_manual_resume_signal()
                    log("MANUAL RESUME: driving support resume requested by user")
                elif cmd == "ptt_stop":
                    stop_ptt_record()
                elif cmd == 'ptt_setup':
                    ptt_capturing = True
                    log("PTT setup mode: waiting for button press")
                elif cmd == 'ptt_cancel':
                    ptt_capturing = False
                elif cmd == 'vol_setup':
                    which = msg.get('dir')
                    if which in ('up', 'down'):
                        vol_capturing = which
                        log("VOL setup mode (%s): waiting for button press" % which)
                elif cmd == 'vol_cancel':
                    vol_capturing = None
                elif cmd == 'mic_list':
                    # マイク一覧を再列挙して返す（USB抜き差し後の更新用）
                    await websocket.send(json.dumps({'type': 'mic_list',
                        'devices': list_input_devices(), 'selected': selected_mic_index}))
                elif cmd == 'mic_select':
                    idx = msg.get('index')
                    selected_mic_index = idx if isinstance(idx, int) and idx >= 0 else None
                    save_mic_config()
                    log("mic selected -> " + str(selected_mic_index))
                    await websocket.send(json.dumps({'type': 'mic_config', 'selected': selected_mic_index}))
                elif cmd == 'mic_test_start':
                    ptt_test_active = True
                    log("mic test start")
                elif cmd == 'mic_test_stop':
                    ptt_test_active = False
                    log("mic test stop")
            except Exception as _cmd_err:
                # ★2026-07-20 1コマンドの失敗で websocket ハンドラごと落とさない。
                #   実走で cmd="spoke" 内の NameError がハンドラを殺し、Lunaが喋るたびに接続が切れ、
                #   ドライバーの問いかけに一切応答できない状態になった（予選が丸ごと無駄になった）。
                log("CMD handler error (connection kept alive): %s -> %s" % (msg.get("cmd"), _cmd_err))
                continue
    finally:
        connected_clients.discard(websocket)

async def main():
    global loop
    loop = asyncio.get_running_loop()
    # ⚠️以前は"w"(上書き)で起動毎にログを消していた→アプリ再起動(バグ対処等)すると
    # 直前セッションの記録が消え、後から原因診断できなくなる問題があった(2026/7/5判明)。
    # 追記＋セッション区切りマークに変更し、複数起動をまたいで履歴を残す。
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("\n=== OMORAY PITWALL Bridge session start (BUILD " + BUILD_VERSION + ") ===\n")
    except Exception:
        pass
    load_ptt_config()
    load_vol_config()
    load_mic_config()
    t = threading.Thread(target=poll_iracing, daemon=True)
    t.start()
    tj = threading.Thread(target=poll_joystick, daemon=True)
    tj.start()
    # マイクキャプチャスレッド起動（pyaudio）
    init_mic()
    tm = threading.Thread(target=record_ptt_audio, daemon=True)
    tm.start()
    print("OMORAY PITWALL Bridge  BUILD " + BUILD_VERSION + "  started")
    print("WebSocket: ws://localhost:" + str(PORT))
    log("Waiting for iRacing...")
    async with websockets.serve(handler, "localhost", PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
